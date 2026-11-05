import type { Subprocess } from "bun"
import { closeSync, openSync, unlinkSync } from "node:fs"
import type { ProcessRef } from "./schema"
import { ChClient } from "./ch-api"
import { HostError, errorMessage } from "./errors"
import { isProcessAlive, processIsVmm, readProcStat, sleep, type ProcIdentity } from "./proc"

/** Cloud Hypervisor runs under this slice when `scope` is systemd-system or systemd-user. */
export const VM_SLICE = "kestrel-vms.slice"

export type ScopeMode = "systemd-system" | "systemd-user" | "none"

export const vmUnitName = (boxId: string): string => `kestrel-vm-${boxId}`

/**
 * The argv that starts a VMM. Under systemd the VMM runs in a transient scope with a hard memory limit, so a VMM
 * cannot take the host down; `--scope` execs the command in place, so the spawned pid is the VMM's pid.
 */
export const vmmArgv = (opts: {
  readonly scope: ScopeMode
  readonly unit: string
  readonly chPath: string
  readonly apiSocket: string
  readonly memoryMaxBytes: number
}): string[] => {
  const ch = [opts.chPath, "--api-socket", opts.apiSocket]
  if (opts.scope === "none") return ch
  return [
    "systemd-run",
    ...(opts.scope === "systemd-user" ? ["--user"] : []),
    "--scope",
    "--quiet",
    "--collect",
    `--unit=${opts.unit}`,
    `--slice=${VM_SLICE}`,
    "-p",
    `MemoryMax=${opts.memoryMaxBytes}`,
    "--",
    ...ch,
  ]
}

/**
 * Starts a VMM with its stdout and stderr appended to `logPath`, and returns its identity. The process is not
 * waited on: it outlives this agent's restarts and is re-adopted by `processIsVmm`.
 */
export const launchVmm = (opts: {
  readonly scope: ScopeMode
  readonly unit: string
  readonly chPath: string
  readonly apiSocket: string
  readonly memoryMaxBytes: number
  readonly logPath: string
}): ProcessRef => {
  const argv = vmmArgv(opts)
  try {
    unlinkSync(opts.apiSocket)
  } catch {
    // no stale socket
  }
  const log = openSync(opts.logPath, "a", 0o600)
  let child: Subprocess
  try {
    child = Bun.spawn(argv, { stdin: "ignore", stdout: log, stderr: log })
  } catch (error) {
    throw new HostError(`cannot start ${argv[0]}: ${errorMessage(error)}`)
  } finally {
    closeSync(log)
  }
  child.unref()
  const stat = readProcStat(child.pid)
  if (stat === null) throw new HostError(`VMM exited before its identity was read (pid ${child.pid})`)
  return { pid: child.pid, startTime: stat.startTime, name: opts.unit }
}

/** Waits until the VMM answers on its API socket, or throws after `timeoutMs`. */
export const waitForApi = async (apiSocket: string, identity: ProcIdentity, timeoutMs: number): Promise<void> => {
  const client = new ChClient(apiSocket)
  const deadline = Date.now() + timeoutMs
  for (;;) {
    if (!isProcessAlive(identity)) throw new HostError("VMM exited during startup; see console log")
    try {
      await client.ping()
      return
    } catch {
      if (Date.now() >= deadline) throw new HostError(`VMM API did not answer within ${timeoutMs} ms`)
      await sleep(50)
    }
  }
}

/** True when `identity` is a live VMM started for `apiSocket` and its API answers. */
export const adoptVmm = async (apiSocket: string, identity: ProcIdentity | null): Promise<boolean> => {
  if (identity === null || !processIsVmm(identity, apiSocket)) return false
  try {
    await new ChClient(apiSocket).ping()
    return true
  } catch {
    return false
  }
}

const waitExit = async (identity: ProcIdentity, timeoutMs: number): Promise<boolean> => {
  const deadline = Date.now() + timeoutMs
  while (isProcessAlive(identity)) {
    if (Date.now() >= deadline) return false
    await sleep(50)
  }
  return true
}

/**
 * Stops a VMM: asks it to shut down through its API, then kills it if it is still alive after `graceMs`.
 * Only signals the process while its identity still matches.
 */
export const stopVmm = async (identity: ProcIdentity | null, apiSocket: string, graceMs: number): Promise<void> => {
  if (identity === null || !isProcessAlive(identity)) return
  try {
    await new ChClient(apiSocket).shutdownVmm()
  } catch {
    // the API is gone or unresponsive; the kill below still applies
  }
  if (await waitExit(identity, graceMs)) return
  if (!processIsVmm(identity, apiSocket)) return
  process.kill(identity.pid, "SIGKILL")
  await waitExit(identity, 5_000)
}

/**
 * Kills a VMM at once, for a lapsed lease: no API request, no grace period. Resolves only once the process has exited,
 * and throws if it has not, because the caller releases the VM's volume next. Only signals the process while its
 * identity still matches.
 */
export const killVmm = async (identity: ProcIdentity | null, apiSocket: string): Promise<void> => {
  if (identity === null || !isProcessAlive(identity) || !processIsVmm(identity, apiSocket)) return
  try {
    process.kill(identity.pid, "SIGKILL")
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error
  }
  if (!(await waitExit(identity, 5_000))) throw new HostError(`VMM ${identity.pid} did not exit after SIGKILL`)
}
