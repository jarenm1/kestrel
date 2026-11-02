import { spawn, type ChildProcess } from "node:child_process"
import { closeSync, openSync } from "node:fs"
import { once } from "node:events"
import { fileURLToPath } from "node:url"
import { HostError } from "./errors"

/** The repo's manual QEMU launcher, resolved relative to this file (packages/host/src -> repo root). */
export const DEFAULT_LAUNCHER = fileURLToPath(new URL("../../../scripts/nest-prototype/run.sh", import.meta.url))

export type Accel = "auto" | "kvm" | "tcg"

export const parseAccel = (value: string): Accel => {
  if (value === "auto" || value === "kvm" || value === "tcg") return value
  throw new HostError(`KESTREL_VM_ACCEL must be auto, kvm or tcg; got "${value}"`)
}

export interface LauncherInput {
  readonly vmName: string
  readonly cpus: number
  readonly memoryMb: number
  readonly accel: Accel
  readonly consoleSock: string
  readonly consoleLog: string
  readonly qmpSock: string
}

/** The environment contract of scripts/nest-prototype/run.sh. */
export const launcherEnv = (input: LauncherInput, base: NodeJS.ProcessEnv): NodeJS.ProcessEnv => ({
  ...base,
  KESTREL_VM_NAME: input.vmName,
  KESTREL_VM_CPUS: String(input.cpus),
  KESTREL_VM_MEMORY_MB: String(input.memoryMb),
  KESTREL_VM_ACCEL: input.accel,
  KESTREL_VM_CONSOLE_SOCKET: input.consoleSock,
  KESTREL_VM_CONSOLE_LOG: input.consoleLog,
  KESTREL_VM_QMP_SOCKET: input.qmpSock,
})

/**
 * Starts the launcher detached, with stdio on `logPath`, and resolves with its pid once the spawn succeeded.
 * The child outlives this CLI process (unref'd). The host never takes the image locks itself: the launcher
 * holds them for the lifetime of QEMU.
 */
export const spawnLauncher = async (
  launcher: string,
  args: readonly string[],
  env: NodeJS.ProcessEnv,
  logPath: string,
): Promise<number> => {
  const fd = openSync(logPath, "a", 0o600)
  let child: ChildProcess
  try {
    child = spawn(launcher, [...args], { env, stdio: ["ignore", fd, fd], detached: true })
  } finally {
    closeSync(fd)
  }
  child.unref()
  await once(child, "spawn")
  if (child.pid === undefined) throw new HostError(`launcher ${launcher} did not start`)
  return child.pid
}
