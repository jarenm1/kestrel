import { readFileSync } from "node:fs"
import { HostError } from "./errors"

/** Identity of a process: its pid plus the kernel start time, which changes if the pid is reused. */
export interface ProcIdentity {
  readonly pid: number
  readonly startTime: number
}

export interface ProcStat {
  readonly startTime: number
  /** Kernel state letter; `Z` is a zombie (exited, not yet reaped). */
  readonly state: string
}

/**
 * Parses /proc/<pid>/stat. The command name (field 2) is wrapped in parentheses and may itself contain
 * spaces or parentheses, so fields are read after the last `)`. Field 3 (state) is index 0 there, so
 * field 22 (starttime) is index 19. Returns null when the process does not exist.
 */
export const readProcStat = (pid: number): ProcStat | null => {
  let text: string
  try {
    text = readFileSync(`/proc/${pid}/stat`, "utf8")
  } catch {
    return null
  }
  const fields = text.slice(text.lastIndexOf(")") + 2).split(" ")
  const state = fields[0]
  const startTime = Number(fields[19])
  if (state === undefined || !Number.isSafeInteger(startTime)) return null
  return { startTime, state }
}

/** True when `identity` names a live process: same pid and start time, and not a zombie. */
export const isProcessAlive = (identity: ProcIdentity | null): boolean => {
  if (identity === null) return false
  const stat = readProcStat(identity.pid)
  return stat !== null && stat.startTime === identity.startTime && stat.state !== "Z"
}

/** /proc/<pid>/cmdline with NUL separators turned into spaces, or null when unreadable. */
export const readCmdline = (pid: number): string | null => {
  try {
    return readFileSync(`/proc/${pid}/cmdline`, "utf8").split("\0").join(" ")
  } catch {
    return null
  }
}

/**
 * True when the recorded process is alive and was started with `--api-socket <apiSocket>`. Each VMM has its own
 * API socket path under its VM directory, so this identifies the VMM and guards against a reused pid.
 */
export const processIsVmm = (identity: ProcIdentity | null, apiSocket: string): boolean => {
  if (identity === null || !isProcessAlive(identity)) return false
  const cmdline = readCmdline(identity.pid)
  return cmdline !== null && cmdline.includes(`--api-socket ${apiSocket}`)
}

/** The cgroup v2 directory of a process (`/sys/fs/cgroup/...`), or null when it has none. */
export const cgroupDirOf = (pid: number): string | null => {
  let text: string
  try {
    text = readFileSync(`/proc/${pid}/cgroup`, "utf8")
  } catch {
    return null
  }
  const line = text.split("\n").find((entry) => entry.startsWith("0::"))
  if (line === undefined) return null
  return `/sys/fs/cgroup${line.slice(3)}`
}

export const sleep = (ms: number): Promise<void> => {
  const { promise, resolve } = Promise.withResolvers<void>()
  setTimeout(resolve, ms)
  return promise
}

/**
 * The `some avg10` memory pressure: the share of the last 10 s in which some task stalled on memory, in percent.
 * Throws when the kernel exposes no memory pressure stall information (PSI).
 */
export const readMemoryPressureAvg10 = (): number => {
  const text = readFileSync("/proc/pressure/memory", "utf8")
  const match = /^some avg10=([\d.]+)/m.exec(text)
  if (match === null) throw new HostError("/proc/pressure/memory has no `some avg10` line")
  return Number(match[1])
}

/** Total CPU time a cgroup has used, in microseconds, or null when it cannot be read (the VM is gone). */
export const readCpuUsec = (cgroupDir: string): number | null => {
  let text: string
  try {
    text = readFileSync(`${cgroupDir}/cpu.stat`, "utf8")
  } catch {
    return null
  }
  const match = /^usage_usec (\d+)/m.exec(text)
  return match === null ? null : Number(match[1])
}
