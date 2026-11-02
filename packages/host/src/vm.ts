import { randomUUID } from "node:crypto"
import { mkdirSync, readFileSync, rmSync, statSync } from "node:fs"
import { HostError } from "./errors"
import { copyOsImage, createDataVolume, DATA_VOLUME_LABEL, verifyVolumeIdentity } from "./disk"
import { launcherEnv, parseAccel, spawnLauncher } from "./launcher"
import { withVmLock } from "./lock"
import { probeQmp, qmpCommand } from "./qmp"
import { isProcessAlive, processBelongsToVm, readProcStat, sleep, type ProcIdentity } from "./proc"
import { readHost, removeVmArtifacts, requireVm, vmPaths, writeVm } from "./state-store"
import { requireTool } from "./tools"
import type { ProcessRef, Shape, VmRecord, VolumeIdentity } from "./schema"
import { closingEvent, commitFields, commitState, vmProcessName, type HostContext } from "./vm-state"

const QMP_PROBE_TIMEOUT_MS = 500
const QMP_COMMAND_TIMEOUT_MS = 5000
const POLL_INTERVAL_MS = 100
const FORCE_WAIT_MS = 30_000
/** Unix socket paths are limited to 107 bytes plus the NUL terminator. */
const MAX_SOCKET_PATH_BYTES = 107
export const GONE_AT_RECONCILE = "process gone at reconcile"
export const FORCED_STOP_NOTE = "forced stop (QMP quit): disk contents may be inconsistent"

export interface CreateOptions {
  readonly userId: string
  readonly osImage: string
  readonly shape: Shape
  readonly volumeGb: number
}

export type StopOutcome = "already-stopped" | "stopped" | "forced"

export interface StopOptions {
  readonly timeoutMs: number
  readonly force: boolean
}

const requireRegularFile = (path: string, label: string): void => {
  const stat = statSync(path, { throwIfNoEntry: false })
  if (stat === undefined || !stat.isFile()) throw new HostError(`${label} must be an existing regular file: ${path}`)
}

const requireSocketPath = (path: string): void => {
  if (Buffer.byteLength(path) > MAX_SOCKET_PATH_BYTES) {
    throw new HostError(`socket path is too long for a unix socket (${path.length} chars): ${path}`)
  }
}

/** Last lines of the launcher log, for error messages. Empty when unreadable. */
const logTail = (path: string): string => {
  try {
    return readFileSync(path, "utf8").split("\n").slice(-20).join("\n").trim()
  } catch {
    return ""
  }
}

/** Records a stop failure on the VM and raises it. The VM stays in its current state. */
const stopFailure = (ctx: HostContext, vm: VmRecord, message: string): never => {
  commitFields(ctx, vm, { lastError: message })
  throw new HostError(`VM ${vm.vmId}: ${message}`)
}

/**
 * Creates a stopped VM: copies the base OS image, creates the formatted data volume, writes vm.json.
 * Returns the new vmId. Emits no lifecycle event.
 */
export const createVm = (ctx: HostContext, options: CreateOptions): string => {
  requireRegularFile(options.osImage, "--os-image")
  requireTool("cp")
  requireTool("mkfs.ext4")
  requireTool("blkid")
  const host = readHost(ctx.stateDir)
  const vmId = randomUUID()
  const paths = vmPaths(ctx.stateDir, vmId)
  mkdirSync(paths.dir, { mode: 0o700 })
  const volume: VolumeIdentity = { label: DATA_VOLUME_LABEL, uuid: randomUUID() }
  try {
    copyOsImage(options.osImage, paths.osDisk)
    createDataVolume(paths.dataDisk, options.volumeGb, volume)
    const now = new Date().toISOString()
    writeVm(ctx.stateDir, {
      schemaVersion: 1,
      vmId,
      userId: options.userId,
      hostId: host.hostId,
      shape: options.shape,
      state: "stopped",
      sequence: 0,
      osDisk: paths.osDisk,
      dataDisk: paths.dataDisk,
      volume,
      process: null,
      createdAt: now,
      updatedAt: now,
      runningReported: false,
      lastError: null,
    })
  } catch (error) {
    rmSync(paths.dir, { recursive: true, force: true })
    throw error
  }
  return vmId
}

/** Waits for QMP to answer while the launcher is alive; resolves to the running VM or throws. */
const awaitReady = async (ctx: HostContext, vm: VmRecord): Promise<VmRecord> => {
  const paths = vmPaths(ctx.stateDir, vm.vmId)
  const name = vmProcessName(vm.vmId)
  const deadline = Date.now() + ctx.readyTimeoutMs
  for (;;) {
    if (processBelongsToVm(vm.process, name) && (await probeQmp(paths.qmpSock, QMP_PROBE_TIMEOUT_MS))) {
      return commitState(ctx, vm, "running", { process: vm.process, lastError: null }, "running")
    }
    if (!isProcessAlive(vm.process)) {
      const tail = logTail(paths.launcherLog)
      const message = `launcher exited during start${tail === "" ? "" : `:\n${tail}`}`
      commitState(ctx, vm, "stopped", { process: null, lastError: message }, null)
      throw new HostError(`VM ${vm.vmId} failed to start: ${message}`)
    }
    if (Date.now() >= deadline) {
      const message =
        `QMP not ready within ${ctx.readyTimeoutMs} ms; launcher pid ${vm.process?.pid} still running; ` +
        "state left as starting (vm stop or reconcile resolves it)"
      commitFields(ctx, vm, { lastError: message })
      throw new HostError(`VM ${vm.vmId} ${message}`)
    }
    await sleep(POLL_INTERVAL_MS)
  }
}

/**
 * Starts a stopped VM. Verifies the data volume identity first; never formats. Spawns the launcher
 * detached and returns the running VM once QMP answers.
 */
export const startVm = (ctx: HostContext, vmId: string): Promise<VmRecord> => {
  const paths = vmPaths(ctx.stateDir, vmId)
  return withVmLock(paths.dir, async () => {
    let vm = requireVm(ctx.stateDir, vmId)
    if (vm.state !== "stopped") throw new HostError(`VM ${vmId} is ${vm.state}; only a stopped VM can be started`)
    requireRegularFile(paths.osDisk, "OS disk")
    requireRegularFile(paths.dataDisk, "data disk")
    verifyVolumeIdentity(paths.dataDisk, vm.volume)
    const accel = parseAccel(ctx.accel)
    requireSocketPath(paths.qmpSock)
    requireSocketPath(paths.consoleSock)
    rmSync(paths.qmpSock, { force: true })
    rmSync(paths.consoleSock, { force: true })
    vm = commitState(ctx, vm, "starting", { process: null, lastError: null }, null)
    const env = launcherEnv(
      {
        vmName: vmProcessName(vmId),
        cpus: vm.shape.cpus,
        memoryMb: vm.shape.memoryMb,
        accel,
        consoleSock: paths.consoleSock,
        consoleLog: paths.consoleLog,
        qmpSock: paths.qmpSock,
      },
      ctx.env,
    )
    let pid: number
    try {
      pid = await spawnLauncher(ctx.launcher, [paths.osDisk, paths.dataDisk], env, paths.launcherLog)
    } catch (error) {
      const message = `launcher failed to start: ${(error as Error).message}`
      commitState(ctx, vm, "stopped", { process: null, lastError: message }, null)
      throw new HostError(`VM ${vmId} ${message}`)
    }
    const stat = readProcStat(pid)
    const process: ProcessRef | null =
      stat === null ? null : { pid, startTime: stat.startTime, name: vmProcessName(vmId) }
    vm = commitFields(ctx, vm, { process })
    return awaitReady(ctx, vm)
  })
}

const waitForExit = async (ref: ProcIdentity, timeoutMs: number): Promise<boolean> => {
  const deadline = Date.now() + timeoutMs
  while (isProcessAlive(ref)) {
    if (Date.now() >= deadline) return false
    await sleep(POLL_INTERVAL_MS)
  }
  return true
}

/**
 * Stops a VM. Sends QMP system_powerdown (ACPI) and waits for the launcher/QEMU to exit. Never kills.
 * With `force`, a timed-out or unreachable guest gets QMP quit instead; the result is flagged as forced.
 */
export const stopVm = (ctx: HostContext, vmId: string, options: StopOptions): Promise<StopOutcome> => {
  const paths = vmPaths(ctx.stateDir, vmId)
  return withVmLock(paths.dir, async () => {
    let vm = requireVm(ctx.stateDir, vmId)
    if (vm.state === "stopped") return "already-stopped"
    if (vm.state === "running" || vm.state === "starting") {
      vm = commitState(ctx, vm, "stopping", { process: vm.process, lastError: null }, null)
    } else if (vm.state !== "stopping") {
      throw new HostError(`VM ${vmId} is ${vm.state}; cannot stop it`)
    }
    const ref = vm.process
    if (ref === null || !isProcessAlive(ref)) {
      commitState(ctx, vm, "stopped", { process: null, lastError: null }, closingEvent(vm))
      return "stopped"
    }
    if (!processBelongsToVm(ref, vmProcessName(vmId))) {
      stopFailure(ctx, vm, `pid ${ref.pid} is alive but its command line does not name ${vmProcessName(vmId)}; refusing to stop`)
    }
    let requested = true
    try {
      await qmpCommand(paths.qmpSock, "system_powerdown", QMP_COMMAND_TIMEOUT_MS)
    } catch (error) {
      requested = false
      if (!options.force) {
        stopFailure(ctx, vm, `cannot request guest power-off over QMP: ${(error as Error).message}`)
      }
    }
    if (requested && (await waitForExit(ref, options.timeoutMs))) {
      commitState(ctx, vm, "stopped", { process: null, lastError: null }, closingEvent(vm))
      return "stopped"
    }
    if (!options.force) {
      stopFailure(
        ctx,
        vm,
        `guest did not power off within ${Math.round(options.timeoutMs / 1000)}s; qemu pid ${ref.pid} still running ` +
          "(not killed). Retry vm stop, use --force, or stop the process manually",
      )
    }
    ctx.warn(`forcing VM ${vmId}: QMP quit stops QEMU without a guest shutdown; disk contents may be inconsistent`)
    try {
      await qmpCommand(paths.qmpSock, "quit", QMP_COMMAND_TIMEOUT_MS)
    } catch (error) {
      stopFailure(ctx, vm, `forced stop could not send QMP quit: ${(error as Error).message}`)
    }
    if (!(await waitForExit(ref, FORCE_WAIT_MS))) {
      stopFailure(ctx, vm, `forced stop: qemu pid ${ref.pid} still running after QMP quit`)
    }
    commitState(ctx, vm, "stopped", { process: null, lastError: FORCED_STOP_NOTE }, closingEvent(vm))
    return "forced"
  })
}

/**
 * Removes the VM's artifacts and marks it deleted. Requires the process to be gone. The lifecycle event is
 * appended before the state is persisted, so a crash during removal resumes from `destroying`.
 */
export const finishDestroy = (ctx: HostContext, vm: VmRecord): VmRecord => {
  if (isProcessAlive(vm.process)) {
    throw new HostError(`refusing to remove VM ${vm.vmId}: pid ${vm.process?.pid} is still alive`)
  }
  removeVmArtifacts(ctx.stateDir, vm.vmId)
  return commitState(ctx, vm, "deleted", { process: null, lastError: null }, "deleted")
}

/** Destroys a stopped VM (or resumes an interrupted destroy). Refused in every other state. */
export const destroyVm = (ctx: HostContext, vmId: string): Promise<VmRecord> =>
  withVmLock(vmPaths(ctx.stateDir, vmId).dir, async () => {
    let vm = requireVm(ctx.stateDir, vmId)
    if (vm.state === "deleted") throw new HostError(`VM ${vmId} is already deleted`)
    if (vm.state === "stopped") {
      vm = commitState(ctx, vm, "destroying", { process: null, lastError: null }, null)
    } else if (vm.state !== "destroying") {
      throw new HostError(`refusing to destroy VM ${vmId} in state ${vm.state}; stop it first`)
    }
    return finishDestroy(ctx, vm)
  })
