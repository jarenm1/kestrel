/**
 * The Nest control plane's state machine: which host each Nest box runs on, the epoch that makes a placement current,
 * the commands in flight, and the enrollment secrets. The Hub owns the sockets and calls in here; SQL lives in
 * `nest-table.ts`, the rules in `nest-control.ts`.
 */
import {
  NEST_ENROLL_TOKEN_TTL_MS,
  NEST_LAPSE_REFUSAL,
  NEST_LEASE_MS,
  type NestBoxStatus,
  type NestControlFrame,
  type NestEnrollBody,
  type NestEnrollResult,
  type NestHostCapacity,
  type NestHostCommand,
  type NestHostStatus,
  type NestLimits,
  type NestVmReport,
} from "@cloudagents/protocol"
import { safeEqual } from "./http"
import type { FleetSql } from "./fleet-table"
import { listMeterHosts } from "./meter-table"
import {
  MAX_LAPSE_RETRIES,
  commandTimeoutMs,
  decideVm,
  enrollTokenHash,
  nestStatusOf,
  newSecret,
  placeHost,
  publicUrlFor,
  type PlacementCandidate,
  withPlannedBoots,
} from "./nest-control"
import {
  deleteNestBox,
  insertNestBox,
  nestBox,
  nestBoxByPendingId,
  nestBoxesDue,
  nestBoxesOfUser,
  nestBoxesOnHost,
  nestBoxesWanted,
  nestBootsOnHost,
  nestHostRow,
  nestHostRows,
  nextNestDeadline,
  saveNestBox,
  touchNestHost,
  upsertNestHost,
  type NestBoxRow,
  type StoredNestCommand,
} from "./nest-table"

/** The socket side of the Hub: frames go to a host's connection, and a connection says whether it is up. */
export interface NestLink {
  send(hostId: string, frame: NestControlFrame): boolean
  connected(hostId: string): boolean
}

/**
 * The form a pending command is stored in: a create or resume keeps no plaintext enrollment token, because a resend
 * mints a fresh one for a box that has not enrolled.
 */
const storedFormOf = (command: NestHostCommand): StoredNestCommand => {
  if (command._tag === "create") {
    const { enrollToken: _token, ...stored } = command
    return stored
  }
  return command._tag === "resume" ? { ...command, enrollToken: null } : command
}

/** Same shape as the Hub's `BoxOutcome` failure, so the Hub returns these unchanged. */
export type NestOutcome<T> = { ok: true; value: T } | { ok: false; status: number; tag: string; message: string }

/** An enrollment token and its stored hash, minted before the synchronous placement it goes with. */
export type MintedToken = { token: string; hash: string }

const failure = (status: number, tag: string, message: string): NestOutcome<never> => ({ ok: false, status, tag, message })

const NO_SUCH_BOX = failure(404, "NoSuchBox", "no such box")
const IN_FLIGHT = failure(409, "CommandInFlight", "a command for this box is already in flight")
const HOST_OFFLINE = failure(409, "HostOffline", "the host holding this box is offline")
const DONE: NestOutcome<null> = { ok: true, value: null }

/** The fields of a `hello` frame the fleet needs; the Hub passes the decoded frame through. */
export type NestHello = {
  hostId: string
  slug: string
  agentVersion: string
  imageId: string
  capacity: NestHostCapacity
}

export class NestFleet {
  constructor(
    private readonly sql: FleetSql,
    private readonly link: NestLink,
    /** The Nest domain; public URLs are `https://<boxId>.<host slug>.<domain>`. */
    private readonly domain: string,
    private readonly clock: () => number = Date.now,
  ) {}

  /** Inventory chunks and live reports seen since hello, held until the last chunk arrives. */
  private readonly inventories = new Map<string, { vms: NestVmReport[]; updated: Map<string, NestVmReport> }>()

  // ---------------------------------------------------------------------------
  // Host frames
  // ---------------------------------------------------------------------------

  /**
   * The first frame on a connection: records the host, renews its lease, and resends its in-flight commands. Its VMs
   * follow as `inventory` chunks. The lease goes first: a host refuses a command that arrives on a lease it already
   * knows has lapsed, so a resend sent ahead of the renewal would fail after a long disconnect.
   */
  async hello(frame: NestHello): Promise<void> {
    upsertNestHost(this.sql, {
      id: frame.hostId,
      slug: frame.slug,
      agentVersion: frame.agentVersion,
      imageId: frame.imageId,
      capacity: frame.capacity,
      lastSeenAt: new Date(this.clock()).toISOString(),
    })
    this.inventories.set(frame.hostId, { vms: [], updated: new Map() })
    this.link.send(frame.hostId, { _tag: "lease", validUntil: this.clock() + NEST_LEASE_MS })
    const inFlight = nestBoxesOnHost(this.sql, frame.hostId).filter((row) => row.pendingId !== null)
    for (const row of inFlight) await this.resend(row.boxId)
    await this.redispatchOwed(frame.hostId)
    await this.wakeWanted()
  }

  /**
   * One chunk of the host's VM inventory, sent after `hello`. Chunks are held until the last one arrives: only then are
   * the VMs applied, so no eviction rests on a partial list. A live report received during the snapshot takes priority.
   */
  inventory(hostId: string, vms: readonly NestVmReport[], last: boolean): void {
    const inventory = this.inventories.get(hostId) ?? { vms: [], updated: new Map<string, NestVmReport>() }
    inventory.vms.push(...vms)
    if (!last) {
      this.inventories.set(hostId, inventory)
      return
    }
    this.inventories.delete(hostId)
    for (const vm of inventory.vms) {
      if (inventory.updated.has(vm.boxId)) continue
      this.vm(hostId, vm)
      this.reconcileLimits(hostId, vm)
    }
    for (const vm of inventory.updated.values()) this.reconcileLimits(hostId, vm)
  }

  /** A capacity report: stored, the lease renewed, and boxes that were waiting for room placed. */
  async capacity(hostId: string, capacity: NestHostCapacity): Promise<void> {
    const host = nestHostRow(this.sql, hostId)
    if (host === null) return
    upsertNestHost(this.sql, { ...host, capacity, lastSeenAt: new Date(this.clock()).toISOString() })
    this.link.send(hostId, { _tag: "lease", validUntil: this.clock() + NEST_LEASE_MS })
    await this.redispatchOwed(hostId)
    await this.wakeWanted()
  }

  /** A VM report from a host: the host's state is the truth for placement, state, size and GPUs. */
  vm(hostId: string, report: NestVmReport): void {
    this.inventories.get(hostId)?.updated.set(report.boxId, report)
    const row = nestBox(this.sql, report.boxId)
    const decision = decideVm(row, hostId, report)
    if (decision._tag === "evict") {
      // The host refuses an epoch that is not strictly newer than its copy, so send the control plane's epoch, not the
      // stale one the host reported. `decideVm` evicts only when the report's epoch lags the row, so this is newer.
      if (row !== null) this.send(hostId, { _tag: "evict", boxId: report.boxId, ownerEpoch: row.ownerEpoch })
      return
    }
    if (decision._tag === "ignore") {
      console.warn(`nest: ignored VM report for ${report.boxId} from ${hostId}: ${decision.reason}`)
      return
    }
    if (row === null) return
    if (report.state === "deleted") {
      this.forget(row)
      return
    }
    // A failed create keeps its flag while its VM is still provisioning; a VM that is up clears it.
    if (report.state !== "provisioning") row.createFailed = false
    row.state = report.state
    row.imageId = report.imageId
    row.vcpus = report.vcpus
    row.memoryBytes = report.memoryBytes
    row.gpus = report.gpus.length
    row.volumeRef = report.volumeRef
    row.backedUpAt = report.backedUpAt
    // A parked report with nothing in flight releases the box from this host. While a command is in flight the claim
    // stays until that command's result settles, since the two frames may arrive in either order.
    if (report.state === "parked" && row.pendingId === null) row.hostId = null
    saveNestBox(this.sql, row)
  }

  /** The outcome of a command. `vm` is the VM after it, absent once destroyed. */
  result(hostId: string, commandId: string, ok: boolean, error: string | null, vm: NestVmReport | undefined): void {
    const row = nestBoxByPendingId(this.sql, commandId)
    if (row === null || row.hostId !== hostId) return
    const kind = row.pendingKind
    this.clearPending(row)
    if (!ok) console.warn(`nest: ${kind} for ${row.boxId} failed on ${hostId}: ${error ?? "no reason given"}`)
    const owed = kind === "create" || kind === "park" || kind === "destroy" ? this.noteRetry(row, kind, ok, error) : false
    // A create refused for a lapse ran nothing, so it is owed a resend and the box is not failed yet.
    if (kind === "create" && !owed) row.createFailed = !ok
    if (kind === "destroy" && ok) {
      this.forget(row)
      return
    }
    // A parked box with nothing in flight is held by no host. A park result that arrives after the parked report, and a
    // refused resume (never started there), release the claim here. A result that carries a VM report is applied by
    // `vm`, which releases the claim on a parked report and keeps it on a running one.
    if (vm === undefined && row.state === "parked") row.hostId = null
    saveNestBox(this.sql, row)
    if (vm !== undefined) this.vm(hostId, vm)
  }

  /** A request reached ingress for a box. A parked box is woken only by the host its URL names; a suspended one by its host. */
  async wakeRequest(hostId: string, boxId: string): Promise<void> {
    const row = nestBox(this.sql, boxId)
    if (row === null || row.pendingId !== null) return
    if (row.state === "parked") {
      if (!this.namedOn(hostId, row)) return
      row.wakeWanted = true
      saveNestBox(this.sql, row)
      await this.wake(boxId)
      return
    }
    if (row.state === "suspended" && row.hostId === hostId) await this.wake(boxId)
  }

  /** A host's socket closed: records when it was last heard from. */
  hostDisconnected(hostId: string): void {
    this.inventories.delete(hostId)
    touchNestHost(this.sql, hostId, new Date(this.clock()).toISOString())
  }

  /**
   * Drops in-flight markers whose deadline passed. The host's VM reports stay the truth: an expired `create` marks the
   * box failed, so the owner can delete it; an expired `resume` is retried on the same host while that host holds the
   * box's claim; a parked report releases the claim after a park or destroy expires; other
   * commands are the owner's to retry. A late `result` for an expired command finds no marker and is ignored.
   */
  async expire(now: number): Promise<void> {
    for (const row of nestBoxesDue(this.sql, now)) {
      console.warn(`nest: ${row.pendingKind} for ${row.boxId} timed out`)
      const kind = row.pendingKind
      this.clearPending(row)
      if (kind === "create") row.createFailed = true
      if (kind === "resume") row.wakeWanted = true
      if ((kind === "park" || kind === "destroy") && row.state === "parked") row.hostId = null
      saveNestBox(this.sql, row)
    }
    await this.wakeWanted()
  }

  nextDeadline(): number | null {
    return nextNestDeadline(this.sql)
  }

  // ---------------------------------------------------------------------------
  // Enrollment
  // ---------------------------------------------------------------------------

  /** The box's secret, for a token that matches and has not expired; the same token gets the same secret until first use. */
  async enroll(body: NestEnrollBody): Promise<NestEnrollResult | null> {
    const row = nestBox(this.sql, body.boxId)
    if (row === null || row.enrollHash === null || row.enrollExpiresAt === null) return null
    if (row.enrollExpiresAt <= this.clock()) return null
    if (!(await safeEqual(await enrollTokenHash(body.token), row.enrollHash))) return null
    const secret = this.sql
      .exec<{ secret: string }>("SELECT secret FROM user_boxes WHERE id = ?", body.boxId)
      .toArray()[0]?.secret
    return secret === undefined ? null : { secret }
  }

  /** The box authenticated with its secret: enrollment is over. */
  markEnrolled(boxId: string): void {
    this.sql.exec("UPDATE nest_boxes SET enroll_hash = NULL, enroll_expires_at = NULL WHERE box_id = ?", boxId)
  }

  // ---------------------------------------------------------------------------
  // Owner actions
  // ---------------------------------------------------------------------------

  /**
   * The connected host a new box would go to, or null when none has room. `preferred` is taken whenever it has room.
   * Boots a host is already committed to count against its room, so two placements never book the same space.
   */
  placement(preferred: string | null): PlacementCandidate | null {
    const candidates = nestHostRows(this.sql)
      .filter((host) => this.link.connected(host.id))
      .map((host) => ({
        hostId: host.id,
        slug: host.slug,
        capacity: withPlannedBoots(host.capacity, nestBootsOnHost(this.sql, host.id)),
      }))
    return placeHost(candidates, preferred)
  }

  /** Whether a user_boxes row is a Nest box. */
  isNestBox(boxId: string): boolean {
    return nestBox(this.sql, boxId) !== null
  }

  /** A fresh enrollment token and its hash. Minted before placement, so nothing awaits between placing and recording a box. */
  async mintEnrollToken(): Promise<MintedToken> {
    const token = newSecret()
    return { token, hash: await enrollTokenHash(token) }
  }

  /**
   * Records a new box on `target`, a host `placement()` just chose: epoch 1, a fresh VM id, and a create carrying the
   * enrollment token. Synchronous on purpose: the placement and the box it reserves are recorded in one step.
   */
  createBox(boxId: string, login: string, target: PlacementCandidate, limits: NestLimits, enroll: MintedToken): void {
    const row: NestBoxRow = {
      boxId,
      login,
      hostId: target.hostId,
      vmId: crypto.randomUUID(),
      ownerEpoch: 1,
      state: "provisioning",
      limits,
      volumeRef: null,
      backedUpAt: null,
      imageId: null,
      vcpus: 0,
      memoryBytes: 0,
      gpus: 0,
      wakeWanted: false,
      enrollHash: enroll.hash,
      enrollExpiresAt: this.clock() + NEST_ENROLL_TOKEN_TTL_MS,
      pendingId: null,
      pendingKind: null,
      pendingCommand: null,
      pendingDeadline: null,
      createFailed: false,
      retryKind: null,
      retryCount: 0,
    }
    insertNestBox(this.sql, row)
    const command: NestHostCommand = {
      _tag: "create",
      boxId,
      userId: login,
      vmId: row.vmId,
      ownerEpoch: row.ownerEpoch,
      limits,
      publicUrl: publicUrlFor(boxId, target.slug, this.domain),
      enrollToken: enroll.token,
    }
    if (!this.dispatch(row, command)) {
      row.createFailed = true
      saveNestBox(this.sql, row)
    }
  }

  async resume(login: string, boxId: string): Promise<NestOutcome<null>> {
    const row = this.ownedRow(login, boxId)
    if (row === null) return NO_SUCH_BOX
    if (row.pendingId !== null) return DONE
    if (row.state !== "suspended" && row.state !== "parked") return DONE
    row.wakeWanted = true
    // The owner's resume is a newer request: it replaces a park or destroy owed a resend.
    row.retryKind = null
    row.retryCount = 0
    saveNestBox(this.sql, row)
    await this.wake(boxId)
    return DONE
  }

  suspend(login: string, boxId: string): NestOutcome<null> {
    const row = this.ownedRow(login, boxId)
    if (row === null) return NO_SUCH_BOX
    if (row.pendingId !== null) return IN_FLIGHT
    if (row.state !== "running" || row.hostId === null) return failure(409, "NotRunning", "only a running box can be suspended")
    return this.ownerDispatch(row, { _tag: "suspend", boxId, ownerEpoch: row.ownerEpoch }) ? DONE : HOST_OFFLINE
  }

  /** Parks a running or suspended box: its host backs the volume up and releases the VM. The next wake places it. */
  park(login: string, boxId: string): NestOutcome<null> {
    const row = this.ownedRow(login, boxId)
    if (row === null) return NO_SUCH_BOX
    if (row.pendingId !== null) return IN_FLIGHT
    if ((row.state !== "running" && row.state !== "suspended") || row.hostId === null) {
      return failure(409, "NotRunning", "only a running or suspended box can be parked")
    }
    return this.ownerDispatch(row, { _tag: "park", boxId, ownerEpoch: row.ownerEpoch }) ? DONE : HOST_OFFLINE
  }

  /** Hot-plugs or unplugs the box's GPU while it runs; only a box whose limits allow an on-demand GPU may. */
  gpu(login: string, boxId: string, attach: boolean): NestOutcome<null> {
    const row = this.ownedRow(login, boxId)
    if (row === null) return NO_SUCH_BOX
    if (row.pendingId !== null) return IN_FLIGHT
    if (row.limits.gpu !== "on-demand") return failure(409, "NoGpuPolicy", "this box's limits do not allow an on-demand GPU")
    if (row.state !== "running" || row.hostId === null) return failure(409, "NotRunning", "only a running box can change its GPU")
    if (attach && row.gpus > 0) return failure(409, "GpuAttached", "this box already has its GPU")
    if (!attach && row.gpus === 0) return failure(409, "NoGpu", "this box has no GPU to detach")
    const ownerEpoch = row.ownerEpoch
    const command: NestHostCommand = attach ? { _tag: "gpuAttach", boxId, ownerEpoch } : { _tag: "gpuDetach", boxId, ownerEpoch }
    return this.ownerDispatch(row, command) ? DONE : HOST_OFFLINE
  }

  setLimits(login: string, boxId: string, limits: NestLimits): NestOutcome<null> {
    const row = this.ownedRow(login, boxId)
    if (row === null) return NO_SUCH_BOX
    if (row.pendingId !== null) return IN_FLIGHT
    row.limits = limits
    if (row.hostId === null) {
      saveNestBox(this.sql, row)
      return DONE
    }
    return this.ownerDispatch(row, { _tag: "setLimits", boxId, ownerEpoch: row.ownerEpoch, limits }) ? DONE : HOST_OFFLINE
  }

  /**
   * Deletes a Nest box: the host wipes it, then its rows go. A parked box has no host, so any connected one takes the
   * destroy.
   */
  destroy(login: string, boxId: string): NestOutcome<null> {
    const row = this.ownedRow(login, boxId)
    if (row === null) return NO_SUCH_BOX
    if (row.pendingId !== null) return IN_FLIGHT
    if (row.hostId === null) {
      const host = nestHostRows(this.sql).find((candidate) => this.link.connected(candidate.id))
      if (host === undefined) return failure(409, "NoHost", "no Nest host is connected to delete this box")
      row.hostId = host.id
    }
    return this.ownerDispatch(row, { _tag: "destroy", boxId, ownerEpoch: row.ownerEpoch }) ? DONE : HOST_OFFLINE
  }

  /** Whether the owner's box is running now; the automation wake waits on this. */
  isRunning(login: string, boxId: string): boolean {
    return this.ownedRow(login, boxId)?.state === "running"
  }

  /** The owner's view of each Nest box, keyed by box id. */
  statusesOf(login: string): Map<string, NestBoxStatus> {
    return new Map(nestBoxesOfUser(this.sql, login).map((row) => [row.boxId, nestStatusOf(row)]))
  }

  /** Every enrolled host with its link state, for the operator's fleet view. */
  hostList(): NestHostStatus[] {
    const rows = new Map(nestHostRows(this.sql).map((row) => [row.id, row]))
    return listMeterHosts(this.sql).map((host) => {
      const row = rows.get(host.id)
      return {
        id: host.id,
        name: host.name,
        slug: row?.slug ?? null,
        connected: this.link.connected(host.id),
        agentVersion: row?.agentVersion ?? null,
        capacity: row?.capacity ?? null,
        lastSeenAt: row?.lastSeenAt ?? null,
      }
    })
  }

  // ---------------------------------------------------------------------------
  // Internals
  // ---------------------------------------------------------------------------

  private ownedRow(login: string, boxId: string): NestBoxRow | null {
    const row = nestBox(this.sql, boxId)
    return row !== null && row.login === login ? row : null
  }

  private send(hostId: string, command: NestHostCommand): void {
    this.link.send(hostId, { _tag: "command", commandId: crypto.randomUUID(), command })
  }

  /**
   * Sends an owner's request. A park or destroy replaces an owed resend and starts its run from zero. Other owner requests
   * (suspend, limits, GPU) leave an owed park or destroy alone: the owner never withdrew it. System paths (wake, resume,
   * limits reconciliation, the resends themselves) use `dispatch`.
   */
  private ownerDispatch(row: NestBoxRow, command: NestHostCommand): boolean {
    if (!this.dispatch(row, command)) return false
    if (command._tag === "park" || command._tag === "destroy") {
      row.retryKind = null
      row.retryCount = 0
      saveNestBox(this.sql, row)
    }
    return true
  }

  /**
   * Sends a command to the box's host and records it as in flight. When the socket refuses the frame nothing is
   * recorded, so the caller reports the failure and the box never waits on a command no host received. Leaves the retry
   * state alone.
   */
  private dispatch(row: NestBoxRow, command: NestHostCommand): boolean {
    if (row.hostId === null) return false
    const commandId = crypto.randomUUID()
    if (!this.link.send(row.hostId, { _tag: "command", commandId, command })) return false
    const timeout = commandTimeoutMs(command._tag)
    row.pendingId = commandId
    row.pendingKind = command._tag
    row.pendingCommand = storedFormOf(command)
    row.pendingDeadline = timeout === null ? null : this.clock() + timeout
    row.wakeWanted = false
    saveNestBox(this.sql, row)
    return true
  }

  /**
   * Resends a box's in-flight command under its id, so the host answers it once. A create or resume the box has not
   * enrolled from gets a fresh enrollment token. A create for an enrolled box carries an inert token, since the field is
   * required. The row is read again after the await: a result or enrollment that landed meanwhile must not be overwritten.
   */
  private async resend(boxId: string): Promise<void> {
    const row = nestBox(this.sql, boxId)
    if (row === null || row.pendingId === null || row.pendingCommand === null || row.hostId === null) return
    const { pendingId, hostId, pendingCommand: stored } = row
    if (stored._tag !== "create" && stored._tag !== "resume") {
      this.link.send(hostId, { _tag: "command", commandId: pendingId, command: stored })
      return
    }
    const minted = await this.tokenFor(boxId)
    const current = nestBox(this.sql, boxId)
    if (current === null || current.pendingId !== pendingId || current.hostId !== hostId) return
    const previous = this.enrollFields(current)
    const enrollToken = this.adoptToken(current, minted)
    // Persisted before the send because the guest may enroll the moment it receives the command. A refused send puts
    // the previous hash back, or the token just minted would be lost without ever reaching a host.
    saveNestBox(this.sql, current)
    const command: NestHostCommand =
      stored._tag === "create"
        ? { ...stored, enrollToken: enrollToken ?? newSecret() }
        : { ...stored, enrollToken }
    if (!this.link.send(hostId, { _tag: "command", commandId: pendingId, command })) {
      Object.assign(current, previous)
      saveNestBox(this.sql, current)
    }
  }

  /**
   * A park or destroy the host refused for a lapse ran nothing, so it is owed a resend at the host's next lease renewal,
   * up to `MAX_LAPSE_RETRIES` in a row. Any other outcome ends the run. When the bound is reached the owed command is
   * dropped and the event is logged; the owner's next request starts a fresh run.
   */
  private noteRetry(row: NestBoxRow, kind: "create" | "park" | "destroy", ok: boolean, error: string | null): boolean {
    if (ok || error !== NEST_LAPSE_REFUSAL) {
      row.retryCount = 0
      return false
    }
    if (row.retryCount >= MAX_LAPSE_RETRIES) {
      console.warn(`nest: ${kind} for ${row.boxId} was refused for a lapse ${row.retryCount} times; not sending it again`)
      row.retryCount = 0
      return false
    }
    row.retryKind = kind
    row.retryCount += 1
    return true
  }

  /**
   * Sends each command owed a resend to `hostId`: a park, a destroy, or a create. Called after the lease, so each resend
   * arrives on a valid lease.
   */
  private async redispatchOwed(hostId: string): Promise<void> {
    for (const row of nestBoxesOnHost(this.sql, hostId)) {
      const kind = row.retryKind
      if (kind === null || row.pendingId !== null) continue
      if (kind === "create") {
        await this.redispatchCreate(row.boxId)
        continue
      }
      row.retryKind = null
      if (kind === "park" && row.state !== "running" && row.state !== "suspended") {
        saveNestBox(this.sql, row)
        continue
      }
      const command: NestHostCommand =
        kind === "park"
          ? { _tag: "park", boxId: row.boxId, ownerEpoch: row.ownerEpoch }
          : { _tag: "destroy", boxId: row.boxId, ownerEpoch: row.ownerEpoch }
      if (!this.dispatch(row, command)) {
        row.retryKind = kind
        saveNestBox(this.sql, row)
      }
    }
  }

  /**
   * Sends a create owed a resend. It carries a fresh enrollment token, as a resend of a create always does, and the box
   * is re-read after the await: a newer request or a result that landed meanwhile wins.
   */
  private async redispatchCreate(boxId: string): Promise<void> {
    const minted = await this.tokenFor(boxId)
    const row = nestBox(this.sql, boxId)
    if (row === null || row.retryKind !== "create" || row.pendingId !== null || row.hostId === null) return
    const previous = this.enrollFields(row)
    const enrollToken = this.adoptToken(row, minted)
    const command: NestHostCommand = {
      _tag: "create",
      boxId,
      userId: row.login,
      vmId: row.vmId,
      ownerEpoch: row.ownerEpoch,
      limits: row.limits,
      publicUrl: this.boxUrl(boxId),
      enrollToken: enrollToken ?? newSecret(),
    }
    row.retryKind = null
    if (!this.dispatch(row, command)) {
      Object.assign(row, previous)
      row.retryKind = "create"
      saveNestBox(this.sql, row)
    }
  }

  private clearPending(row: NestBoxRow): void {
    row.pendingId = null
    row.pendingKind = null
    row.pendingCommand = null
    row.pendingDeadline = null
  }

  /** Whether the box's URL names `hostId`, so a request for the box reached that host's ingress. */
  private namedOn(hostId: string, row: NestBoxRow): boolean {
    const host = nestHostRow(this.sql, hostId)
    const url = this.sql.exec<{ url: string }>("SELECT url FROM user_boxes WHERE id = ?", row.boxId).toArray()[0]?.url
    return host !== null && url === publicUrlFor(row.boxId, host.slug, this.domain)
  }

  /** The host whose slug the box's URL names: where its request reached, or where it last ran. */
  private urlHost(row: NestBoxRow): string | null {
    const url = this.boxUrl(row.boxId)
    return nestHostRows(this.sql).find((host) => publicUrlFor(row.boxId, host.slug, this.domain) === url)?.id ?? null
  }

  /**
   * Brings a waiting box up. A box with a host to resume on (a suspended box, or a parked box whose resume claim is
   * still held by a host) resumes there. A parked box with no claim goes to the host its URL names when that host has
   * room, and to another connected host with room otherwise. The await mints an enrollment token for a box that has not
   * enrolled; the row is read again after it.
   */
  private async wake(boxId: string): Promise<void> {
    const before = nestBox(this.sql, boxId)
    if (before === null || before.pendingId !== null) return
    if (before.state !== "suspended" && before.state !== "parked") return
    const minted = await this.tokenFor(boxId)
    const row = nestBox(this.sql, boxId)
    if (row === null || row.pendingId !== null) return
    if (row.state === "suspended" || (row.state === "parked" && row.hostId !== null)) {
      this.resumeOn(row, minted)
      return
    }
    if (row.state !== "parked") return
    const target = this.placement(this.urlHost(row))
    if (target === null) {
      this.holdWake(row)
      return
    }
    // A new placement: a higher epoch and a new VM incarnation, so the old host's copy is evicted on its next report. The
    // claim is kept only once the resume is sent; if it is not, the box stays unplaced for the next wake.
    const previous = { hostId: row.hostId, ownerEpoch: row.ownerEpoch, vmId: row.vmId, ...this.enrollFields(row) }
    const url = publicUrlFor(row.boxId, target.slug, this.domain)
    row.hostId = target.hostId
    row.ownerEpoch += 1
    row.vmId = crypto.randomUUID()
    const enrollToken = this.adoptToken(row, minted)
    if (!this.dispatch(row, this.resumeCommand(row, enrollToken, url))) {
      Object.assign(row, previous)
      this.holdWake(row)
      return
    }
    this.sql.exec("UPDATE user_boxes SET url = ? WHERE id = ?", url, row.boxId)
  }

  /** A fresh enrollment token for a box that has not enrolled yet; null once it has. The caller adopts it at its send. */
  private async tokenFor(boxId: string): Promise<MintedToken | null> {
    const row = nestBox(this.sql, boxId)
    if (row === null || row.enrollHash === null) return null
    return this.mintEnrollToken()
  }

  /** The enrollment fields an adopt replaces, so a send the link refuses can put the previous hash back. */
  private enrollFields(row: NestBoxRow): Pick<NestBoxRow, "enrollHash" | "enrollExpiresAt"> {
    return { enrollHash: row.enrollHash, enrollExpiresAt: row.enrollExpiresAt }
  }

  /** Stores a minted token's hash on a box that has not enrolled, and returns the token to send; null once it has enrolled. */
  private adoptToken(row: NestBoxRow, minted: MintedToken | null): string | null {
    if (minted === null || row.enrollHash === null) return null
    row.enrollHash = minted.hash
    row.enrollExpiresAt = this.clock() + NEST_ENROLL_TOKEN_TTL_MS
    return minted.token
  }

  /**
   * A resume on the box's own host. A parked claim is held until that host answers or disconnects: a resume that timed
   * out may still be running there, so the box never starts a second copy elsewhere. When the host is offline the box
   * waits for it to return.
   */
  private resumeOn(row: NestBoxRow, minted: MintedToken | null): void {
    const hostId = row.hostId
    if (hostId === null || !this.link.connected(hostId)) {
      this.holdWake(row)
      return
    }
    const previous = this.enrollFields(row)
    const enrollToken = this.adoptToken(row, minted)
    if (!this.dispatch(row, this.resumeCommand(row, enrollToken, this.boxUrl(row.boxId)))) {
      Object.assign(row, previous)
      this.holdWake(row)
    }
  }

  /** The box stays waiting; the wake loop tries it again on the next capacity report, hello, or expiry. */
  private holdWake(row: NestBoxRow): void {
    row.wakeWanted = true
    saveNestBox(this.sql, row)
  }

  private async wakeWanted(): Promise<void> {
    for (const row of nestBoxesWanted(this.sql)) await this.wake(row.boxId)
  }

  /** The URL a box is served at now. */
  private boxUrl(boxId: string): string {
    return this.sql.exec<{ url: string }>("SELECT url FROM user_boxes WHERE id = ?", boxId).toArray()[0]?.url ?? ""
  }

  private resumeCommand(row: NestBoxRow, enrollToken: string | null, url: string): NestHostCommand {
    return {
      _tag: "resume",
      boxId: row.boxId,
      userId: row.login,
      vmId: row.vmId,
      ownerEpoch: row.ownerEpoch,
      limits: row.limits,
      publicUrl: url,
      volumeRef: row.volumeRef,
      enrollToken,
    }
  }

  /** A running or suspended VM whose limits differ from the box's: the host is told once, on reconnect. */
  private reconcileLimits(hostId: string, vm: NestVmReport): void {
    const row = nestBox(this.sql, vm.boxId)
    if (row === null || row.hostId !== hostId || row.pendingId !== null) return
    if (row.ownerEpoch !== vm.ownerEpoch || row.vmId !== vm.vmId) return
    if (row.state !== "running" && row.state !== "suspended") return
    const { limits } = row
    if (
      limits.maxVcpus === vm.limits.maxVcpus &&
      limits.maxMemoryBytes === vm.limits.maxMemoryBytes &&
      limits.gpu === vm.limits.gpu &&
      limits.volumeBytes === vm.limits.volumeBytes
    ) {
      return
    }
    this.dispatch(row, { _tag: "setLimits", boxId: row.boxId, ownerEpoch: row.ownerEpoch, limits })
  }

  /** Forgets a destroyed box everywhere the owner can see it. */
  private forget(row: NestBoxRow): void {
    deleteNestBox(this.sql, row.boxId)
    this.sql.exec("UPDATE users SET active_box_id = NULL WHERE active_box_id = ?", row.boxId)
    this.sql.exec("DELETE FROM user_boxes WHERE id = ?", row.boxId)
  }
}
