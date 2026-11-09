/**
 * The delegation fields that form its lifecycle phase. Delivery is deliberately not here: it is the deterministic
 * result message's existence, not a duplicated flag.
 */
export interface DelegationPhase {
  readonly cancelledAt?: string
  readonly resultAcknowledged: boolean
}

export type DelegationEvent =
  /** The parent agent read the result. It is independent of delivery. */
  | { readonly _tag: "acknowledged" }
  /** The parent cancelled the child's tree; terminal for the delegation. */
  | { readonly _tag: "cancelled"; readonly at: string }

export type DelegationTransition =
  | { readonly _tag: "transitioned"; readonly phase: DelegationPhase; readonly changed: boolean }
  | { readonly _tag: "illegal"; readonly reason: "not-delegated" }

/** The phase of a delegation before any acknowledgement or cancellation. */
export const initialDelegationPhase = (): DelegationPhase => ({ resultAcknowledged: false })

/**
 * The one writer of the delegation phase fields. Acknowledgement is idempotent; a second acknowledgement is a no-op.
 * Cancellation is terminal for the delegation, but a late acknowledgement is still recorded rather than dropped: the
 * result may have reached the parent just before the cancel, and the flag is advisory.
 */
export const transitionDelegation = (phase: DelegationPhase, event: DelegationEvent): DelegationTransition => {
  switch (event._tag) {
    case "acknowledged":
      if (phase.resultAcknowledged) return { _tag: "transitioned", phase, changed: false }
      return { _tag: "transitioned", phase: { ...phase, resultAcknowledged: true }, changed: true }
    case "cancelled":
      if (phase.cancelledAt !== undefined) return { _tag: "transitioned", phase, changed: false }
      return { _tag: "transitioned", phase: { ...phase, cancelledAt: event.at }, changed: true }
    default: {
      const exhaustive: never = event
      return exhaustive
    }
  }
}
