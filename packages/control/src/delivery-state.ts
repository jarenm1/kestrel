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

/** The webhook ledger: a delivery id is either absent or seen. */
export interface WebhookPhase {
  readonly seen: boolean
}

export type WebhookEvent = { readonly _tag: "deliver" }

export type WebhookTransition = {
  readonly _tag: "transitioned"
  readonly phase: WebhookPhase
  readonly changed: boolean
  readonly action: "insert" | "none"
}

/** The delivery decision: a seen id is a duplicate, not a second insert. Retention stays a storage concern. */
export const transitionWebhook = (phase: WebhookPhase, _event: WebhookEvent): WebhookTransition =>
  phase.seen
    ? { _tag: "transitioned", phase, changed: false, action: "none" }
    : { _tag: "transitioned", phase: { seen: true }, changed: true, action: "insert" }

/** One queued PR activity row. `deliveryId` is the freshness token that protects a newer event. */
export interface PrActivityPhase {
  readonly attempts: number
  readonly deliveryId: string | null
  readonly dueAt: number | null
}

export type PrActivityEvent =
  | { readonly _tag: "claimed"; readonly deliveryId: string; readonly dueAt: number }
  | { readonly _tag: "delivered" }
  | { readonly _tag: "dropped" }
  | {
      readonly _tag: "retry"
      readonly attempt: number
      readonly dueAt: number
      readonly maxAttempts: number
    }

export type PrActivityTransition = {
  readonly _tag: "transitioned"
  readonly phase: PrActivityPhase
  readonly changed: boolean
  readonly action: "upsert" | "update" | "delete" | "none"
}

/** The queue's one writer: a claim resets the retry budget, and delivery/drop is terminal. */
export const transitionPrActivity = (phase: PrActivityPhase, event: PrActivityEvent): PrActivityTransition => {
  switch (event._tag) {
    case "claimed":
      return {
        _tag: "transitioned",
        phase: { attempts: 0, deliveryId: event.deliveryId, dueAt: event.dueAt },
        changed: true,
        action: "upsert",
      }
    case "delivered":
    case "dropped":
      return { _tag: "transitioned", phase, changed: true, action: "delete" }
    case "retry":
      if (event.attempt >= event.maxAttempts) {
        return { _tag: "transitioned", phase: { ...phase, attempts: event.attempt }, changed: true, action: "delete" }
      }
      return {
        _tag: "transitioned",
        phase: { ...phase, attempts: event.attempt, dueAt: event.dueAt },
        changed: true,
        action: "update",
      }
    default: {
      const exhaustive: never = event
      return exhaustive
    }
  }
}
