/** The lifecycle fields of one durable automation fire intent. */
export interface FirePhase {
  readonly outcome: "started" | "failed" | null
  readonly startedAt: number | null
  readonly attempts: number
}

export type FireEvent =
  /** The fire is about to call the box. The caller persists the attempt before the external effect. */
  | { readonly _tag: "start"; readonly at: number; readonly maxAttempts: number }
  /** The box call settled; the outcome is terminal for this fire. */
  | { readonly _tag: "settle"; readonly status: "started" | "failed" }

export type FireIllegalReason = "settled" | "attempts-exhausted" | "conflicting-terminal-outcome"

export type FireTransition =
  | { readonly _tag: "transitioned"; readonly phase: FirePhase; readonly changed: boolean }
  | { readonly _tag: "illegal"; readonly reason: FireIllegalReason }

/** The phase of a fire that was just claimed and has not started. */
export const claimedFirePhase = (): FirePhase => ({ outcome: null, startedAt: null, attempts: 0 })

/** The phase a stored fire row currently holds. */
export const firePhaseOf = (fire: {
  readonly outcome: "started" | "failed" | null
  readonly startedAt: number | null
  readonly attempts: number
}): FirePhase => ({ outcome: fire.outcome, startedAt: fire.startedAt, attempts: fire.attempts })

/**
 * The one writer of a fire's attempt/outcome fields. A settled fire cannot start or settle again. A start past the
 * attempt bound is refused so the caller can fail it terminally instead of looping.
 */
export const applyDeliveryEvent = (phase: FirePhase, event: FireEvent): FireTransition => {
  switch (event._tag) {
    case "start":
      if (phase.outcome !== null) return { _tag: "illegal", reason: "settled" }
      if (phase.attempts >= event.maxAttempts) return { _tag: "illegal", reason: "attempts-exhausted" }
      return {
        _tag: "transitioned",
        phase: { ...phase, startedAt: event.at, attempts: phase.attempts + 1 },
        changed: true,
      }
    case "settle":
      if (phase.outcome === event.status) return { _tag: "transitioned", phase, changed: false }
      if (phase.outcome !== null) return { _tag: "illegal", reason: "conflicting-terminal-outcome" }
      return { _tag: "transitioned", phase: { ...phase, outcome: event.status }, changed: true }
    default: {
      const exhaustive: never = event
      return exhaustive
    }
  }
}
