import type { NestHostCommand, NestVmReport, NestVmState } from "@cloudagents/protocol"
import type { NestBoxRow, StoredNestCommand } from "./nest-table"

/** The parts of a Nest box row that form its placement/lifecycle phase. */
export interface NestBoxPhase {
  readonly state: NestVmState
  readonly createFailed: boolean
  readonly hostId: string | null
  readonly ownerEpoch: number
  readonly vmId: string
  readonly vmSince: number | null
  readonly wakeWanted: boolean
  readonly pendingId: string | null
  readonly pendingKind: NestHostCommand["_tag"] | null
  readonly pendingCommand: StoredNestCommand | null
  readonly pendingDeadline: number | null
}

export type NestBoxEvent =
  /** The host's truth for a VM. Epoch/host/vm-incarnation ordering is decided before this event. */
  | { readonly _tag: "vmReported"; readonly report: NestVmReport }
  /** A command was sent and recorded as in flight. */
  | {
      readonly _tag: "commandDispatched"
      readonly commandId: string
      readonly command: StoredNestCommand
      readonly deadline: number | null
    }
  /** The link refused the command before it was recorded. */
  | { readonly _tag: "commandSendRefused"; readonly kind: NestHostCommand["_tag"] }
  /** A pending command's outcome. `owed` means the host refused it for a lapse and will resend it. */
  | {
      readonly _tag: "commandResult"
      readonly ok: boolean
      readonly owed: boolean
      readonly vmPresent: boolean
    }
  /** The in-flight command's deadline passed. */
  | { readonly _tag: "deadlineElapsed" }
  /** Ingress or the wake loop wants this box up. */
  | { readonly _tag: "wakeRequested" }
  | { readonly _tag: "wakeHeld" }
  /** A parked box goes to a host at a new epoch/VM incarnation. */
  | {
      readonly _tag: "placementChosen"
      readonly hostId: string
      readonly ownerEpoch: number
      readonly vmId: string
    }
  /** A claimless parked box is attached to a host for an owner action. */
  | { readonly _tag: "claimMoved"; readonly hostId: string }

export type NestBoxIllegalReason =
  | "report-stale"
  | "state-regression"
  | "not-pending"
  | "already-pending"
  | "create-failed-on-live-vm"
  | "not-parked"
  | "no-host"

export type NestBoxTransition =
  | { readonly _tag: "transitioned"; readonly phase: NestBoxPhase; readonly changed: boolean }
  /** `phase` is what a log-and-continue caller would write; stale reports carry the unchanged phase and must be dropped. */
  | { readonly _tag: "illegal"; readonly reason: NestBoxIllegalReason; readonly phase: NestBoxPhase }

export const nestBoxPhaseOf = (row: NestBoxRow): NestBoxPhase => ({
  state: row.state,
  createFailed: row.createFailed,
  hostId: row.hostId,
  ownerEpoch: row.ownerEpoch,
  vmId: row.vmId,
  vmSince: row.vmSince,
  wakeWanted: row.wakeWanted,
  pendingId: row.pendingId,
  pendingKind: row.pendingKind,
  pendingCommand: row.pendingCommand,
  pendingDeadline: row.pendingDeadline,
})

const same = (a: NestBoxPhase, b: NestBoxPhase): boolean =>
  a.state === b.state &&
  a.createFailed === b.createFailed &&
  a.hostId === b.hostId &&
  a.ownerEpoch === b.ownerEpoch &&
  a.vmId === b.vmId &&
  a.vmSince === b.vmSince &&
  a.wakeWanted === b.wakeWanted &&
  a.pendingId === b.pendingId &&
  a.pendingKind === b.pendingKind &&
  a.pendingCommand === b.pendingCommand &&
  a.pendingDeadline === b.pendingDeadline

const next = (phase: NestBoxPhase, patch: Partial<NestBoxPhase>): NestBoxTransition => {
  const result = { ...phase, ...patch }
  return { _tag: "transitioned", phase: result, changed: !same(phase, result) }
}

const cleared = (phase: NestBoxPhase): Partial<NestBoxPhase> => ({
  pendingId: null,
  pendingKind: null,
  pendingCommand: null,
  pendingDeadline: null,
})

/** The states a VM report may move to. A `deleted` report is terminal and handled before this module. */
const LEGAL_NEXT: Readonly<Record<NestVmState, readonly NestVmState[]>> = {
  provisioning: ["provisioning", "running"],
  running: ["running", "suspended", "parked"],
  suspended: ["suspended", "running", "parked"],
  parked: ["parked", "running"],
  deleted: [],
}

const reported = (phase: NestBoxPhase, report: NestVmReport): NestBoxPhase => ({
  ...phase,
  state: report.state,
  // A failed create keeps its flag while the VM is still provisioning; a VM that is up clears it.
  createFailed: report.state === "provisioning" ? phase.createFailed : false,
  // A parked report with nothing in flight releases the box from this host. While a command is in flight the claim
  // stays until that command's result settles, since the two frames may arrive in either order.
  hostId: report.state === "parked" && phase.pendingId === null ? null : phase.hostId,
  vmSince: report.since,
})

/**
 * The one writer of a Nest box's placement, command and wake phase. `since` is a monotonic guard (D10); pending
 * commands and wakes are intent, kept in the same phase so a marker cannot outlive the command it described.
 */
export const transitionNestBox = (phase: NestBoxPhase, event: NestBoxEvent): NestBoxTransition => {
  switch (event._tag) {
    case "vmReported": {
      if (phase.vmSince !== null && event.report.since < phase.vmSince) {
        return { _tag: "illegal", reason: "report-stale", phase }
      }
      const result = reported(phase, event.report)
      if (!LEGAL_NEXT[phase.state].includes(event.report.state)) {
        return { _tag: "illegal", reason: "state-regression", phase: result }
      }
      return next(phase, result)
    }
    case "commandDispatched":
      if (phase.pendingId !== null) return { _tag: "illegal", reason: "already-pending", phase }
      if (phase.hostId === null) return { _tag: "illegal", reason: "no-host", phase }
      return next(phase, {
        pendingId: event.commandId,
        pendingKind: event.command._tag,
        pendingCommand: event.command,
        pendingDeadline: event.deadline,
        wakeWanted: false,
      })
    case "commandSendRefused":
      if (phase.pendingId !== null) return { _tag: "illegal", reason: "already-pending", phase }
      if (event.kind === "create") {
        // The host holds no VM: do not leave the owner holding a claim for a box that does not exist.
        return next(phase, { createFailed: true, hostId: null })
      }
      return next(phase, event.kind === "resume" ? { wakeWanted: true } : {})
    case "commandResult": {
      const kind = phase.pendingKind
      // A consumed result always clears its marker, even when the edge is illegal; otherwise a live VM keeps the box
      // IN_FLIGHT until the deadline, and a later deadline can orphan it.
      if (phase.pendingId === null) return { _tag: "illegal", reason: "not-pending", phase }
      if (kind === null) {
        return { _tag: "illegal", reason: "not-pending", phase: { ...phase, ...cleared(phase) } }
      }
      if (kind === "create" && !event.owed && phase.state !== "provisioning") {
        return { _tag: "illegal", reason: "create-failed-on-live-vm", phase: { ...phase, ...cleared(phase) } }
      }
      const createFailedNow = kind === "create" && !event.owed
      return next(phase, {
        ...cleared(phase),
        createFailed: createFailedNow ? !event.ok : phase.createFailed,
        // A failed create with no VM leaves no work for the host; a parked result also releases it.
        hostId:
          !event.vmPresent && (phase.state === "parked" || (createFailedNow && !event.ok)) ? null : phase.hostId,
      })
    }
    case "deadlineElapsed": {
      const kind = phase.pendingKind
      if (phase.pendingId === null) return { _tag: "illegal", reason: "not-pending", phase }
      if (kind === null) {
        return { _tag: "illegal", reason: "not-pending", phase: { ...phase, ...cleared(phase) } }
      }
      if (kind === "create") {
        // A timeout does not prove the host made no VM: a late running report from the same host must still land.
        return next(phase, { ...cleared(phase), createFailed: true })
      }
      if (kind === "resume") return next(phase, { ...cleared(phase), wakeWanted: true })
      return next(phase, {
        ...cleared(phase),
        hostId: (kind === "park" || kind === "destroy") && phase.state === "parked" ? null : phase.hostId,
      })
    }
    case "wakeRequested":
    case "wakeHeld":
      return next(phase, { wakeWanted: true })
    case "placementChosen":
      if (phase.state !== "parked") return { _tag: "illegal", reason: "not-parked", phase }
      if (phase.pendingId !== null) return { _tag: "illegal", reason: "already-pending", phase }
      return next(phase, {
        hostId: event.hostId,
        ownerEpoch: event.ownerEpoch,
        vmId: event.vmId,
        // `since` comes from the reporting host's clock and is only comparable within one VM incarnation.
        vmSince: null,
      })
    case "claimMoved":
      if (phase.hostId !== null) return { _tag: "illegal", reason: "already-pending", phase }
      return next(phase, { hostId: event.hostId })
    default: {
      const exhaustive: never = event
      return exhaustive
    }
  }
}

/** Writes the phase fields to a row-like record. */
export const applyNestBoxEvent = (row: NestBoxRow, event: NestBoxEvent): NestBoxTransition => {
  const transition = transitionNestBox(nestBoxPhaseOf(row), event)
  const phase = transition.phase
  row.state = phase.state
  row.createFailed = phase.createFailed
  row.hostId = phase.hostId
  row.ownerEpoch = phase.ownerEpoch
  row.vmId = phase.vmId
  row.vmSince = phase.vmSince
  row.wakeWanted = phase.wakeWanted
  row.pendingId = phase.pendingId
  row.pendingKind = phase.pendingKind
  row.pendingCommand = phase.pendingCommand
  row.pendingDeadline = phase.pendingDeadline
  return transition
}
