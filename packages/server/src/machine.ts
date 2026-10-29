import { Context, Effect, Layer, Runtime, Schedule } from "effect"
import { execFile } from "node:child_process"
import { readFile, statfs } from "node:fs/promises"
import { cpus, freemem, totalmem } from "node:os"
import { InternalError, MACHINE_STATS_WINDOW_MS, type MachineSample, type MachineStats } from "@cloudagents/protocol"
import { Config } from "./config"

const INTERVAL_MS = 1_000
/** The sampler stops this long after the last request; nobody is watching. */
const IDLE_MS = 15_000
const NVIDIA_SMI_TIMEOUT_MS = 2_000

export interface MachineStatsShape {
  /** The recent samples; starts the sampler when it is not running. */
  readonly snapshot: Effect.Effect<MachineStats>
}

export class MachineStatsService extends Context.Tag("cloudagents/MachineStats")<MachineStatsService, MachineStatsShape>() {}

interface CpuTimes {
  readonly busy: number
  readonly total: number
}

const cpuTimes = (): CpuTimes => {
  let busy = 0
  let total = 0
  for (const { times } of cpus()) {
    const all = times.user + times.nice + times.sys + times.irq + times.idle
    total += all
    busy += all - times.idle
  }
  return { busy, total }
}

/** Used RAM: on Linux MemTotal - MemAvailable (page cache counts as free), elsewhere what the OS reports free. */
const ram = (): Effect.Effect<{ used: number; total: number }, InternalError> =>
  process.platform !== "linux"
    ? Effect.sync(() => ({ used: totalmem() - freemem(), total: totalmem() }))
    : Effect.tryPromise({
        try: () => readFile("/proc/meminfo", "utf8"),
        catch: (e) => new InternalError({ message: `/proc/meminfo: ${String(e)}` }),
      }).pipe(
        Effect.flatMap((text) => {
          const kib = (key: string) => Number(new RegExp(`^${key}:\\s+(\\d+)`, "m").exec(text)?.[1]) * 1024
          const total = kib("MemTotal")
          const available = kib("MemAvailable")
          return Number.isFinite(total) && Number.isFinite(available)
            ? Effect.succeed({ used: total - available, total })
            : Effect.fail(new InternalError({ message: "/proc/meminfo has no MemTotal/MemAvailable" }))
        }),
      )

type Vram = { used: number; total: number } | null | "missing"

/** Summed over every NVIDIA GPU; null when the query fails, "missing" when there is no nvidia-smi. */
const vram = (): Effect.Effect<Vram> =>
  Effect.async<Vram>((resume) => {
    execFile(
      "nvidia-smi",
      ["--query-gpu=memory.used,memory.total", "--format=csv,noheader,nounits"],
      { timeout: NVIDIA_SMI_TIMEOUT_MS },
      (err, stdout) => {
        if (err) return resume(Effect.succeed((err as NodeJS.ErrnoException).code === "ENOENT" ? "missing" : null))
        let used = 0
        let total = 0
        for (const line of stdout.trim().split("\n")) {
          const [u, t] = line.split(",").map((v) => Number(v.trim()) * 1024 * 1024)
          if (!Number.isFinite(u) || !Number.isFinite(t)) return resume(Effect.succeed(null))
          used += u!
          total += t!
        }
        resume(Effect.succeed(total > 0 ? { used, total } : null))
      },
    )
  })

const disk = (path: string): Effect.Effect<{ used: number; total: number }, InternalError> =>
  Effect.tryPromise({
    try: () => statfs(path),
    catch: (e) => new InternalError({ message: `statfs ${path}: ${String(e)}` }),
  }).pipe(Effect.map((s) => ({ used: (s.blocks - s.bfree) * s.bsize, total: s.blocks * s.bsize })))

export const MachineStatsLive = Layer.effect(
  MachineStatsService,
  Effect.gen(function* () {
    const config = yield* Config
    // The sampler outlives the request that starts it, so it runs on the box's runtime, not the HTTP handler's.
    const runFork = Runtime.runFork(yield* Effect.runtime<never>())
    let samples: MachineSample[] = []
    let lastAsked = 0
    let sampling = false
    let gpu = true
    let prevCpu = cpuTimes()

    const sample = Effect.gen(function* () {
      const [memory, video, storage] = yield* Effect.all([ram(), gpu ? vram() : Effect.succeed(null), disk(config.dataDir)], {
        concurrency: "unbounded",
      })
      if (video === "missing") gpu = false
      const cpu = cpuTimes()
      const elapsed = cpu.total - prevCpu.total
      const busy = elapsed > 0 ? (cpu.busy - prevCpu.busy) / elapsed : 0
      prevCpu = cpu
      const at = Date.now()
      const gpuMemory = video === "missing" ? null : video
      samples.push({
        at,
        cpu: Math.min(1, Math.max(0, busy)),
        ramUsed: memory.used,
        ramTotal: memory.total,
        vramUsed: gpuMemory?.used ?? null,
        vramTotal: gpuMemory?.total ?? null,
        diskUsed: storage.used,
        diskTotal: storage.total,
      })
      const oldest = at - MACHINE_STATS_WINDOW_MS
      const keep = samples.findIndex((s) => s.at >= oldest)
      if (keep > 0) samples = samples.slice(keep)
    }).pipe(Effect.catchAll((e) => Effect.logWarning(`machine stats sample failed: ${e.message}`)))

    // Samples every INTERVAL_MS until nobody has asked for IDLE_MS; the next request starts it again.
    const run = Effect.gen(function* () {
      prevCpu = cpuTimes()
      yield* Effect.sleep(INTERVAL_MS)
      yield* sample.pipe(
        Effect.repeat(
          Schedule.spaced(INTERVAL_MS).pipe(Schedule.whileOutput(() => Date.now() - lastAsked < IDLE_MS)),
        ),
      )
    }).pipe(
      Effect.ensuring(
        Effect.sync(() => {
          samples = []
          sampling = false
        }),
      ),
    )

    return {
      snapshot: Effect.sync(() => {
        lastAsked = Date.now()
        if (!sampling) {
          sampling = true
          runFork(run)
        }
        return { intervalMs: INTERVAL_MS, samples: [...samples] }
      }),
    }
  }),
)
