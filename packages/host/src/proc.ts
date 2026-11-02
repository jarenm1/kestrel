import { readFileSync } from "node:fs"

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
 * True when the recorded process is alive and its command line names the VM (`-name kestrel-<vmId>`
 * in the launcher's QEMU invocation). Guards against a live unrelated process that inherited the pid.
 */
export const processBelongsToVm = (identity: ProcIdentity | null, vmName: string): boolean => {
  if (identity === null || !isProcessAlive(identity)) return false
  const cmdline = readCmdline(identity.pid)
  return cmdline !== null && cmdline.includes(vmName)
}

export const sleep = (ms: number): Promise<void> => {
  const { promise, resolve } = Promise.withResolvers<void>()
  setTimeout(resolve, ms)
  return promise
}
