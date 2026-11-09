/**
 * The delegation fields that form its lifecycle phase. Delivery is deliberately not here: it is the deterministic
 * result message's existence, not a duplicated flag.
 */
export interface DelegationPhase {
  readonly runId?: string
  readonly parentRunId?: string
  readonly cancelledAt?: string
  readonly resultAcknowledged: boolean
}

export type DelegationEvent =
  /** The delegated thread reserved its first run. */
  | { readonly _tag: "dispatched"; readonly runId: string }
  /** A later run continues the same delegation after a question, usage stop, or restart. */
  | { readonly _tag: "continued"; readonly runId: string }
  /** A new parent run repeats the request and takes the child over; terminal flags from the old parent are cleared. */
  | { readonly _tag: "relinked"; readonly parentRunId: string }
  /** The parent agent read the result. It is independent of delivery. */
  | { readonly _tag: "acknowledged" }
  /** The parent cancelled the child's tree; terminal for the delegation. */
  | { readonly _tag: "cancelled"; readonly at: string }

export type DelegationIllegalReason = "not-delegated" | "already-dispatched" | "terminal"

export type DelegationTransition =
  | { readonly _tag: "transitioned"; readonly phase: DelegationPhase; readonly changed: boolean }
  | { readonly _tag: "illegal"; readonly reason: DelegationIllegalReason }

/** The phase of a delegation before any dispatch, acknowledgement or cancellation. */
export const initialDelegationPhase = (): DelegationPhase => ({ resultAcknowledged: false })

const same = (a: DelegationPhase, b: DelegationPhase): boolean =>
  a.runId === b.runId &&
  a.parentRunId === b.parentRunId &&
  a.cancelledAt === b.cancelledAt &&
  a.resultAcknowledged === b.resultAcknowledged

const next = (phase: DelegationPhase, patch: Partial<DelegationPhase>): DelegationTransition => {
  const result = { ...phase, ...patch }
  return { _tag: "transitioned", phase: result, changed: !same(phase, result) }
}

/**
 * The one writer of the delegation phase fields. Acknowledgement is idempotent; a second acknowledgement is a no-op.
 * Cancellation is terminal for the delegation, but a late acknowledgement is still recorded rather than dropped: the
 * result may have reached the parent just before the cancel, and the flag is advisory. A re-link keeps a cancellation
 * terminal because it starts no new run; it only resets the acknowledgement for the new parent run.
 */
export const transitionDelegation = (phase: DelegationPhase, event: DelegationEvent): DelegationTransition => {
  switch (event._tag) {
    case "dispatched":
      if (phase.runId !== undefined) return { _tag: "illegal", reason: "already-dispatched" }
      if (phase.cancelledAt !== undefined) return { _tag: "illegal", reason: "terminal" }
      return next(phase, { runId: event.runId })
    case "continued":
      if (phase.cancelledAt !== undefined || phase.resultAcknowledged) {
        return { _tag: "illegal", reason: "terminal" }
      }
      return next(phase, { runId: event.runId })
    case "relinked":
      return next(phase, {
        parentRunId: event.parentRunId,
        resultAcknowledged: false,
      })
    case "acknowledged":
      if (phase.resultAcknowledged) return { _tag: "transitioned", phase, changed: false }
      return next(phase, { resultAcknowledged: true })
    case "cancelled":
      if (phase.cancelledAt !== undefined) return { _tag: "transitioned", phase, changed: false }
      return next(phase, { cancelledAt: event.at })
    default: {
      const exhaustive: never = event
      return exhaustive
    }
  }
}
