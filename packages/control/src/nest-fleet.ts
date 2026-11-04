/**
 * The Nest control plane's state machine: which host each Nest box runs on, the epoch that makes a placement current,
 * the commands in flight, and the enrollment secrets. The Hub owns the sockets and calls in here; SQL lives in
 * `nest-table.ts`, the rules in `nest-control.ts`.
 */
import {
  NEST_ENROLL_TOKEN_TTL_MS,
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
  commandTimeoutMs,
  decideVm,
  enrollTokenHash,
  newEnrollToken,
  nestStatusOf,
  placeHost,
  publicUrlFor,
  type PlacementCandidate,
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
  nestHostRow,
  nestHostRows,
  nextNestDeadline,
  saveNestBox,
  touchNestHost,
  upsertNestHost,
  type NestBoxRow,
} from "./nest-table"

/** The socket side of the Hub: frames go to a host's connection, and a connection says whether it is up. */
export interface NestLink {
  send(hostId: string, frame: NestControlFrame): boolean
  connected(hostId: string): boolean
}

/** Same shape as the Hub's `BoxOutcome` failure, so the Hub returns these unchanged. */
export type NestOutcome<T> = { ok: true; value: T } | { ok: false; status: number; tag: string; message: string }

const failure = (status: number, tag: string, message: string): NestOutcome<never> => ({ ok: false, status, tag, message })

const NO_SUCH_BOX = failure(404, "NoSuchBox", "no such box")
const IN_FLIGHT = failure(409, "CommandInFlight", "a command for this box is already in flight")
const DONE: NestOutcome<null> = { ok: true, value: null }

/** The fields of a `hello` frame the fleet needs; the Hub passes the decoded frame through. */
export type NestHello = {
  hostId: string
  slug: string
  agentVersion: string
  imageId: string
  capacity: NestHostCapacity
  vms: readonly NestVmReport[]
  results: readonly { commandId: string; ok: boolean; error?: string }[]
}

export class NestFleet {
  constructor(
    private readonly sql: FleetSql,
    private readonly link: NestLink,
    /** The Nest domain; public URLs are `https://<boxId>.<host slug>.<domain>`. */
    private readonly domain: string,
    private readonly clock: () => number = Date.now,
  ) {}

  // ---------------------------------------------------------------------------
  // Host frames
  // ---------------------------------------------------------------------------

  /** The first frame on a connection: records the host, applies what finished while it was away, reconciles its VMs. */
  async hello(frame: NestHello): Promise<void> {
    upsertNestHost(this.sql, {
      id: frame.hostId,
      slug: frame.slug,
      agentVersion: frame.agentVersion,
      imageId: frame.imageId,
      capacity: frame.capacity,
      lastSeenAt: new Date(this.clock()).toISOString(),
    })
    for (const result of frame.results) this.result(frame.hostId, result.commandId, result.ok, result.error ?? null, undefined)
    for (const vm of frame.vms) {
      this.vm(frame.hostId, vm)
      this.reconcileLimits(frame.hostId, vm)
    }
    for (const row of nestBoxesOnHost(this.sql, frame.hostId)) {
      if (row.pendingId !== null) await this.resend(row)
    }
    this.link.send(frame.hostId, { _tag: "lease", validUntil: this.clock() + NEST_LEASE_MS })
    await this.wakeWanted()
  }

  /** A capacity report: stored, the lease renewed, and boxes that were waiting for room placed. */
  async capacity(hostId: string, capacity: NestHostCapacity): Promise<void> {
    const host = nestHostRow(this.sql, hostId)
    if (host === null) return
    upsertNestHost(this.sql, { ...host, capacity, lastSeenAt: new Date(this.clock()).toISOString() })
    this.link.send(hostId, { _tag: "lease", validUntil: this.clock() + NEST_LEASE_MS })
    await this.wakeWanted()
  }

  /** A VM report from a host: the host's state is the truth for placement, state, size and GPUs. */
  vm(hostId: string, report: NestVmReport): void {
    const row = nestBox(this.sql, report.boxId)
    const decision = decideVm(row, hostId, report)
    if (decision._tag === "evict") {
      this.send(hostId, { _tag: "evict", boxId: report.boxId, ownerEpoch: report.ownerEpoch })
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
    row.state = report.state
    row.imageId = report.imageId
    row.vcpus = report.vcpus
    row.memoryBytes = report.memoryBytes
    row.gpus = report.gpus.length
    row.volumeRef = report.volumeRef
    row.backedUpAt = report.backedUpAt
    if (report.state === "parked") row.hostId = null
    saveNestBox(this.sql, row)
  }

  /** The outcome of a command. `vm` is the VM after it, absent once destroyed. */
  result(hostId: string, commandId: string, ok: boolean, error: string | null, vm: NestVmReport | undefined): void {
    const row = nestBoxByPendingId(this.sql, commandId)
    if (row === null) return
    const kind = row.pendingKind
    this.clearPending(row)
    if (!ok) console.warn(`nest: ${kind} for ${row.boxId} failed on ${hostId}: ${error ?? "no reason given"}`)
    if (kind === "destroy" && ok) {
      this.forget(row)
      return
    }
    // A parked box whose resume failed has no VM to fall back to; the next wake places it again.
    if (kind === "resume" && !ok && row.state === "parked") row.hostId = null
    saveNestBox(this.sql, row)
    if (vm !== undefined) this.vm(hostId, vm)
  }

  /** A request reached ingress for a box the host may not wake itself. */
  wakeRequest(hostId: string, boxId: string): void {
    const row = nestBox(this.sql, boxId)
    if (row === null || row.pendingId !== null) return
    if (row.state === "parked") {
      row.wakeWanted = true
      saveNestBox(this.sql, row)
      this.wake(row)
      return
    }
    if (row.state === "suspended" && row.hostId === hostId) this.wake(row)
  }

  /** A host's socket closed: records when it was last heard from. */
  hostDisconnected(hostId: string): void {
    touchNestHost(this.sql, hostId, new Date(this.clock()).toISOString())
  }

  /** Drops in-flight markers whose deadline passed. A host that never answers gets the command resent on reconnect. */
  expire(now: number): void {
    for (const row of nestBoxesDue(this.sql, now)) {
      console.warn(`nest: ${row.pendingKind} for ${row.boxId} timed out`)
      this.clearPending(row)
      saveNestBox(this.sql, row)
    }
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

  /** The connected host a new box would go to, or null when none has room. */
  placement(): PlacementCandidate | null {
    const candidates = nestHostRows(this.sql)
      .filter((host) => this.link.connected(host.id))
      .map((host) => ({ hostId: host.id, slug: host.slug, capacity: host.capacity }))
    return placeHost(candidates)
  }

  /** Whether a user_boxes row is a Nest box. */
  isNestBox(boxId: string): boolean {
    return nestBox(this.sql, boxId) !== null
  }

  /** Places a new box on `target`: epoch 1, a fresh VM id, and a create with a new enrollment token. */
  async createBox(boxId: string, login: string, target: PlacementCandidate, limits: NestLimits): Promise<void> {
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
      enrollHash: null,
      enrollExpiresAt: null,
      pendingId: null,
      pendingKind: null,
      pendingCommand: null,
      pendingDeadline: null,
    }
    insertNestBox(this.sql, row)
    const token = await this.issueToken(row)
    const command: NestHostCommand = {
      _tag: "create",
      boxId,
      userId: login,
      vmId: row.vmId,
      ownerEpoch: row.ownerEpoch,
      limits,
      publicUrl: publicUrlFor(boxId, target.slug, this.domain),
      enrollToken: token,
    }
    // The stored copy carries no token: a resend mints a fresh one, and the plaintext is never kept.
    this.dispatch(row, { ...command, enrollToken: "" }, command)
  }

  resume(login: string, boxId: string): NestOutcome<null> {
    const row = this.ownedRow(login, boxId)
    if (row === null) return NO_SUCH_BOX
    if (row.pendingId !== null) return DONE
    if (row.state !== "suspended" && row.state !== "parked") return DONE
    row.wakeWanted = true
    saveNestBox(this.sql, row)
    this.wake(row)
    return DONE
  }

  suspend(login: string, boxId: string): NestOutcome<null> {
    const row = this.ownedRow(login, boxId)
    if (row === null) return NO_SUCH_BOX
    if (row.pendingId !== null) return IN_FLIGHT
    if (row.state !== "running" || row.hostId === null) return failure(409, "NotRunning", "only a running box can be suspended")
    this.dispatch(row, { _tag: "suspend", boxId })
    return DONE
  }

  setLimits(login: string, boxId: string, limits: NestLimits): NestOutcome<null> {
    const row = this.ownedRow(login, boxId)
    if (row === null) return NO_SUCH_BOX
    if (row.pendingId !== null) return IN_FLIGHT
    row.limits = limits
    if (row.hostId === null) saveNestBox(this.sql, row)
    else this.dispatch(row, { _tag: "setLimits", boxId, limits })
    return DONE
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
    if (!this.link.connected(row.hostId)) return failure(409, "HostOffline", "the host holding this box is offline")
    this.dispatch(row, { _tag: "destroy", boxId })
    return DONE
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

  /** Records and sends a command, marking the box as having one in flight. */
  private dispatch(row: NestBoxRow, stored: NestHostCommand, wire: NestHostCommand = stored): void {
    const commandId = crypto.randomUUID()
    const timeout = commandTimeoutMs(stored._tag)
    row.pendingId = commandId
    row.pendingKind = stored._tag
    row.pendingCommand = stored
    row.pendingDeadline = timeout === null ? null : this.clock() + timeout
    row.wakeWanted = false
    saveNestBox(this.sql, row)
    if (row.hostId !== null) this.link.send(row.hostId, { _tag: "command", commandId, command: wire })
  }

  /** Resends an in-flight command under its id; a create gets a fresh enrollment token. */
  private async resend(row: NestBoxRow): Promise<void> {
    if (row.pendingId === null || row.pendingCommand === null || row.hostId === null) return
    const stored = row.pendingCommand
    if (stored._tag !== "create") {
      this.link.send(row.hostId, { _tag: "command", commandId: row.pendingId, command: stored })
      return
    }
    const token = await this.issueToken(row)
    saveNestBox(this.sql, row)
    this.link.send(row.hostId, { _tag: "command", commandId: row.pendingId, command: { ...stored, enrollToken: token } })
  }

  private async issueToken(row: NestBoxRow): Promise<string> {
    const token = newEnrollToken()
    row.enrollHash = await enrollTokenHash(token)
    row.enrollExpiresAt = this.clock() + NEST_ENROLL_TOKEN_TTL_MS
    return token
  }

  private clearPending(row: NestBoxRow): void {
    row.pendingId = null
    row.pendingKind = null
    row.pendingCommand = null
    row.pendingDeadline = null
  }

  /** Brings a waiting box up: a suspended box on a connected host resumes there; a parked one is placed. */
  private wake(row: NestBoxRow): void {
    if (row.pendingId !== null) return
    if (row.state === "suspended" && row.hostId !== null) {
      if (!this.link.connected(row.hostId)) {
        row.wakeWanted = true
        saveNestBox(this.sql, row)
        return
      }
      this.dispatch(row, this.resumeCommand(row))
      return
    }
    if (row.state !== "parked") return
    const target = this.placement()
    if (target === null) {
      row.wakeWanted = true
      saveNestBox(this.sql, row)
      return
    }
    // A new placement: a higher epoch and a new VM incarnation, so the old host's copy is evicted on its next report.
    row.hostId = target.hostId
    row.ownerEpoch += 1
    row.vmId = crypto.randomUUID()
    this.sql.exec("UPDATE user_boxes SET url = ? WHERE id = ?", publicUrlFor(row.boxId, target.slug, this.domain), row.boxId)
    this.dispatch(row, this.resumeCommand(row))
  }

  private async wakeWanted(): Promise<void> {
    for (const row of nestBoxesWanted(this.sql)) this.wake(row)
  }

  private resumeCommand(row: NestBoxRow): NestHostCommand {
    const url = this.sql.exec<{ url: string }>("SELECT url FROM user_boxes WHERE id = ?", row.boxId).toArray()[0]?.url ?? ""
    return {
      _tag: "resume",
      boxId: row.boxId,
      userId: row.login,
      vmId: row.vmId,
      ownerEpoch: row.ownerEpoch,
      limits: row.limits,
      publicUrl: url,
      volumeRef: row.volumeRef,
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
    this.dispatch(row, { _tag: "setLimits", boxId: row.boxId, limits })
  }

  /** Forgets a destroyed box everywhere the owner can see it. */
  private forget(row: NestBoxRow): void {
    deleteNestBox(this.sql, row.boxId)
    this.sql.exec("UPDATE users SET active_box_id = NULL WHERE active_box_id = ?", row.boxId)
    this.sql.exec("DELETE FROM user_boxes WHERE id = ?", row.boxId)
  }
}
