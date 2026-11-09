import { randomBytes } from "node:crypto"
import { accessSync, closeSync, constants, existsSync, ftruncateSync, mkdirSync, openSync, readdirSync, renameSync, rmSync, statSync, statfsSync } from "node:fs"
import { join } from "node:path"
import {
  GUEST_REPLY_TIMEOUT_MS,
  GUEST_STATUS_INTERVAL_MS,
  NEST_LAPSE_REFUSAL,
  NEST_SWAP_SERIAL,
  NEST_VOLUME_SERIAL,
  type BoxActivity,
  type GuestPressure,
  type HostToGuest,
  type NestHostCapacity,
  type NestHostCommand,
  type NestLimits,
  type NestVmReport,
  type NestVmState,
} from "@cloudagents/protocol"
import { ChClient, TEMPLATE_BOOT_MEMORY_BYTES, TEMPLATE_BOOT_VCPUS, type MemoryRestoreMode } from "./ch-api"
import { killVmm, launchVmm, stopVmm as stopVmmProcess, vmUnitName, waitForApi } from "./ch-process"
import type { HostConfig } from "./config"
import { HostError, UnknownBoxError, WakeTimeoutError, errorMessage } from "./errors"
import { fsyncDir, fsyncPath, writeFileAtomic } from "./fs-atomic"
import { readLeaseUntil, writeLeaseUntil } from "./lease"
import { type NetCommand, allocateSlot, firewallRuleset, guestNetwork, missingTapAddrs, networkForSlot, tapAddrsListArgs, tapDownCommands, tapUpCommands } from "./network"
import { type GuestSample, type ScaleState, NO_SCALE, CPU_PRESSURE_AVG10, HOST_MEMORY_PRESSURE_AVG10, MEMORY_PRESSURE_AVG10, MEMORY_STEP_BYTES, cpuActive, diskFreeBytes, diskTight, isIdle, lastActiveAt, memoryFloorBytes, memoryHeadroomBytes, memoryTargetBytes, pickSuspendVictim, stepSize, vcpuTarget } from "./policy"
import { cgroupDirOf, isProcessAlive, processIsVmm, readCpuUsec, readMemoryPressureAvg10, sleep, type ProcIdentity } from "./proc"
import { recoverPlan } from "./recovery"
import { Meter } from "./meter"
import { Outbox } from "./outbox"
import { type RestoreTarget, SNAPSHOT_FILES, prepareRestoreDir } from "./restore"
import { type CommandOutcome, type NestNetwork, type Operation, type ProcessRef, type VmRecord } from "./schema"
import { type StateLayout, ensureStateDirs, findCommand, isBoxId, listVms, markCommandsReported, pendingCommands, recordCommand, vmPaths, writeVm } from "./state-store"
import { buildTemplate, readGuestImage, removeStaleTemplates, templateDir, type GuestImage } from "./template"
import { runChecked, runTool } from "./tools"
import { type VolumeTool, backupVolume, createVolume, deleteVolumeStore, startLazyVolume, terminateProcess } from "./volume"
import { type GuestLink, connectGuest, newRequestId } from "./vsock"

const GIB = 1024 * 1024 * 1024
const MIB = 1024 * 1024
/** Memory the VMM process may use beyond the VM's own memory limit (the design's `MemoryMax`). */
const VMM_OVERHEAD_BYTES = 256 * MIB
/**
 * Size of each VM's sparse swap disk. The design does not fix it; the host uses this default.
 */
const SWAP_BYTES = 4 * GIB
/** Port the box listens on inside the VM (`nest.md`, Networking). */
const BOX_PORT = 8787
const TEMPLATE_HELLO_TIMEOUT_MS = 120_000
const API_TIMEOUT_MS = 10_000
const CONNECT_TIMEOUT_MS = 60_000
const LAZY_VOLUME_TIMEOUT_MS = 60_000
const VMM_STOP_GRACE_MS = 5_000
const VOLUME_STOP_GRACE_MS = 10_000
const WAKE_TIMEOUT_MS = 60_000
const WAKE_POLL_MS = 250
const GPU_INTERVAL_MS = 5 * 60_000
const RECONNECT_MIN_MS = 1_000
const RECONNECT_MAX_MS = 30_000
/** A guest status older than this is not used for policy decisions. */
const STATUS_FRESH_MS = 3 * GUEST_STATUS_INTERVAL_MS

/** A failed backup is retried after this long, doubling per failure, never later than the backup interval. */
const BACKUP_RETRY_MS = 60_000

type VmPathSet = ReturnType<typeof vmPaths>
type Command<T extends NestHostCommand["_tag"]> = Extract<NestHostCommand, { readonly _tag: T }>

/** What the manager tells the control link. The control link owns the connection; the manager owns the VMs. */
export interface VmEvents {
  /** A VM changed: state, size, GPUs, disk, or backup. */
  readonly vm: (report: NestVmReport) => void
  /** A request reached ingress for a box this host may not wake by itself. */
  readonly wakeRequest: (boxId: string) => void
  /** A background task failed; the manager keeps running and retries on its next tick. */
  readonly error: (message: string) => void
  /** Something the manager repaired on its own, not a failure: the firewall had lost a tap's element. */
  readonly notice: (message: string) => void
}

export interface IngressActivity {
  readonly boxId: string
  readonly openConnections: number
  readonly lastRequestAt: number | null
}

interface Runtime {
  link: GuestLink | null
  status: { readonly pressure: GuestPressure; readonly activity: BoxActivity | null; readonly at: number } | null
  /** The VMM was killed for a lapsed lease and the record is being settled; no second kill. */
  fencing: boolean
  ingress: { openConnections: number; lastRequestAt: number | null }
  memoryScale: ScaleState
  cpuScale: ScaleState
  lastGpuAttachAt: number | null
  busy: boolean
  /** The cgroup's CPU time at the last tick, and when it was read. */
  cpuSample: { readonly usec: number; readonly at: number } | null
  lastCpuActiveAt: number | null
  /** Backup retries: the last attempt, and how many have failed in a row (reset by a success). */
  backupAttemptAt: number | null
  backupFailures: number
}

const newRuntime = (): Runtime => ({
  link: null,
  status: null,
  fencing: false,
  ingress: { openConnections: 0, lastRequestAt: null },
  memoryScale: NO_SCALE,
  cpuScale: NO_SCALE,
  lastGpuAttachAt: null,
  busy: false,
  cpuSample: null,
  lastCpuActiveAt: null,
  backupAttemptAt: null,
  backupFailures: 0,
})

const gpuDeviceId = (pciAddress: string): string => `gpu-${pciAddress}`
const gpuPath = (pciAddress: string): string => `/sys/bus/pci/devices/${pciAddress}`
const newCloneId = (): string => randomBytes(16).toString("hex")

const restoreMode = (): MemoryRestoreMode => {
  try {
    accessSync("/dev/userfaultfd", constants.R_OK | constants.W_OK)
    return "OnDemand"
  } catch {
    // Present but not usable by this user (the device is root-only unless an ACL grants access): restore in Copy mode.
    return "Copy"
  }
}

const createSparse = (path: string, bytes: number): void => {
  rmSync(path, { force: true })
  const fd = openSync(path, "w", 0o600)
  try {
    ftruncateSync(fd, bytes)
  } finally {
    closeSync(fd)
  }
}

/** Removes everything a VM left in its directory except `vm.json`, which stays as the tombstone. */
const clearArtifacts = (dir: string): void => {
  if (!existsSync(dir)) return
  for (const name of readdirSync(dir)) {
    if (name !== "vm.json") rmSync(join(dir, name), { recursive: true, force: true })
  }
}

const allocatedBytes = (path: string): number => {
  try {
    return statSync(path).blocks * 512
  } catch {
    return 0
  }
}

const runNetCommands = async (commands: readonly NetCommand[]): Promise<void> => {
  for (const command of commands) {
    const [name, ...args] = command
    if (name === undefined) throw new HostError("empty network command")
    await runChecked(name, args)
  }
}

/** Tears a tap down. Best effort: a tap that is already gone is not an error. */
const tapDown = async (network: NestNetwork): Promise<void> => {
  for (const command of tapDownCommands(network)) {
    const [name, ...args] = command
    if (name !== undefined) await runTool(name, args)
  }
}

/**
 * The `since` of a state a VM enters now. Control orders one VM's reports by `since` and drops an older one (D10), so it
 * must never go backwards: after the wall clock steps back it stays 1 ms past the state the VM is leaving, or every
 * later report of the new state would be dropped as stale.
 */
const enteredAt = (previous: number): number => Math.max(Date.now(), previous + 1)

const createNewRecord = (fields: {
  readonly boxId: string
  readonly vmId: string
  readonly userId: string
  readonly ownerEpoch: number
  readonly imageId: string
  readonly publicUrl: string
  readonly limits: NestLimits
  readonly volumeRef: string | null
  readonly localDirty: boolean
  readonly state: NestVmState
}): VmRecord => ({
  schemaVersion: 1,
  boxId: fields.boxId,
  vmId: fields.vmId,
  userId: fields.userId,
  ownerEpoch: fields.ownerEpoch,
  state: fields.state,
  since: Date.now(),
  imageId: fields.imageId,
  publicUrl: fields.publicUrl,
  limits: fields.limits,
  vcpus: 0,
  memoryBytes: 0,
  gpus: [],
  gpuAttachedAt: null,
  volumeRef: fields.volumeRef,
  backedUpAt: null,
  localRef: null,
  localDirty: fields.localDirty,
  frozen: false,
  network: null,
  process: null,
  volumeProcess: null,
  snapshotGen: null,
  cloneId: null,
  tombstone: null,
  operation: null,
  lastError: null,
})

/** Removes a lazy restore destination that never became the VM's volume. */
const clearLazyDestination = (p: VmPathSet): void => {
  rmSync(p.volume, { force: true })
  rmSync(`${p.volume}.bitmap`, { force: true })
  rmSync(`${p.volume}.lock`, { force: true })
}

/**
 * Rolls back a volume replacement interrupted after the local copy was moved to `volume.raw.previous`: the local copy
 * is put back over a destination that never became the VM's volume. Returns whether a local copy is at `volume` now.
 */
const restorePreviousVolume = (p: VmPathSet): boolean => {
  const previous = `${p.volume}.previous`
  if (!existsSync(previous)) return existsSync(p.volume)
  clearLazyDestination(p)
  renameSync(previous, p.volume)
  return true
}

/** A command that ran (or was answered from the store), with the box's report after it. */
export interface ExecutedCommand {
  readonly outcome: CommandOutcome
  readonly vm: NestVmReport | null
}

export class VmManager {
  readonly outbox: Outbox
  private readonly meter: Meter
  private readonly volume: VolumeTool
  private readonly image: GuestImage
  private readonly records = new Map<string, VmRecord>()
  private readonly runtimes = new Map<string, Runtime>()
  private readonly queues = new Map<string, Promise<void>>()
  /** GPU each box is being given, from before its first await until the device is in the VMM and the guest is told. */
  private readonly gpuReservations = new Map<string, string>()
  private readonly timers: ReturnType<typeof setInterval>[] = []
  private leaseUntil = 0
  /** Bumped when the control socket closes. A command received under an older value may be resent by the control plane. */
  private connectionGeneration = 0
  /** Bumped when a lapse is first seen. A command received under an older value did not run under a valid lease. */
  private leaseGeneration = 0
  /** Whether the current lapse has already bumped `leaseGeneration`. The next lease clears it. */
  private lapseFenced = false
  /**
   * Outcomes the command store could not write. A command that already ran is answered from here on a resend, so it
   * does not run twice. Held in memory only: a restart loses them.
   */
  private readonly unrecorded = new Map<string, CommandOutcome>()

  constructor(
    private readonly config: HostConfig,
    private readonly layout: StateLayout,
    private readonly events: VmEvents,
  ) {
    this.image = readGuestImage(config.guestImageDir)
    this.volume = { tool: config.volumeTool, store: config.volumeStore, keyFile: config.volumeKeyFile }
    this.outbox = new Outbox(layout.meterDir)
    this.meter = new Meter(config.hostId, (record) => this.outbox.append([record]))
  }

  /**
   * Loads the guest firewall and the records, recovers every VM from its last state, builds the template and starts the
   * timers. Refuses to start when the firewall cannot be loaded or host memory pressure cannot be read: without the first
   * no guest could have a safe network, and without the second the memory policy has no signal.
   */
  async start(): Promise<void> {
    ensureStateDirs(this.layout)
    this.leaseUntil = readLeaseUntil(this.layout.leasePath) ?? 0
    const records = listVms(this.layout)
    await this.reloadFirewall(records.flatMap((record) => (record.network === null ? [] : [record.network])))
    readMemoryPressureAvg10()
    for (const record of records) this.records.set(record.boxId, record)
    for (const record of [...this.records.values()]) await this.recover(record)
    await buildTemplate({
      config: this.config,
      layout: this.layout,
      image: this.image,
      scope: this.config.scope,
      helloTimeoutMs: TEMPLATE_HELLO_TIMEOUT_MS,
    })
    const keep = new Set<string>([this.image.imageId])
    for (const vm of this.records.values()) if (vm.state === "running" || vm.state === "suspended") keep.add(vm.imageId)
    removeStaleTemplates(this.layout, keep)
    this.timers.push(setInterval(() => this.guarded("policy tick", () => this.tick()), GUEST_STATUS_INTERVAL_MS))
    this.timers.push(setInterval(() => this.guarded("meter tick", () => this.meterTick()), this.config.meterIntervalMs))
    let resyncing = false
    this.timers.push(
      setInterval(() => {
        if (resyncing) return
        resyncing = true
        void this.resyncFirewall()
          .catch((error: unknown) => this.events.error(`firewall resync failed: ${errorMessage(error)}`))
          .finally(() => {
            resyncing = false
          })
      }, GUEST_STATUS_INTERVAL_MS),
    )
  }

  /**
   * Replaces the guest firewall with the agent's ruleset, carrying the element of every live tap. The replacement is one
   * `nft -f` transaction, so no running tap is left without its anti-spoofing rule.
   */
  private async reloadFirewall(lives: readonly NestNetwork[]): Promise<void> {
    const path = join(this.layout.root, "firewall.nft")
    writeFileAtomic(path, firewallRuleset(lives))
    await runChecked("nft", ["-f", path])
  }

  /**
   * Checks the guest firewall every tick. An nftables service reload can flush the whole ruleset, or only `tap_addrs`,
   * while VMs keep running; a missing table or set, or a live tap without its element, reloads the complete firewall.
   * This runs with no live tap too: a new tap needs the tables.
   */
  private async resyncFirewall(): Promise<void> {
    const lives = [...this.records.values()].flatMap((record) => (record.network === null ? [] : [record.network]))
    const listing = await runTool("nft", tapAddrsListArgs)
    if (listing.status === 0 && missingTapAddrs(listing.stdout, lives).length === 0) return
    await this.reloadFirewall(lives)
    this.events.notice(
      listing.status === 0
        ? "reloaded the guest firewall: tap_addrs lacked the element of a live tap"
        : `reloaded the guest firewall: its tables were missing (${listing.stderr.trim()})`,
    )
  }

  /** A periodic task that throws must not stop its timer: the failure is reported and the next run tries again. */
  private guarded(what: string, task: () => void): void {
    try {
      task()
    } catch (error) {
      this.events.error(`${what} failed: ${errorMessage(error)}`)
    }
  }

  stop(): void {
    for (const timer of this.timers) clearInterval(timer)
    this.timers.length = 0
  }

  /**
   * Runs one control command for a box. A command already answered (same `commandId`) returns the stored outcome.
   * The outcome is stored until the control plane confirms it (`markReported`).
   *
   * A command received before the control connection dropped is refused with null: it did not run and has no outcome,
   * because the control plane resends it on the new connection. A command that was received while the lease was lapsed,
   * that was received before a lapse on a connection that stayed up, or that reaches execution while the lease is
   * lapsed, is refused with a failure and is not recorded, so the control plane learns of it at once and can re-place the
   * box. Whether the policy tick had already seen the lapse makes no difference. Neither refusal runs the command or stores
   * an outcome, so a later resend received under a valid lease runs fresh.
   */
  execute(commandId: string, command: NestHostCommand): Promise<ExecutedCommand | null> {
    const connection = this.connectionGeneration
    const lease = this.leaseGeneration
    const lapsedOnReceipt = Date.now() >= this.leaseUntil
    return this.serial(command.boxId, async () => {
      const stored = this.unrecorded.get(commandId) ?? findCommand(this.layout, commandId)
      if (stored !== null) return { outcome: stored, vm: this.reportOf(command.boxId) }
      if (connection !== this.connectionGeneration) return null
      if (lapsedOnReceipt || lease !== this.leaseGeneration || Date.now() >= this.leaseUntil) {
        const outcome: CommandOutcome = {
          commandId,
          boxId: command.boxId,
          ok: false,
          error: NEST_LAPSE_REFUSAL,
          reported: false,
        }
        return { outcome, vm: this.reportOf(command.boxId) }
      }
      return this.applyCommand(commandId, command)
    })
  }

  /** Runs one command from the local operator socket. A dropped control link does not refuse it: the operator asked here. */
  executeOperator(commandId: string, command: NestHostCommand): Promise<ExecutedCommand> {
    return this.serial(command.boxId, () => this.applyCommand(commandId, command))
  }

  private async applyCommand(commandId: string, command: NestHostCommand): Promise<ExecutedCommand> {
    if (!isBoxId(command.boxId)) {
      const outcome: CommandOutcome = { commandId, boxId: command.boxId, ok: false, error: "invalid box id", reported: false }
      this.recordOutcome(outcome)
      return { outcome, vm: null }
    }
    let outcome: CommandOutcome
    try {
      await this.apply(command)
      outcome = { commandId, boxId: command.boxId, ok: true, reported: false }
    } catch (error) {
      await this.failOperation(command.boxId, error)
      outcome = { commandId, boxId: command.boxId, ok: false, error: errorMessage(error), reported: false }
    }
    this.recordOutcome(outcome)
    return { outcome, vm: this.reportOf(command.boxId) }
  }

  /** Stores an outcome. When the store cannot be written, the outcome is kept in memory and the failure is reported. */
  private recordOutcome(outcome: CommandOutcome): void {
    try {
      recordCommand(this.layout, outcome)
    } catch (error) {
      this.unrecorded.set(outcome.commandId, outcome)
      this.events.error(`cannot record command ${outcome.commandId}; kept in memory: ${errorMessage(error)}`)
    }
  }

  pendingResults(): CommandOutcome[] {
    return [...this.storedPending(), ...[...this.unrecorded.values()].filter((outcome) => !outcome.reported)]
  }

  /** The unreported outcomes on disk. A store that cannot be read reports none, and says so. */
  private storedPending(): CommandOutcome[] {
    try {
      return pendingCommands(this.layout)
    } catch (error) {
      this.events.error(`cannot read the command store: ${errorMessage(error)}`)
      return []
    }
  }

  /**
   * The control plane has the outcome. An unrecorded outcome stays in memory for dedupe, since a resend must still find
   * it; it only stops being pending.
   */
  markReported(commandIds: readonly string[]): void {
    for (const id of commandIds) {
      const held = this.unrecorded.get(id)
      if (held !== undefined) this.unrecorded.set(id, { ...held, reported: true })
    }
    try {
      markCommandsReported(this.layout, commandIds)
    } catch (error) {
      this.events.error(`cannot mark commands reported: ${errorMessage(error)}`)
    }
  }

  /** Every VM this host holds, except destroyed or evicted ones. */
  reports(): NestVmReport[] {
    return [...this.records.values()].filter((vm) => vm.state !== "deleted").map((vm) => this.report(vm))
  }

  capacity(): NestHostCapacity {
    const vms = [...this.records.values()].filter((vm) => vm.state !== "deleted")
    const running = vms.filter((vm) => vm.state === "running")
    const runningMemoryBytes = running.reduce((sum, vm) => sum + vm.memoryBytes, 0)
    return {
      vcpus: this.config.capacity.vcpus,
      vcpusPlugged: running.reduce((sum, vm) => sum + vm.vcpus, 0),
      memoryBytes: this.config.capacity.memoryBytes,
      memoryPluggedBytes: runningMemoryBytes,
      diskFreeBytes: diskFreeBytes({ availableBytes: this.availableDiskBytes(), runningMemoryBytes }),
      diskReservedBytes: runningMemoryBytes,
      gpus: this.config.gpus.map((gpu) => ({
        pciAddress: gpu.pciAddress,
        model: gpu.model,
        vramBytes: gpu.vramBytes,
        attachedTo: vms.find((vm) => vm.gpus.includes(gpu.pciAddress))?.boxId ?? null,
      })),
      running: running.length,
      suspended: vms.filter((vm) => vm.state === "suspended").length,
    }
  }

  setLease(validUntil: number): void {
    // Written first: a lease that fails to persist changes nothing here, so a failed renewal leaves the lapse state alone.
    writeLeaseUntil(this.layout.leasePath, validUntil)
    // A lease that lapsed while no policy tick ran still ends its window here, before the renewal can let old commands run.
    if (!this.lapseFenced && Date.now() >= this.leaseUntil) this.leaseGeneration += 1
    this.lapseFenced = false
    this.leaseUntil = validUntil
  }

  /** The control socket closed: queued commands are refused at execution, since the control plane resends them on reconnect. */
  connectionLost(): void {
    this.connectionGeneration += 1
  }

  reportActivity(boxes: readonly IngressActivity[]): void {
    for (const box of boxes) {
      if (!this.records.has(box.boxId)) continue
      this.runtime(box.boxId).ingress = { openConnections: box.openConnections, lastRequestAt: box.lastRequestAt }
    }
  }

  /** Where ingress sends a box's requests: its upstream while running, else null. */
  route(boxId: string): { state: NestVmState; upstream: string | null } {
    const vm = this.records.get(boxId)
    if (vm === undefined || vm.state === "deleted") throw new UnknownBoxError(`unknown box ${boxId}`)
    return { state: vm.state, upstream: vm.state === "running" ? this.upstreamOf(vm) : null }
  }

  /**
   * Brings a box to `running` for an ingress request and answers with its upstream. A suspended box is resumed here
   * while the control plane's lease is valid; otherwise the control plane is asked and this waits for its `resume`.
   */
  async wake(boxId: string): Promise<string> {
    const vm = this.records.get(boxId)
    if (vm === undefined || vm.state === "deleted") throw new UnknownBoxError(`unknown box ${boxId}`)
    if (vm.state === "running") return this.upstreamOf(vm)
    let requested = false
    if (vm.state === "suspended" && Date.now() < this.leaseUntil) {
      void this.enqueue(boxId, () => this.resumeSuspendedBox(boxId))
    } else {
      this.events.wakeRequest(boxId)
      requested = true
    }
    const deadline = Date.now() + WAKE_TIMEOUT_MS
    for (;;) {
      const current = this.records.get(boxId)
      if (current === undefined || current.state === "deleted") throw new UnknownBoxError(`box ${boxId} was deleted`)
      if (current.state === "running") return this.upstreamOf(current)
      if (current.state === "parked" && !requested) {
        // The lease resume left the box parked (it could not resume): ask the control plane once.
        this.events.wakeRequest(boxId)
        requested = true
      }
      if (Date.now() >= deadline) throw new WakeTimeoutError(`box ${boxId} did not wake within ${WAKE_TIMEOUT_MS} ms`)
      await sleep(WAKE_POLL_MS)
    }
  }

  private paths(boxId: string): VmPathSet {
    return vmPaths(this.layout, boxId)
  }

  private runtime(boxId: string): Runtime {
    let rt = this.runtimes.get(boxId)
    if (rt === undefined) {
      rt = newRuntime()
      this.runtimes.set(boxId, rt)
    }
    return rt
  }

  private commit(vm: VmRecord): VmRecord {
    const previous = this.records.get(vm.boxId)
    const transition = previous === undefined || previous.state !== vm.state || previous.gpus.length !== vm.gpus.length
    const now = Date.now()
    // The old state is sampled just before it changes and the new one right after, so no meter interval mixes two states.
    if (transition && previous !== undefined) this.meterSample(previous, now)
    writeVm(this.layout, vm)
    this.records.set(vm.boxId, vm)
    if (vm.state !== "deleted") this.events.vm(this.report(vm))
    if (transition) this.meterSample(vm, now)
    if (vm.state === "deleted") this.meter.forget(vm.boxId)
    return vm
  }

  /** Samples one VM for the meter. Provisioning is not metered; a deleted VM's final sample is its last lifecycle record. */
  private meterSample(vm: VmRecord, nowMs: number): void {
    if (vm.state === "provisioning") return
    const p = this.paths(vm.boxId)
    this.meter.tick(
      {
        boxId: vm.boxId,
        vmId: vm.vmId,
        userId: vm.userId,
        state: vm.state,
        gpus: vm.gpus.length,
        cgroupDir: vm.process === null ? null : cgroupDirOf(vm.process.pid),
        volumePath: existsSync(p.volume) ? p.volume : null,
      },
      nowMs,
    )
  }

  private begin(vm: VmRecord, kind: Operation["kind"], from: Operation["from"]): VmRecord {
    return this.commit({ ...vm, operation: { kind, from, startedAt: Date.now() } })
  }

  private finish(vm: VmRecord, state: NestVmState, patch: Partial<VmRecord>): VmRecord {
    return this.commit({
      ...vm,
      lastError: null,
      ...patch,
      state,
      since: state === vm.state ? vm.since : enteredAt(vm.since),
      operation: null,
    })
  }

  private report(vm: VmRecord): NestVmReport {
    const running = vm.state === "running"
    return {
      boxId: vm.boxId,
      vmId: vm.vmId,
      userId: vm.userId,
      ownerEpoch: vm.ownerEpoch,
      state: vm.state,
      since: vm.since,
      imageId: vm.imageId,
      vcpus: running ? vm.vcpus : 0,
      memoryBytes: running ? vm.memoryBytes : 0,
      gpus: [...vm.gpus],
      diskBytes: this.diskBytesOf(vm),
      volumeRef: vm.volumeRef,
      backedUpAt: vm.backedUpAt,
      limits: vm.limits,
    }
  }

  private reportOf(boxId: string): NestVmReport | null {
    const vm = this.records.get(boxId)
    return vm === undefined || vm.state === "deleted" ? null : this.report(vm)
  }

  /** The owner epoch this host holds for a box, or null when it holds none. */
  epochOf(boxId: string): number | null {
    const vm = this.records.get(boxId)
    return vm === undefined || vm.state === "deleted" ? null : vm.ownerEpoch
  }

  private diskBytesOf(vm: VmRecord): number {
    const p = this.paths(vm.boxId)
    let bytes = allocatedBytes(p.volume) + allocatedBytes(p.swap)
    if (vm.snapshotGen !== null) {
      for (const name of SNAPSHOT_FILES) bytes += allocatedBytes(join(p.snapshot(vm.snapshotGen), name))
    }
    return bytes
  }

  private upstreamOf(vm: VmRecord): string {
    if (vm.network === null) throw new HostError(`box ${vm.boxId} has no network`)
    return `http://${vm.network.address}:${BOX_PORT}`
  }

  private availableDiskBytes(): number {
    const stats = statfsSync(this.config.stateDir)
    return Number(stats.bavail) * Number(stats.bsize)
  }

  private isDiskTight(): boolean {
    const runningMemoryBytes = [...this.records.values()]
      .filter((vm) => vm.state === "running")
      .reduce((sum, vm) => sum + vm.memoryBytes, 0)
    return diskTight(diskFreeBytes({ availableBytes: this.availableDiskBytes(), runningMemoryBytes }))
  }

  private usedSlots(): Set<number> {
    const slots = new Set<number>()
    for (const vm of this.records.values()) if (vm.network !== null) slots.add(vm.network.slot)
    return slots
  }

  private validateLimits(limits: NestLimits): void {
    if (limits.maxVcpus > this.config.template.maxVcpus) {
      throw new HostError(`maxVcpus ${limits.maxVcpus} exceeds the template limit ${this.config.template.maxVcpus}`)
    }
    if (limits.maxMemoryBytes > this.config.template.maxMemoryBytes) {
      throw new HostError(
        `maxMemoryBytes ${limits.maxMemoryBytes} exceeds the template limit ${this.config.template.maxMemoryBytes}`,
      )
    }
  }

  private restoreTarget(vm: VmRecord, network: NestNetwork, p: VmPathSet): RestoreTarget {
    return {
      tap: network.tap,
      cid: network.cid,
      vsockSocket: p.vsockSocket,
      consoleFile: p.console,
      volumePath: vm.volumeProcess?.device ?? p.volume,
      swapPath: p.swap,
    }
  }

  private launch(vm: VmRecord): ProcessRef {
    return launchVmm({
      scope: this.config.scope,
      unit: vmUnitName(vm.boxId),
      chPath: this.config.cloudHypervisor,
      apiSocket: this.paths(vm.boxId).apiSocket,
      memoryMaxBytes: vm.limits.maxMemoryBytes + VMM_OVERHEAD_BYTES,
      logPath: this.paths(vm.boxId).console,
    })
  }

  private attachLink(boxId: string, link: GuestLink): void {
    const rt = this.runtime(boxId)
    rt.link = link
    link.onFrame((frame) => {
      if (frame._tag === "status") {
        rt.status = { pressure: frame.pressure, activity: frame.activity, at: Date.now() }
      } else if (frame._tag === "gpuWanted") {
        void this.serial(boxId, () => this.decideGpu(boxId, frame.id, frame.wanted))
      }
    })
    link.onClose(() => {
      if (rt.link !== link) return
      rt.link = null
      rt.status = null
      this.reconnectLink(boxId, RECONNECT_MIN_MS)
    })
  }

  /** Reconnects a running box's guest link, doubling the wait after each failure, until the box stops running. */
  private reconnectLink(boxId: string, delayMs: number): void {
    setTimeout(() => {
      const vm = this.running(boxId)
      if (vm === null) return
      const rt = this.runtime(boxId)
      if (rt.link !== null) return
      if (vm.operation !== null) {
        this.reconnectLink(boxId, delayMs)
        return
      }
      connectGuest(this.paths(boxId).vsockSocket, CONNECT_TIMEOUT_MS)
        .then(({ link }) => {
          if (this.running(boxId) === null) link.close()
          else this.attachLink(boxId, link)
        })
        .catch(() => this.reconnectLink(boxId, Math.min(delayMs * 2, RECONNECT_MAX_MS)))
    }, delayMs)
  }

  private closeLink(boxId: string): void {
    const rt = this.runtimes.get(boxId)
    if (rt === undefined || rt.link === null) return
    const link = rt.link
    rt.link = null
    link.close()
  }

  private async ask(rt: Runtime, frame: HostToGuest, timeoutMs: number): Promise<void> {
    if (rt.link === null || rt.link.isClosed()) throw new HostError("guest agent is not connected")
    const reply = await rt.link.request(frame, timeoutMs)
    if (!reply.ok) throw new HostError(`guest refused ${frame._tag}: ${reply.error ?? "no reason given"}`)
  }

  private async tryAsk(rt: Runtime, frame: HostToGuest, timeoutMs: number): Promise<boolean> {
    try {
      await this.ask(rt, frame, timeoutMs)
      return true
    } catch {
      return false
    }
  }

  /** Serializes work on one box: commands and the host's own policy actions run one at a time. */
  private serial<T>(boxId: string, action: () => Promise<T>): Promise<T> {
    const run = (this.queues.get(boxId) ?? Promise.resolve()).then(action)
    const tail = run.then(
      () => undefined,
      () => undefined,
    )
    this.queues.set(boxId, tail)
    void tail.then(() => {
      if (this.queues.get(boxId) === tail) this.queues.delete(boxId)
    })
    return run
  }

  /** Runs a host-initiated action for a box. A failure is recorded on the box, not thrown. */
  private enqueue(boxId: string, action: () => Promise<void>): Promise<void> {
    return this.serial(boxId, async () => {
      try {
        await action()
      } catch (error) {
        const vm = this.records.get(boxId)
        if (vm?.operation) await this.failOperation(boxId, error)
        else if (vm !== undefined) this.commit({ ...vm, lastError: errorMessage(error) })
      }
    })
  }

  /** Schedules a policy action unless the box already has one pending. */
  private schedule(boxId: string, action: () => Promise<void>): void {
    const rt = this.runtime(boxId)
    if (rt.busy) return
    rt.busy = true
    void this.enqueue(boxId, action).finally(() => {
      rt.busy = false
    })
  }

  /** A command or action that fails mid-operation leaves the VM in the state it can be resumed from. */
  private async failOperation(boxId: string, error: unknown): Promise<void> {
    const vm = this.records.get(boxId)
    if (vm === undefined || vm.state === "deleted" || vm.operation === null) return
    await this.failTo(boxId, vm.operation.kind === "create" ? "deleted" : "parked", error)
  }

  private async failTo(boxId: string, state: "parked" | "deleted", error: unknown): Promise<void> {
    const vm = this.records.get(boxId)
    if (vm === undefined) return
    const released = await this.releaseVm(vm)
    if (state === "deleted") {
      clearArtifacts(this.paths(boxId).dir)
      this.finish(released, "deleted", {
        volumeRef: null,
        backedUpAt: null,
        localRef: null,
        localDirty: false,
        tombstone: "destroy",
        lastError: errorMessage(error),
      })
      return
    }
    this.finish(released, "parked", { lastError: errorMessage(error) })
  }

  /** Stops everything a VM runs (VMM, volume service, tap, memory image). The record is returned, not committed. */
  private async releaseVm(vm: VmRecord): Promise<VmRecord> {
    const p = this.paths(vm.boxId)
    this.closeLink(vm.boxId)
    await stopVmmProcess(vm.process, p.apiSocket, VMM_STOP_GRACE_MS)
    if (vm.volumeProcess !== null) await terminateProcess(vm.volumeProcess.process, VOLUME_STOP_GRACE_MS)
    if (vm.network !== null) await tapDown(vm.network)
    rmSync(p.restore, { recursive: true, force: true })
    if (vm.snapshotGen !== null) rmSync(p.snapshot(vm.snapshotGen), { recursive: true, force: true })
    return { ...vm, process: null, network: null, volumeProcess: null, snapshotGen: null, gpus: [], gpuAttachedAt: null, frozen: false }
  }

  private async apply(command: NestHostCommand): Promise<void> {
    switch (command._tag) {
      case "create":
        return this.create(command)
      case "resume":
        return this.resumeCommand(command)
      case "suspend":
        return this.suspendCommand(command)
      case "park":
        return this.parkCommand(command)
      case "setLimits":
        return this.setLimitsCommand(command)
      case "gpuAttach":
        return this.gpuAttachCommand(command)
      case "gpuDetach":
        return this.gpuDetachCommand(command)
      case "destroy":
        return this.destroy(command)
      case "evict":
        return this.evict(command)
    }
  }

  private async create(cmd: Command<"create">): Promise<void> {
    if (Date.now() >= this.leaseUntil) throw new HostError("the control plane lease has lapsed; a box is not created without a valid lease")
    const existing = this.records.get(cmd.boxId)
    if (existing !== undefined && existing.state !== "deleted") {
      if (cmd.ownerEpoch !== existing.ownerEpoch) {
        throw new HostError(`box ${cmd.boxId} lives on this host at epoch ${existing.ownerEpoch}`)
      }
      // A resent create carries the newest enrollment token: a running guest takes it now; any other box takes it on resume.
      if (existing.state === "running") await this.configureGuest(existing, cmd.enrollToken)
      return
    }
    this.validateLimits(cmd.limits)
    const network = networkForSlot(allocateSlot(this.usedSlots()))
    const p = this.paths(cmd.boxId)
    const fresh = createNewRecord({
      boxId: cmd.boxId,
      vmId: cmd.vmId,
      userId: cmd.userId,
      ownerEpoch: cmd.ownerEpoch,
      imageId: this.image.imageId,
      publicUrl: cmd.publicUrl,
      limits: cmd.limits,
      volumeRef: null,
      localDirty: true,
      state: "provisioning",
    })
    let vm = this.begin(fresh, "create", null)
    vm = this.commit({ ...vm, network })
    rmSync(p.volume, { force: true })
    await createVolume(this.volume, p.volume, cmd.limits.volumeBytes)
    await this.bootClone(vm, cmd.enrollToken)
  }

  private async resumeCommand(cmd: Command<"resume">): Promise<void> {
    if (Date.now() >= this.leaseUntil) throw new HostError("the control plane lease has lapsed; a box is not resumed without a valid lease")
    this.validateLimits(cmd.limits)
    const current = this.records.get(cmd.boxId)
    if (current !== undefined && current.state !== "deleted" && cmd.ownerEpoch < current.ownerEpoch) {
      throw new HostError(`resume epoch ${cmd.ownerEpoch} is older than this host's copy (${current.ownerEpoch})`)
    }
    let vm: VmRecord
    if (current === undefined || current.state === "deleted") {
      vm = createNewRecord({
        boxId: cmd.boxId,
        vmId: cmd.vmId,
        userId: cmd.userId,
        ownerEpoch: cmd.ownerEpoch,
        imageId: this.image.imageId,
        publicUrl: cmd.publicUrl,
        limits: cmd.limits,
        volumeRef: cmd.volumeRef,
        localDirty: false,
        state: "parked",
      })
    } else if (cmd.ownerEpoch > current.ownerEpoch) {
      // The local volume is the previous owner's copy: the new owner's backup (cmd.volumeRef) is the only source.
      // Refuse before releasing or deleting anything when there is no source, or the only copy would be lost.
      if (cmd.volumeRef === null) {
        throw new HostError(`cannot resume box ${cmd.boxId} at epoch ${cmd.ownerEpoch}: no volume backup to restore`)
      }
      const released = await this.releaseVm(current)
      vm = this.commit({
        ...released,
        state: "parked",
        since: enteredAt(released.since),
        ownerEpoch: cmd.ownerEpoch,
        vmId: cmd.vmId,
        userId: cmd.userId,
        limits: cmd.limits,
        publicUrl: cmd.publicUrl,
        volumeRef: cmd.volumeRef,
        localRef: null,
        operation: null,
        localDirty: false,
      })
    } else if (current.state === "running") {
      if (cmd.enrollToken !== null) await this.configureGuest(current, cmd.enrollToken)
      return
    } else {
      vm = this.commit({
        ...current,
        vmId: cmd.vmId,
        limits: cmd.limits,
        publicUrl: cmd.publicUrl,
        volumeRef: cmd.volumeRef,
      })
    }
    if (vm.state === "suspended") {
      await this.resumeSuspended(vm, cmd.enrollToken)
      return
    }
    await this.resumeParked(vm, cmd.enrollToken)
  }

  private async resumeSuspendedBox(boxId: string): Promise<void> {
    const vm = this.records.get(boxId)
    if (vm?.state === "suspended") await this.resumeSuspended(vm, null)
  }

  private async resumeParked(vm: VmRecord, enrollToken: string | null): Promise<void> {
    const p = this.paths(vm.boxId)
    let cur = this.begin(vm, "resume", "parked")
    // A crash may have left the only local copy at `volume.raw.previous`; put it back before deciding what is usable.
    const hadLocal = restorePreviousVolume(p)
    // Unbacked local changes make the local volume the only copy. Otherwise it is usable only when it matches the backup this command restores.
    const usableLocal = hadLocal && (cur.localDirty || (cur.volumeRef !== null && cur.localRef === cur.volumeRef))
    if (!usableLocal) {
      if (cur.volumeRef === null) throw new HostError("no local volume and no backup to restore it from")
      // Keep the only local copy until the lazy restore has opened its source: a manifest can be missing or unreadable,
      // and the restore fails before it serves a byte. Only a successful open makes the backup authoritative.
      const previous = `${p.volume}.previous`
      rmSync(`${p.volume}.bitmap`, { force: true })
      rmSync(`${p.volume}.lock`, { force: true })
      if (hadLocal) renameSync(p.volume, previous)
      const lazy = await startLazyVolume(
        this.volume,
        { ref: cur.volumeRef, boxId: cur.boxId, dest: p.volume, logPath: join(p.dir, "volume.log") },
        LAZY_VOLUME_TIMEOUT_MS,
      ).catch((error: unknown) => {
        // The restore never opened the backup (for example its manifest is gone). Revert the destination and put the
        // local copy back: it is still the only data.
        clearLazyDestination(p)
        if (hadLocal) renameSync(previous, p.volume)
        throw error
      })
      rmSync(previous, { recursive: true, force: true })
      cur = this.commit({ ...cur, volumeProcess: lazy })
    } else if (cur.volumeProcess !== null) {
      cur = this.commit({ ...cur, volumeProcess: null })
    }
    cur = this.commit({ ...cur, network: networkForSlot(allocateSlot(this.usedSlots())) })
    await this.bootClone(cur, enrollToken)
  }

  /**
   * Restores the memory image, then hands the box its newest enrollment token. If the restore fails, boots a template
   * clone on the same volume with that token.
   */
  private async resumeSuspended(vm: VmRecord, enrollToken: string | null): Promise<void> {
    const begun = this.begin(vm, "resume", "suspended")
    try {
      await this.restoreMemoryImage(begun)
    } catch (restoreError) {
      const p = this.paths(vm.boxId)
      this.closeLink(vm.boxId)
      const current = this.records.get(vm.boxId) ?? begun
      if (current.process !== null) await stopVmmProcess(current.process, p.apiSocket, VMM_STOP_GRACE_MS)
      rmSync(p.restore, { recursive: true, force: true })
      if (current.snapshotGen !== null) rmSync(p.snapshot(current.snapshotGen), { recursive: true, force: true })
      const fallback = this.commit({ ...current, process: null, snapshotGen: null })
      try {
        await this.bootClone(fallback, enrollToken)
      } catch (cloneError) {
        throw new HostError(
          `restore failed (${errorMessage(restoreError)}); clone fallback failed (${errorMessage(cloneError)})`,
        )
      }
      return
    }
    const restored = this.running(vm.boxId)
    if (enrollToken !== null && restored !== null) await this.configureGuest(restored, enrollToken)
  }

  private async restoreMemoryImage(vm: VmRecord): Promise<void> {
    const p = this.paths(vm.boxId)
    const rt = this.runtime(vm.boxId)
    const { network, snapshotGen: gen } = vm
    if (network === null || gen === null) throw new HostError("suspended box has no memory image")
    await prepareRestoreDir({
      sourceDir: p.snapshot(gen),
      restoreDir: p.restore,
      target: this.restoreTarget(vm, network, p),
    })
    const identity = this.launch(vm)
    const started = this.commit({ ...vm, process: identity })
    await waitForApi(p.apiSocket, identity, API_TIMEOUT_MS)
    const client = new ChClient(p.apiSocket)
    await client.restore(p.restore, restoreMode())
    await client.resume()
    const { link } = await connectGuest(p.vsockSocket, CONNECT_TIMEOUT_MS)
    this.attachLink(started.boxId, link)
    await this.ask(rt, { _tag: "resumed", id: newRequestId(), wallClockMs: Date.now() }, GUEST_REPLY_TIMEOUT_MS.resumed)
    this.finish(started, "running", { localRef: null, localDirty: true })
  }

  /**
   * Boots a template clone on the VM's volume (local file or lazily served device), attaches the disks, and sends
   * `configure`. The VM ends `running`.
   */
  private async bootClone(vm: VmRecord, enrollToken: string | null): Promise<void> {
    const { config } = this
    const p = this.paths(vm.boxId)
    const rt = this.runtime(vm.boxId)
    const { network } = vm
    if (network === null) throw new HostError("VM has no network slot")
    await tapDown(network)
    await runNetCommands(tapUpCommands(network, config.egressMbit))
    await prepareRestoreDir({
      sourceDir: templateDir(this.layout, this.image.imageId),
      restoreDir: p.restore,
      target: this.restoreTarget(vm, network, p),
    })
    createSparse(p.swap, SWAP_BYTES)
    const identity = this.launch(vm)
    const started = this.commit({ ...vm, process: identity, cloneId: newCloneId() })
    await waitForApi(p.apiSocket, identity, API_TIMEOUT_MS)
    const client = new ChClient(p.apiSocket)
    await client.restore(p.restore, restoreMode())
    await client.resume()
    await client.addDisk({
      path: vm.volumeProcess?.device ?? p.volume,
      id: "volume",
      serial: NEST_VOLUME_SERIAL,
      readonly: false,
      direct: true,
      num_queues: TEMPLATE_BOOT_VCPUS,
      image_type: "Raw",
    })
    await client.addDisk({ path: p.swap, id: "swap", serial: NEST_SWAP_SERIAL, readonly: false, direct: false, num_queues: 1, image_type: "Raw" })
    const { link } = await connectGuest(p.vsockSocket, CONNECT_TIMEOUT_MS)
    this.attachLink(started.boxId, link)
    await this.configureGuest(started, enrollToken)
    this.finish(started, "running", {
      vcpus: TEMPLATE_BOOT_VCPUS,
      memoryBytes: TEMPLATE_BOOT_MEMORY_BYTES,
      localRef: null,
      localDirty: true,
    })
  }

  /**
   * Sends `configure` to a running VM's guest. Idempotent: a token replaces the one in the guest's env file.
   */
  private async configureGuest(vm: VmRecord, enrollToken: string | null): Promise<void> {
    const { config } = this
    const { network, cloneId } = vm
    if (network === null || cloneId === null) throw new HostError(`box ${vm.boxId} has no clone to configure`)
    await this.ask(
      this.runtime(vm.boxId),
      {
        _tag: "configure",
        id: newRequestId(),
        hostId: config.hostId,
        boxId: vm.boxId,
        vmId: vm.vmId,
        cloneId,
        wallClockMs: Date.now(),
        controlUrl: config.controlUrl,
        publicUrl: vm.publicUrl,
        enrollToken,
        network: guestNetwork(network, {
          depcacheUrl: config.depcacheUrl,
          nixCacheUrl: config.nixCacheUrl,
          nixCachePublicKey: config.nixCachePublicKey,
        }),
      },
      GUEST_REPLY_TIMEOUT_MS.configure,
    )
  }

  /**
   * Quiesces a running VM for a suspend or park: the freeze is recorded, then the guest syncs and freezes its volume and
   * the VMM pauses. A refused or timed-out step ends the freeze and clears the operation before the error propagates, so
   * the VM keeps running (or is stopped, if the guest cannot thaw).
   */
  private async quiesce(cur: VmRecord): Promise<VmRecord> {
    const frozen = this.commit({ ...cur, frozen: true })
    try {
      await this.ask(this.runtime(cur.boxId), { _tag: "prepareSuspend", id: newRequestId() }, GUEST_REPLY_TIMEOUT_MS.prepareSuspend)
      await new ChClient(this.paths(cur.boxId).apiSocket).pause()
      return frozen
    } catch (error) {
      const reason = `aborted: ${errorMessage(error)}`
      if (await this.thawOrStop(cur.boxId, reason)) this.finish(this.records.get(cur.boxId) ?? frozen, "running", { lastError: reason })
      throw error
    }
  }

  /**
   * Ends an unfinished freeze with thawVolume. A guest that does not thaw is stopped and parked on its local volume; the
   * caller must then stop its operation. Returns true when the VM stays running.
   */
  private async thawOrStop(boxId: string, reason: string): Promise<boolean> {
    const vm = this.records.get(boxId)
    if (vm === undefined || !vm.frozen) return true
    const thawed = await this.tryAsk(this.runtime(boxId), { _tag: "thawVolume", id: newRequestId() }, GUEST_REPLY_TIMEOUT_MS.thawVolume)
    if (thawed) {
      this.commit({ ...vm, frozen: false })
      return true
    }
    await this.failTo(boxId, "parked", new HostError(`${reason}; the guest did not thaw its volume, so the VM was stopped`))
    return false
  }

  /** Brings a running VM to `suspended`: detach GPUs, quiesce, snapshot, stop the VMM. */
  private async suspend(vm: VmRecord): Promise<void> {
    const p = this.paths(vm.boxId)
    let cur = this.begin(vm, "suspend", null)
    cur = await this.detachGpus(cur)
    cur = await this.quiesce(cur)
    const client = new ChClient(p.apiSocket)
    const gen = (cur.snapshotGen ?? 0) + 1
    const dir = p.snapshot(gen)
    // Written under a staging name and renamed once durable, so a torn snapshot is never taken for a memory image.
    const staging = `${dir}.tmp`
    rmSync(staging, { recursive: true, force: true })
    mkdirSync(staging, { recursive: true, mode: 0o700 })
    await client.snapshot(staging)
    for (const name of [...SNAPSHOT_FILES, "config.json"]) fsyncPath(join(staging, name))
    fsyncDir(staging)
    rmSync(dir, { recursive: true, force: true })
    renameSync(staging, dir)
    fsyncDir(p.dir)
    this.closeLink(vm.boxId)
    await stopVmmProcess(cur.process, p.apiSocket, VMM_STOP_GRACE_MS)
    rmSync(p.restore, { recursive: true, force: true })
    // The VMM that was restored from the previous generation has now exited, so that image is no longer read.
    if (cur.snapshotGen !== null) rmSync(p.snapshot(cur.snapshotGen), { recursive: true, force: true })
    this.finish(cur, "suspended", { process: null, snapshotGen: gen, gpus: [], gpuAttachedAt: null, frozen: false })
  }

  /**
   * Quiesces a running VM as for suspend, stops its VMM, then backs its volume up and releases the rest. A lazy volume is
   * copied from its device, before its service stops, so the backup holds what the guest wrote.
   */
  private async park(vm: VmRecord): Promise<void> {
    const p = this.paths(vm.boxId)
    let cur = this.begin(vm, "park", null)
    if (cur.state === "running") {
      cur = await this.detachGpus(cur)
      cur = await this.quiesce(cur)
    }
    this.closeLink(vm.boxId)
    await stopVmmProcess(cur.process, p.apiSocket, VMM_STOP_GRACE_MS)
    cur = { ...cur, process: null }
    const ref = await backupVolume(this.volume, { path: cur.volumeProcess?.device ?? p.volume, boxId: vm.boxId })
    cur = await this.releaseVm(cur)
    this.finish(cur, "parked", {
      volumeRef: ref.volumeRef,
      backedUpAt: Date.now(),
      localRef: ref.volumeRef,
      localDirty: false,
    })
  }

  private async destroy(cmd: Command<"destroy">): Promise<void> {
    const vm = this.records.get(cmd.boxId)
    if (vm === undefined) return
    // A tombstone that still holds its backup ref was either interrupted mid-destroy (finish the wipe) or left by
    // `evict`, which keeps the backup for the box's new owner. A tombstone from `evict` is never wiped by a destroy,
    // whatever epoch the command carries: a late duplicate from the old epoch matches the tombstone's own epoch.
    if (vm.state === "deleted") {
      if (vm.volumeRef !== null && vm.tombstone !== "evict" && vm.ownerEpoch === cmd.ownerEpoch) {
        await deleteVolumeStore(this.volume, cmd.boxId)
        this.finish(vm, "deleted", { volumeRef: null, backedUpAt: null, tombstone: "destroy" })
      }
      return
    }
    if (vm.ownerEpoch !== cmd.ownerEpoch) {
      throw new HostError(`box ${cmd.boxId} is at epoch ${vm.ownerEpoch}, not ${cmd.ownerEpoch}`)
    }
    let cur = this.begin(vm, "destroy", null)
    cur = await this.releaseVm(cur)
    if (cur.volumeRef !== null) await deleteVolumeStore(this.volume, cmd.boxId)
    clearArtifacts(this.paths(cmd.boxId).dir)
    this.finish(cur, "deleted", {
      volumeRef: null,
      backedUpAt: null,
      localRef: null,
      localDirty: false,
      tombstone: "destroy",
    })
  }

  /** The box lives elsewhere now: drop local state, keep backups, and stop reporting it. */
  private async evict(cmd: Command<"evict">): Promise<void> {
    const vm = this.records.get(cmd.boxId)
    if (vm === undefined || vm.state === "deleted") return
    if (vm.ownerEpoch >= cmd.ownerEpoch) {
      throw new HostError(`evict epoch ${cmd.ownerEpoch} is not newer than this host's copy (${vm.ownerEpoch})`)
    }
    // The cause is recorded before anything is released: a crash mid-evict must recover as an evict tombstone, whose
    // backup belongs to the box's new owner, not as a destroy whose late resend may wipe it.
    let cur = this.begin({ ...vm, tombstone: "evict" }, "destroy", null)
    cur = await this.releaseVm(cur)
    clearArtifacts(this.paths(cmd.boxId).dir)
    this.finish(cur, "deleted", { localRef: null, localDirty: false, tombstone: "evict" })
  }

  /** The VM this host holds for a box at exactly the command's owner epoch; a command for any other epoch is refused. */
  private heldAt(boxId: string, ownerEpoch: number): VmRecord {
    const vm = this.records.get(boxId)
    if (vm === undefined || vm.state === "deleted") throw new HostError(`no VM for box ${boxId}`)
    if (vm.ownerEpoch !== ownerEpoch) {
      throw new HostError(`box ${boxId} is at epoch ${vm.ownerEpoch}, not ${ownerEpoch}`)
    }
    return vm
  }

  private async suspendCommand(cmd: Command<"suspend">): Promise<void> {
    const vm = this.heldAt(cmd.boxId, cmd.ownerEpoch)
    if (vm.state === "suspended") return
    if (vm.state !== "running") throw new HostError(`cannot suspend a ${vm.state} box`)
    await this.suspend(vm)
  }

  private async parkCommand(cmd: Command<"park">): Promise<void> {
    const vm = this.heldAt(cmd.boxId, cmd.ownerEpoch)
    if (vm.state === "parked") return
    if (vm.state !== "running" && vm.state !== "suspended") throw new HostError(`cannot park a ${vm.state} box`)
    await this.park(vm)
  }

  private async setLimitsCommand(cmd: Command<"setLimits">): Promise<void> {
    this.validateLimits(cmd.limits)
    let cur = this.commit({ ...this.heldAt(cmd.boxId, cmd.ownerEpoch), limits: cmd.limits })
    if (cur.state !== "running") return
    if (cmd.limits.gpu === "none") cur = await this.detachGpus(cur)
    const vcpus = Math.min(cur.vcpus, cmd.limits.maxVcpus)
    const memoryBytes = Math.min(cur.memoryBytes, cmd.limits.maxMemoryBytes)
    if (vcpus !== cur.vcpus || memoryBytes !== cur.memoryBytes) await this.resizeVm(cur, { vcpus, memoryBytes })
  }

  private async gpuAttachCommand(cmd: Command<"gpuAttach">): Promise<void> {
    const vm = this.heldAt(cmd.boxId, cmd.ownerEpoch)
    if (vm.state !== "running") throw new HostError(`cannot attach a GPU to a ${vm.state} box`)
    if (vm.gpus.length > 0) return
    await this.attachGpu(vm, null)
  }

  private async gpuDetachCommand(cmd: Command<"gpuDetach">): Promise<void> {
    const vm = this.heldAt(cmd.boxId, cmd.ownerEpoch)
    if (vm.gpus.length === 0) return
    await this.detachGpus(vm)
  }

  private freeGpu(): string | null {
    const used = new Set<string>(this.gpuReservations.values())
    for (const vm of this.records.values()) if (vm.state !== "deleted") for (const gpu of vm.gpus) used.add(gpu)
    return this.config.gpus.find((gpu) => !used.has(gpu.pciAddress))?.pciAddress ?? null
  }

  /** Host memory a running VM commits: its plugged memory, or its whole limit while it holds or is being given a GPU. */
  private committedMemory(exceptBoxId: string): number {
    let total = 0
    for (const vm of this.records.values()) {
      if (vm.boxId === exceptBoxId || vm.state !== "running") continue
      total += vm.gpus.length > 0 || this.gpuReservations.has(vm.boxId) ? vm.limits.maxMemoryBytes : vm.memoryBytes
    }
    return total
  }

  /**
   * The guest asked for a GPU (`wanted`) or to give its GPU back. Each request is answered exactly once, and a denial
   * is final for that request.
   */
  private async decideGpu(boxId: string, id: string, wanted: boolean): Promise<void> {
    const rt = this.runtime(boxId)
    try {
      const vm = this.running(boxId)
      if (!wanted) {
        if (vm !== null) await this.detachGpus(vm)
        this.answerGpu(boxId, id, true, null)
        return
      }
      if (vm === null) throw new HostError("the box is not running")
      if (rt.lastGpuAttachAt !== null && Date.now() - rt.lastGpuAttachAt < GPU_INTERVAL_MS) {
        throw new HostError("a GPU was attached too recently")
      }
      await this.attachGpu(vm, id)
    } catch (error) {
      this.answerGpu(boxId, id, false, errorMessage(error))
    }
  }

  /** Answers a guest's `gpuWanted`. A closed link means the guest is gone, so there is nothing to answer. */
  private answerGpu(boxId: string, id: string, granted: boolean, error: string | null): void {
    const link = this.runtime(boxId).link
    if (link === null || link.isClosed()) return
    link.send({ _tag: "gpuDecision", id, granted, error })
  }

  /**
   * Hot-plugs a free GPU into a running box. With `decision` set, the guest asked for it: the request is granted once the
   * device is in the VMM, and the box is then told it is attached. Throws before a grant, so the caller can deny; after a
   * grant a failure is recorded on the box, and an operator's attach (no decision) throws it.
   */
  private async attachGpu(vm: VmRecord, decision: string | null): Promise<void> {
    if (vm.limits.gpu !== "on-demand") throw new HostError("this box's limits do not allow a GPU")
    const pci = this.freeGpu()
    if (pci === null) throw new HostError("no free GPU on this host")
    if (this.committedMemory(vm.boxId) + vm.limits.maxMemoryBytes > this.config.capacity.memoryBytes) {
      throw new HostError("not enough host memory to attach a GPU (an attached GPU pins the box's maximum memory)")
    }
    // Reserved before the first await, so a concurrent attach on another box cannot take the same card or memory.
    this.gpuReservations.set(vm.boxId, pci)
    const rt = this.runtime(vm.boxId)
    rt.lastGpuAttachAt = Date.now()
    const cur = this.begin(vm, "gpuAttach", null)
    const client = new ChClient(this.paths(vm.boxId).apiSocket)
    try {
      await client.addDevice(gpuPath(pci), gpuDeviceId(pci))
    } catch (error) {
      this.gpuReservations.delete(vm.boxId)
      await client.removeDevice(gpuDeviceId(pci)).catch(() => undefined)
      this.finish(cur, cur.state, { lastError: errorMessage(error) })
      throw error
    }
    if (decision !== null) this.answerGpu(vm.boxId, decision, true, null)
    try {
      await this.ask(rt, { _tag: "gpuAttached", id: newRequestId(), pciAddress: pci }, GUEST_REPLY_TIMEOUT_MS.gpuAttached)
      this.finish(cur, cur.state, { gpus: [pci], gpuAttachedAt: Date.now() })
    } catch (error) {
      await client.removeDevice(gpuDeviceId(pci)).catch(() => undefined)
      this.finish(cur, cur.state, { lastError: errorMessage(error) })
      if (decision === null) throw error
    } finally {
      this.gpuReservations.delete(vm.boxId)
    }
  }

  private async detachGpus(vm: VmRecord): Promise<VmRecord> {
    if (vm.gpus.length === 0) return vm
    const rt = this.runtime(vm.boxId)
    const client = new ChClient(this.paths(vm.boxId).apiSocket)
    for (const pci of vm.gpus) {
      await this.tryAsk(rt, { _tag: "gpuDetach", id: newRequestId() }, GUEST_REPLY_TIMEOUT_MS.gpuDetach)
      await client.removeDevice(gpuDeviceId(pci))
    }
    return this.commit({ ...vm, gpus: [], gpuAttachedAt: null })
  }

  private async resizeVm(vm: VmRecord, desired: { readonly vcpus: number; readonly memoryBytes: number }): Promise<VmRecord> {
    const client = new ChClient(this.paths(vm.boxId).apiSocket)
    await client.resize(desired)
    return this.commit({ ...vm, vcpus: desired.vcpus, memoryBytes: desired.memoryBytes })
  }

  private running(boxId: string): VmRecord | null {
    const vm = this.records.get(boxId)
    return vm?.state === "running" ? vm : null
  }

  private lastActiveMs(vm: VmRecord): number {
    const rt = this.runtime(vm.boxId)
    return lastActiveAt({
      runningSince: vm.since,
      lastCpuActiveAt: rt.lastCpuActiveAt,
      lastRequestAt: rt.ingress.lastRequestAt,
    })
  }

  /**
   * Settles a fenced VM. Its VMM is already dead (see fenceNow), so this releases what it held and parks it on its local
   * volume. Nothing is woken.
   */
  private async fence(boxId: string): Promise<void> {
    const vm = this.running(boxId)
    if (vm === null) return
    const released = await this.releaseVm(vm)
    this.finish(released, "parked", { lastError: "fenced: control plane lease lapsed" })
  }

  /**
   * Past the control plane's lease a running VM is killed at once: no sync, no guest request. Its link is closed, and it
   * is settled through the box's queue after whatever it was doing has failed.
   */
  private fenceNow(vm: VmRecord): void {
    const rt = this.runtime(vm.boxId)
    if (rt.fencing) return
    rt.fencing = true
    this.closeLink(vm.boxId)
    void killVmm(vm.process, this.paths(vm.boxId).apiSocket)
      .then(() => this.enqueue(vm.boxId, () => this.fence(vm.boxId)))
      .catch((error: unknown) => {
        // The VMM is still up; the next tick sees the lapsed lease and tries again.
        const current = this.running(vm.boxId)
        if (current !== null) this.commit({ ...current, lastError: errorMessage(error) })
      })
      .finally(() => {
        rt.fencing = false
      })
  }

  /** Every policy tick: host pressure, fenced VMs, CPU activity, one scheduled action per running box, parking and cache eviction. */
  private tick(): void {
    const now = Date.now()
    const lapsed = now >= this.leaseUntil
    if (lapsed && !this.lapseFenced) {
      this.lapseFenced = true
      this.leaseGeneration += 1
    }
    const tight = this.isDiskTight()
    if (readMemoryPressureAvg10() > HOST_MEMORY_PRESSURE_AVG10) this.suspendLeastActive()
    for (const vm of this.records.values()) {
      const boxId = vm.boxId
      if (vm.state === "running") {
        if (lapsed) {
          this.fenceNow(vm)
          continue
        }
        this.sampleCpu(vm, now)
        if (this.runtime(boxId).busy) continue
        this.schedule(boxId, () => this.runningTick(boxId))
      } else if (vm.state === "suspended" && now - vm.since >= this.config.parkAfterMs) {
        this.schedule(boxId, () => this.parkWhere(boxId, ["suspended"]))
      } else if (vm.state === "parked" && tight && !vm.localDirty && vm.localRef !== null) {
        this.schedule(boxId, () => this.evictCache(boxId))
      }
    }
  }

  /** Host-measured activity: a cgroup that used enough CPU since the previous sample counts as active now. */
  private sampleCpu(vm: VmRecord, now: number): void {
    if (vm.process === null) return
    const dir = cgroupDirOf(vm.process.pid)
    const usec = dir === null ? null : readCpuUsec(dir)
    if (usec === null) return
    const rt = this.runtime(vm.boxId)
    const previous = rt.cpuSample
    rt.cpuSample = { usec, at: now }
    if (previous !== null && cpuActive({ usecDelta: usec - previous.usec, elapsedMs: now - previous.at })) rt.lastCpuActiveAt = now
  }

  /** The one scheduled action per running box: its policy, then its backup when due (the backup runs even if policy failed). */
  private async runningTick(boxId: string): Promise<void> {
    try {
      await this.policyRunning(boxId)
    } finally {
      await this.backupIfDue(boxId)
    }
  }

  private suspendLeastActive(): void {
    const candidates: { boxId: string; lastActiveMs: number }[] = []
    for (const vm of this.records.values()) {
      if (vm.state !== "running" || this.runtime(vm.boxId).busy) continue
      candidates.push({ boxId: vm.boxId, lastActiveMs: this.lastActiveMs(vm) })
    }
    const victim = pickSuspendVictim(candidates)
    if (victim !== null) this.schedule(victim, () => this.sleepRunning(victim))
    // Every other running VM gives back memory down to what it uses now (shrink to target, no headroom).
    for (const candidate of candidates) if (candidate.boxId !== victim) this.schedule(candidate.boxId, () => this.shrinkToFloor(candidate.boxId))
  }

  /** Under host memory pressure: shrinks a running VM to the memory its guest uses now, from a fresh guest sample. */
  private async shrinkToFloor(boxId: string): Promise<void> {
    const vm = this.running(boxId)
    const status = this.runtime(boxId).status
    if (vm === null || status === null || Date.now() - status.at > STATUS_FRESH_MS) return
    const floor = memoryFloorBytes(status.pressure, vm.limits.maxMemoryBytes)
    if (floor < vm.memoryBytes) await this.resizeVm(vm, { vcpus: vm.vcpus, memoryBytes: floor })
  }

  /** Suspends a running VM, or parks it when the disk is too tight to hold a memory image. */
  private async sleepRunning(boxId: string): Promise<void> {
    const vm = this.running(boxId)
    if (vm === null) return
    if (this.isDiskTight()) await this.park(vm)
    else await this.suspend(vm)
  }

  private async parkWhere(boxId: string, states: readonly NestVmState[]): Promise<void> {
    const vm = this.records.get(boxId)
    if (vm !== undefined && states.includes(vm.state)) await this.park(vm)
  }

  private async evictCache(boxId: string): Promise<void> {
    const vm = this.records.get(boxId)
    if (vm === undefined || vm.state !== "parked" || vm.localDirty || vm.localRef === null) return
    if (vm.volumeProcess !== null) return
    rmSync(this.paths(boxId).volume, { force: true })
    this.commit({ ...vm, localRef: null })
  }

  private async policyRunning(boxId: string): Promise<void> {
    const rt = this.runtime(boxId)
    const now = Date.now()
    let vm = this.running(boxId)
    if (vm === null) return
    const status = rt.status
    const fresh = status !== null && now - status.at <= STATUS_FRESH_MS ? status : null
    // Scaling and GPU decisions need the guest's pressure report; idleness does not, so a silent guest is still parked.
    if (fresh !== null) {
      vm = await this.scale(vm, rt, fresh.pressure, now)
    }
    const idle = isIdle({
      now,
      activity: fresh?.activity ?? null,
      lastActiveMs: this.lastActiveMs(vm),
      openConnections: rt.ingress.openConnections,
      idleAfterMs: this.config.idleSuspendAfterMs,
    })
    if (!idle) return
    if (this.isDiskTight()) await this.park(vm)
    else await this.suspend(vm)
  }

  private async scale(vm: VmRecord, rt: Runtime, pressure: GuestPressure, now: number): Promise<VmRecord> {
    const sample: GuestSample = {
      memTotalBytes: pressure.memTotalBytes,
      memAvailableBytes: pressure.memAvailableBytes,
      memSomeAvg10: pressure.memSomeAvg10,
      cpuSomeAvg10: pressure.cpuSomeAvg10,
      loadAvg1: pressure.loadAvg1,
    }
    const used = Math.max(0, sample.memTotalBytes - sample.memAvailableBytes)
    const memPressured =
      sample.memAvailableBytes < memoryHeadroomBytes(used) / 2 || sample.memSomeAvg10 > MEMORY_PRESSURE_AVG10
    const memory = stepSize({
      now,
      current: vm.memoryBytes,
      target: memoryTargetBytes(sample, vm.limits.maxMemoryBytes),
      pressured: memPressured,
      shrinkStep: MEMORY_STEP_BYTES,
      state: rt.memoryScale,
    })
    rt.memoryScale = memory.state
    const cpu = stepSize({
      now,
      current: vm.vcpus,
      target: vcpuTarget(sample, vm.limits.maxVcpus),
      pressured: sample.cpuSomeAvg10 > CPU_PRESSURE_AVG10,
      shrinkStep: 1,
      state: rt.cpuScale,
    })
    rt.cpuScale = cpu.state
    if (memory.next === vm.memoryBytes && cpu.next === vm.vcpus) return vm
    return this.resizeVm(vm, { vcpus: cpu.next, memoryBytes: memory.next })
  }

  /** Backs the volume up when the interval has passed and the volume may have changed. A failed backup is retried with backoff. */
  private async backupIfDue(boxId: string): Promise<void> {
    const vm = this.running(boxId)
    if (vm === null) return
    const rt = this.runtime(boxId)
    const now = Date.now()
    if (now - (vm.backedUpAt ?? vm.since) < this.config.backupIntervalMs) return
    const backoffMs =
      rt.backupFailures === 0 ? 0 : Math.min(BACKUP_RETRY_MS * 2 ** (rt.backupFailures - 1), this.config.backupIntervalMs)
    if (rt.backupAttemptAt !== null && now - rt.backupAttemptAt < backoffMs) return
    const p = this.paths(boxId)
    const changed =
      vm.volumeProcess !== null || vm.backedUpAt === null || (existsSync(p.volume) && statSync(p.volume).mtimeMs > vm.backedUpAt)
    if (!changed) return
    rt.backupAttemptAt = now
    try {
      await this.backupRunning(boxId)
      rt.backupFailures = 0
    } catch (error) {
      rt.backupFailures += 1
      const current = this.running(boxId)
      if (current !== null) this.commit({ ...current, lastError: `backup failed: ${errorMessage(error)}` })
    }
  }

  private async backupRunning(boxId: string): Promise<void> {
    const vm = this.running(boxId)
    if (vm === null) return
    const p = this.paths(boxId)
    const rt = this.runtime(boxId)
    const device = vm.volumeProcess?.device ?? null
    const copy = join(p.dir, "backup.raw")
    this.commit({ ...vm, frozen: true })
    try {
      await this.ask(rt, { _tag: "freezeVolume", id: newRequestId() }, GUEST_REPLY_TIMEOUT_MS.freezeVolume)
    } catch (error) {
      await this.thawOrStop(boxId, `backup aborted: ${errorMessage(error)}`)
      throw error
    }
    // A lazy device is read while frozen, so the backup is a consistent image of the frozen volume.
    let volumeRef: string | null = null
    try {
      if (device !== null) volumeRef = (await backupVolume(this.volume, { path: device, boxId })).volumeRef
      else await runChecked("cp", ["--reflink=auto", p.volume, copy])
    } catch (error) {
      await this.thawOrStop(boxId, `backup aborted: ${errorMessage(error)}`)
      rmSync(copy, { force: true })
      throw error
    }
    const thawed = await this.thawOrStop(boxId, "backup source taken")
    if (volumeRef === null) {
      try {
        if (!thawed) throw new HostError("the guest did not thaw its volume, so the VM was stopped")
        volumeRef = (await backupVolume(this.volume, { path: copy, boxId })).volumeRef
      } finally {
        rmSync(copy, { force: true })
      }
    }
    const current = this.running(boxId)
    if (current === null) return
    this.commit({ ...current, volumeRef, backedUpAt: Date.now() })
  }

  /** Periodic sample of every live VM; a deleted VM was already sampled by its final commit. */
  private meterTick(): void {
    const now = Date.now()
    for (const vm of this.records.values()) {
      if (vm.state === "deleted") continue
      this.meterSample(vm, now)
    }
  }

  /** Decides what survives a restart. Live VMMs are re-adopted; anything else rolls back to a resumable state. */
  private async recover(record: VmRecord): Promise<void> {
    const p = this.paths(record.boxId)
    // A crash during a volume replacement can leave the only local copy at `volume.raw.previous` and a destination
    // the restore never committed. Roll that back before the record is interpreted.
    restorePreviousVolume(p)
    // A snapshot still under its staging name was never complete, so it is not a memory image.
    if (existsSync(p.dir)) for (const name of readdirSync(p.dir)) if (/^snapshot\.\d+\.tmp$/.test(name)) rmSync(join(p.dir, name), { recursive: true, force: true })
    const plan = recoverPlan(record, {
      vmmAlive: processIsVmm(record.process, p.apiSocket),
      volumeAlive: record.volumeProcess !== null && isProcessAlive(record.volumeProcess.process),
      snapshotExists: record.snapshotGen !== null && existsSync(join(p.snapshot(record.snapshotGen), "state.json")),
    })
    if (plan.killVmm) await stopVmmProcess(record.process, p.apiSocket, VMM_STOP_GRACE_MS)
    if (plan.killVolume && record.volumeProcess !== null) {
      await terminateProcess(record.volumeProcess.process, VOLUME_STOP_GRACE_MS)
    }
    if (plan.clearNetwork && record.network !== null) await tapDown(record.network)
    // An adopted VMM may still be using its recorded image; only an image no process holds may be removed.
    if (plan.dropMemoryImages && !plan.adoptVmm && record.snapshotGen !== null) {
      rmSync(p.snapshot(record.snapshotGen), { recursive: true, force: true })
    }
    // A suspend that died after renaming its next generation into place leaves an image nothing will adopt.
    if (record.operation?.kind === "suspend") rmSync(p.snapshot((record.snapshotGen ?? 0) + 1), { recursive: true, force: true })
    if (plan.deleteArtifacts) clearArtifacts(p.dir)
    let next: VmRecord = {
      ...record,
      state: plan.state,
      since: plan.state === record.state ? record.since : enteredAt(record.since),
      process: plan.adoptVmm ? record.process : null,
      network: plan.clearNetwork ? null : record.network,
      volumeProcess: plan.killVolume ? null : record.volumeProcess,
      // A stale freeze must not survive the restart: the written record must agree with the state recovery chose.
      frozen: false,
      snapshotGen: plan.dropMemoryImages ? null : record.snapshotGen,
      gpus: plan.adoptVmm ? record.gpus : [],
      gpuAttachedAt: plan.adoptVmm ? record.gpuAttachedAt : null,
      operation: null,
    }
    if (plan.adoptVmm) {
      try {
        const { link } = await connectGuest(p.vsockSocket, CONNECT_TIMEOUT_MS)
        this.attachLink(record.boxId, link)
      } catch (error) {
        next = await this.releaseVm({ ...next, state: "parked" })
        next = { ...next, since: enteredAt(next.since), lastError: errorMessage(error) }
      }
    }
    this.commit(next)
  }
}
