import { readdir, readFile } from "node:fs/promises"
import { basename, join } from "node:path"
import type { TaskAppUsage, TaskRamOther } from "@cloudagents/protocol"

/** Runtimes named after the script they run (`node · vite`): on their own they say nothing about the application. */
const RUNTIMES: Record<string, true> = { node: true, bun: true, deno: true, python: true, python3: true }
/** The largest groups sent per sample; the rest are summed into one unnamed entry. */
export const MAX_APPS = 8
/** `/proc/<pid>/stat` times are in clock ticks; Linux userspace sees USER_HZ = 100 on every architecture. */
const USEC_PER_TICK = 10_000

/** One process of a slice at one reading. */
export interface ProcessReading {
  /** pid and start time: a reused pid is a different process. */
  readonly key: string
  readonly name: string
  /**
   * Pss_Anon + Pss_Shmem, bytes: each page shared by several processes (a fork's copy-on-write pages, shared memory)
   * is divided between them, so summed over the slice it is the slice's mapped anonymous and shared memory once.
   */
  readonly memory: number
  /** Pss_Shmem alone, bytes. */
  readonly shmem: number
  /** utime + stime, microseconds. */
  readonly cpuUsec: number
}

/** The package a path under `node_modules` belongs to (`@scope/name` kept whole); null outside one. */
const packageOf = (path: string): string | null => {
  const parts = path.split("/")
  const at = parts.lastIndexOf("node_modules")
  if (at < 0) return null
  let i = at + 1
  // `node_modules/.bin/<tool>` is a link named after the tool.
  if (parts[i] === ".bin") return parts[i + 1] ?? null
  const first = parts[i]
  if (first === undefined || first === "") return null
  if (first.startsWith("@")) {
    i++
    return parts[i] === undefined ? null : `${first}/${parts[i]}`
  }
  return first
}

/** Nix wraps programs as `.<name>-wrapped`; the program is `<name>`. */
const unwrap = (name: string): string => /^\.(.+)-wrapped$/.exec(name)?.[1] ?? name

/** Flags after which a runtime runs code from argv (`node -e`, `python -c`), not a script file. */
const INLINE_CODE: Record<string, true> = { "-e": true, "--eval": true, "-p": true, "--print": true, "-c": true }

/**
 * The application a process belongs to, from its argv: the program's name, or for a runtime the script it runs (its
 * package when the script is under `node_modules`, the module for `python -m`). Without argv (a process that
 * replaced it with nothing) it falls back to the kernel's command name.
 */
export const appName = (argv: readonly string[], comm: string): string => {
  const [program, ...args] = argv
  if (program === undefined || program === "") return unwrap(comm)
  const runtime = unwrap(basename(program))
  if (RUNTIMES[runtime] !== true) return runtime
  // The first operand is the script; flags before it belong to the runtime (`node --max-old-space-size=4096 x.js`).
  const at = args.findIndex((a) => !a.startsWith("-") || INLINE_CODE[a] === true || a === "-m")
  const operand = args[at]
  if (operand === undefined || INLINE_CODE[operand] === true) return runtime
  const script = operand === "-m" ? args[at + 1] : operand
  if (script === undefined) return runtime
  const name = packageOf(script) ?? basename(script).replace(/\.(c|m)?[jt]s$|\.py$/, "")
  return name === "" || name === runtime ? runtime : `${runtime} · ${name}`
}

/** Every pid in the cgroup and the cgroups under it; empty once the cgroup is gone. */
const cgroupPids = async (dir: string): Promise<number[]> => {
  const [procs, entries] = await Promise.all([
    readFile(join(dir, "cgroup.procs"), "utf8").catch(() => ""),
    readdir(dir, { withFileTypes: true }).catch(() => []),
  ])
  const pids = procs
    .split("\n")
    .filter((line) => line !== "")
    .map(Number)
  const nested = await Promise.all(entries.filter((e) => e.isDirectory()).map((e) => cgroupPids(join(dir, e.name))))
  return pids.concat(...nested)
}

/** A `<field>:  <n> kB` line of a /proc file, in bytes; 0 when absent. */
const kib = (text: string, field: string): number => Number(new RegExp(`^${field}:\\s+(\\d+) kB$`, "m").exec(text)?.[1] ?? 0) * 1024

/**
 * A process's proportional anonymous and shared memory (bytes). A process that made itself non-dumpable (pasta does)
 * keeps its `smaps_rollup` from other processes of the same user, so it falls back to its resident memory from
 * `status`: the same for a process sharing nothing with a fork.
 */
const readMemory = async (dir: string): Promise<{ memory: number; shmem: number }> => {
  try {
    const smaps = await readFile(join(dir, "smaps_rollup"), "utf8")
    const shmem = kib(smaps, "Pss_Shmem")
    return { memory: kib(smaps, "Pss_Anon") + shmem, shmem }
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "EACCES") throw e
    const status = await readFile(join(dir, "status"), "utf8")
    const shmem = kib(status, "RssShmem")
    return { memory: kib(status, "RssAnon") + shmem, shmem }
  }
}

/** One process; null when it exited mid-read. */
const readProcess = async (pid: number): Promise<ProcessReading | null> => {
  try {
    const dir = `/proc/${pid}`
    const [{ memory, shmem }, stat, cmdline] = await Promise.all([
      readMemory(dir),
      readFile(join(dir, "stat"), "utf8"),
      readFile(join(dir, "cmdline"), "utf8"),
    ])
    // The command name is in parentheses and may hold spaces or parentheses itself; the fields after it are fixed.
    const close = stat.lastIndexOf(")")
    const fields = stat.slice(close + 2).split(" ")
    // Fields from `state` (3rd): utime is the 14th, stime the 15th, starttime the 22nd.
    const ticks = Number(fields[11]) + Number(fields[12])
    const comm = stat.slice(stat.indexOf("(") + 1, close)
    const argv = cmdline.replace(/\0$/, "").split("\0")
    return {
      key: `${pid}:${fields[19]}`,
      name: appName(argv, comm),
      memory,
      shmem,
      cpuUsec: Number.isFinite(ticks) ? ticks * USEC_PER_TICK : 0,
    }
  } catch {
    return null
  }
}

/** The processes of a slice's cgroup (a path under the cgroup2 mount). */
export const readProcesses = async (dir: string): Promise<ProcessReading[]> => {
  const pids = await cgroupPids(dir)
  const readings = await Promise.all(pids.map(readProcess))
  return readings.filter((r) => r !== null)
}

/** A `<field> <n>` line of a cgroup's `memory.stat`, in bytes; 0 when absent. */
const statField = (stat: string, field: string): number => Number(new RegExp(`^${field} (\\d+)$`, "m").exec(stat)?.[1] ?? 0)

/**
 * What the slice's memory holds besides its processes' mapped memory, from its `memory.current` and `memory.stat`:
 * cached file contents (`file` minus `shmem`), shared memory no process maps (tmpfs files: `shmem` minus the
 * processes' Pss_Shmem) and the kernel's own (everything beyond `anon` and `file`). With the processes' memory it adds
 * up to `memory.current`, give or take the anonymous memory that moved between the reads.
 */
export const otherMemory = (current: number, stat: string, processes: readonly ProcessReading[]): TaskRamOther => {
  const anon = statField(stat, "anon")
  const file = statField(stat, "file")
  const shmem = statField(stat, "shmem")
  const mappedShmem = processes.reduce((n, p) => n + p.shmem, 0)
  return {
    pageCache: Math.max(0, file - shmem),
    tmpfs: Math.max(0, shmem - mappedShmem),
    kernel: Math.max(0, current - anon - file),
  }
}

/**
 * Groups processes by application, most memory first, with the groups past `MAX_APPS` summed into one unnamed entry.
 * CPU is each process's time since `previous` (a process missing there started since, so all of its time counts)
 * over `capacityUsec`, the slice's CPU quota for the interval.
 */
export const groupApps = (
  processes: readonly ProcessReading[],
  previous: ReadonlyMap<string, number>,
  capacityUsec: number,
): TaskAppUsage[] => {
  const groups = new Map<string, { processes: number; ramUsed: number; cpuUsec: number }>()
  for (const p of processes) {
    const g = groups.get(p.name) ?? { processes: 0, ramUsed: 0, cpuUsec: 0 }
    g.processes++
    g.ramUsed += p.memory
    g.cpuUsec += Math.max(0, p.cpuUsec - (previous.get(p.key) ?? 0))
    groups.set(p.name, g)
  }
  const cpu = (usec: number): number => (capacityUsec > 0 ? Math.min(1, usec / capacityUsec) : 0)
  const sorted = [...groups].sort(([, a], [, b]) => b.ramUsed - a.ramUsed || b.cpuUsec - a.cpuUsec)
  const apps: TaskAppUsage[] = sorted
    .slice(0, MAX_APPS)
    .map(([name, g]) => ({ name, processes: g.processes, ramUsed: g.ramUsed, cpu: cpu(g.cpuUsec) }))
  const rest = sorted.slice(MAX_APPS)
  if (rest.length > 0) {
    apps.push({
      name: null,
      processes: rest.reduce((n, [, g]) => n + g.processes, 0),
      ramUsed: rest.reduce((n, [, g]) => n + g.ramUsed, 0),
      cpu: cpu(rest.reduce((n, [, g]) => n + g.cpuUsec, 0)),
    })
  }
  return apps
}
