import { Context, Effect, Layer, Runtime, Schedule } from "effect"
import { execFile } from "node:child_process"
import { readFile } from "node:fs/promises"
import { cpus, totalmem } from "node:os"
import { join } from "node:path"
import { TASK_STATS_WINDOW_MS, type TaskStats, type TaskStatsSample } from "@cloudagents/protocol"
import { Config } from "./config"
import { CoreService } from "./core/service"
import { sliceCgroup } from "./sandbox/systemd"
import { parseCpuQuota, parseSize } from "./size"

const INTERVAL_MS = 1_000
/** A thread keeps its history this long after its last subscriber leaves, so reopening the panel shows it; then it is dropped. */
const IDLE_MS = 15_000
const NVIDIA_SMI_TIMEOUT_MS = 2_000
/** How often to ask systemd again for the cgroup of a slice that has not been active yet. */
const CGROUP_RETRY_MS = 10_000
const CGROUP_ROOT = "/sys/fs/cgroup"

/** What a stats stream starts with, and how to stop the subscription. */
export interface TaskStatsSubscription {
  /** The thread's recent samples, oldest first; may be empty on a freshly watched thread. */
  readonly initial: TaskStats
  readonly unsubscribe: () => void
}

export interface TaskStatsShape {
  /**
   * Watches a thread and samples it while it has subscribers. `onSamples` receives the samples taken since the
   * previous tick; the caller checks ownership.
   */
  readonly subscribe: (
    taskId: string,
    onSamples: (samples: readonly TaskStatsSample[]) => void,
  ) => Effect.Effect<TaskStatsSubscription>
}

export class TaskStatsService extends Context.Tag("cloudagents/TaskStats")<TaskStatsService, TaskStatsShape>() {}

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

/** The slice's memory in use and total CPU time; zero for a slice that is not running (its files are gone). */
const readSlice = (cgroup: string): Effect.Effect<{ memory: number; cpuUsec: number }> =>
  Effect.promise(async () => {
    const dir = join(CGROUP_ROOT, cgroup)
    try {
      const [memory, cpuStat] = await Promise.all([
        readFile(join(dir, "memory.current"), "utf8"),
        readFile(join(dir, "cpu.stat"), "utf8"),
      ])
      return { memory: Number(memory.trim()), cpuUsec: Number(/^usage_usec (\d+)$/m.exec(cpuStat)?.[1] ?? 0) }
    } catch {
      return { memory: 0, cpuUsec: 0 }
    }
  })

interface Watched {
  samples: TaskStatsSample[]
  subscribers: Set<(samples: readonly TaskStatsSample[]) => void>
  /** When the last subscriber left; null while one is watching. */
  idleSince: number | null
  cgroup: string | null
  cgroupCheckedAt: number
  /** CPU time and wall clock at the previous sample; null until the first one. */
  previous: { cpuUsec: number; at: number } | null
}

export const TaskStatsLive = Layer.effect(
  TaskStatsService,
  Effect.gen(function* () {
    const config = yield* Config
    const core = yield* CoreService
    // The sampler outlives the request that starts it, so it runs on the box's runtime, not the HTTP handler's.
    const runFork = Runtime.runFork(yield* Effect.runtime<never>())
    const systemd = config.systemd
    const ramMax = systemd ? (parseSize(systemd.limits.memoryMax) ?? totalmem()) : null
    const cores = systemd ? (parseCpuQuota(systemd.limits.cpuQuota) ?? cpus().length) : null
    const watched = new Map<string, Watched>()
    let sampling = false
    let gpu = true

    /** Takes one sample for a watched thread; null when the reading only served as the CPU baseline. */
    const sampleTask = (
      taskId: string,
      w: Watched,
      video: { used: number; total: number } | null,
    ): Effect.Effect<TaskStatsSample | null> =>
      Effect.gen(function* () {
        const now = Date.now()
        let ramUsed: number | null = null
        let cpu: number | null = null
        if (systemd && ramMax !== null && cores !== null) {
          if (w.cgroup === null && now - w.cgroupCheckedAt >= CGROUP_RETRY_MS) {
            w.cgroupCheckedAt = now
            w.cgroup = yield* sliceCgroup(systemd, taskId).pipe(
              Effect.catchAll((e) => Effect.as(Effect.logWarning(`task ${taskId} stats: ${e.message}`), null)),
            )
          }
          const slice = w.cgroup === null ? { memory: 0, cpuUsec: 0 } : yield* readSlice(w.cgroup)
          ramUsed = slice.memory
          const previous = w.previous
          w.previous = { cpuUsec: slice.cpuUsec, at: now }
          // The first reading is only the baseline; CPU use is the change between two of them.
          if (previous === null) return null
          const elapsedUsec = (now - previous.at) * 1000
          // A slice that was restarted counts again from zero.
          const busy = Math.max(0, slice.cpuUsec - previous.cpuUsec)
          cpu = elapsedUsec > 0 ? Math.min(1, busy / (elapsedUsec * cores)) : 0
        }
        const sample: TaskStatsSample = {
          at: now,
          cpu,
          ramUsed,
          ramMax,
          vramUsed: video?.used ?? null,
          vramTotal: video?.total ?? null,
          diskUsed: core.storageUsed(taskId),
          diskMax: config.taskDiskMax,
        }
        w.samples.push(sample)
        const oldest = now - TASK_STATS_WINDOW_MS
        const keep = w.samples.findIndex((s) => s.at >= oldest)
        if (keep > 0) w.samples = w.samples.slice(keep)
        return sample
      })

    const tick = Effect.gen(function* () {
      const now = Date.now()
      // Only threads somebody is watching are sampled; an unwatched one keeps its history until IDLE_MS is up.
      const active: [string, Watched][] = []
      for (const [taskId, w] of [...watched]) {
        if (w.subscribers.size > 0) {
          active.push([taskId, w])
        } else if (w.idleSince !== null && now - w.idleSince >= IDLE_MS) {
          watched.delete(taskId)
        }
      }
      if (active.length === 0) return
      // One GPU query per tick, shared by every watched thread.
      const video = gpu ? yield* vram() : null
      if (video === "missing") gpu = false
      const shared = video === "missing" ? null : video
      for (const [taskId, w] of active) {
        const sample = yield* sampleTask(taskId, w, shared)
        if (sample === null || w.subscribers.size === 0) continue
        for (const listener of [...w.subscribers]) listener([sample])
      }
    })

    // Samples every INTERVAL_MS while any thread is watched; the next subscription starts it again.
    const run = tick.pipe(
      Effect.repeat(Schedule.spaced(INTERVAL_MS).pipe(Schedule.whileOutput(() => watched.size > 0))),
      Effect.ensuring(Effect.sync(() => (sampling = false))),
    )

    return {
      subscribe: (taskId, onSamples) =>
        Effect.sync(() => {
          let w = watched.get(taskId)
          if (w === undefined) {
            w = {
              samples: [],
              subscribers: new Set(),
              idleSince: null,
              cgroup: null,
              cgroupCheckedAt: 0,
              previous: null,
            }
            watched.set(taskId, w)
          }
          const entry = w
          entry.subscribers.add(onSamples)
          entry.idleSince = null
          if (!sampling) {
            sampling = true
            runFork(run)
          }
          return {
            initial: { intervalMs: INTERVAL_MS, samples: [...entry.samples] },
            unsubscribe: () => {
              if (watched.get(taskId) !== entry) return
              entry.subscribers.delete(onSamples)
              if (entry.subscribers.size === 0) entry.idleSince = Date.now()
            },
          }
        }),
    }
  }),
)
