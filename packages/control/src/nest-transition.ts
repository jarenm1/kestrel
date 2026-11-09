import type { NestHostCommand, NestVmReport, NestVmState } from "@cloudagents/protocol"
import type { NestBoxRow } from "./nest-table"

/** The parts of a Nest box row that form its placement/lifecycle phase. */
export interface NestBoxPhase {
  readonly state: NestVmState
  readonly createFailed: boolean
  readonly hostId: string | null
  readonly vmSince: number | null
  readonly pendingId: string | null
}

export type NestBoxEvent =
  /** The host's truth for a VM. Epoch/host/vm-incarnation ordering is decided before this event. */
  | { readonly _tag: "vmReported"; readonly report: NestVmReport }
  /** A pending command's outcome. `owed` means the host refused it for a lapse and will resend it. */
  | {
      readonly _tag: "commandResult"
      readonly kind: NestHostCommand["_tag"]
      readonly ok: boolean
      readonly owed: boolean
      readonly vmPresent: boolean
    }

export type NestBoxIllegalReason =
  | "report-stale"
  | "state-regression"
  | "not-pending"
  | "create-failed-on-live-vm"

export type NestBoxTransition =
  | { readonly _tag: "transitioned"; readonly phase: NestBoxPhase; readonly changed: boolean }
  /** `phase` is what a log-and-continue caller would write; stale reports carry the unchanged phase and must be dropped. */
  | { readonly _tag: "illegal"; readonly reason: NestBoxIllegalReason; readonly phase: NestBoxPhase }

/** The phase fields the report writer owns; other report metadata is written beside it. */
export const nestBoxPhaseOf = (row: NestBoxRow): NestBoxPhase => ({
  state: row.state,
  createFailed: row.createFailed,
  hostId: row.hostId,
  vmSince: row.vmSince,
  pendingId: row.pendingId,
})

/** The states a VM report may move to. A `deleted` report is terminal and handled before this module. */
const LEGAL_NEXT: Readonly<Record<NestVmState, readonly NestVmState[]>> = {
  provisioning: ["provisioning", "running"],
  running: ["running", "suspended", "parked"],
  suspended: ["suspended", "running", "parked"],
  parked: ["parked", "running"],
  deleted: [],
}

const nextPhase = (phase: NestBoxPhase, report: NestVmReport): NestBoxPhase => ({
  state: report.state,
  // A failed create keeps its flag while the VM is still provisioning; a VM that is up clears it.
  createFailed: report.state === "provisioning" ? phase.createFailed : false,
  // A parked report with nothing in flight releases the box from this host. While a command is in flight the claim
  // stays until that command's result settles, since the two frames may arrive in either order.
  hostId: report.state === "parked" && phase.pendingId === null ? null : phase.hostId,
  vmSince: report.since,
  pendingId: phase.pendingId,
})

/**
 * The one writer of the box state a report owns. `since` is a monotonic guard (D10): an older report is dropped even
 * when its epoch/host/vm still match. A state edge outside the table is returned as illegal with the phase the old
 * direct writer produced, so production can log and continue until the loud path is proven; tests can assert it.
 */
export const transitionNestBox = (phase: NestBoxPhase, event: NestBoxEvent): NestBoxTransition => {
  if (event._tag === "commandResult") {
    if (phase.pendingId === null) return { _tag: "illegal", reason: "not-pending", phase }
    // A create result that reaches a VM which already exists must not tell the owner it has no VM.
    if (event.kind === "create" && !event.owed && phase.state !== "provisioning") {
      return { _tag: "illegal", reason: "create-failed-on-live-vm", phase }
    }
    const next: NestBoxPhase = {
      ...phase,
      // A create refused for a lapse ran nothing, so it is owed a resend and the box is not failed yet.
      createFailed: event.kind === "create" && !event.owed ? !event.ok : phase.createFailed,
      // A parked box with nothing in flight is held by no host. A result that carries a VM report is applied by the
      // report writer, which releases the claim only on a parked report.
      hostId: !event.vmPresent && phase.state === "parked" ? null : phase.hostId,
    }
    return {
      _tag: "transitioned",
      phase: next,
      changed: next.createFailed !== phase.createFailed || next.hostId !== phase.hostId,
    }
  }
  const report = event.report
  if (phase.vmSince !== null && report.since < phase.vmSince) {
    return { _tag: "illegal", reason: "report-stale", phase }
  }
  const next = nextPhase(phase, report)
  if (!LEGAL_NEXT[phase.state].includes(report.state)) {
    return { _tag: "illegal", reason: "state-regression", phase: next }
  }
  return {
    _tag: "transitioned",
    phase: next,
    changed:
      next.state !== phase.state ||
      next.createFailed !== phase.createFailed ||
      next.hostId !== phase.hostId ||
      next.vmSince !== phase.vmSince ||
      next.pendingId !== phase.pendingId,
  }
}

/** Writes the report-owned phase fields to a row-like record. */
export const applyNestBoxEvent = (row: NestBoxRow, event: NestBoxEvent): NestBoxTransition => {
  const transition = transitionNestBox(nestBoxPhaseOf(row), event)
  const phase = transition.phase
  row.state = phase.state
  row.createFailed = phase.createFailed
  row.hostId = phase.hostId
  row.vmSince = phase.vmSince
  row.pendingId = phase.pendingId
  return transition
}
