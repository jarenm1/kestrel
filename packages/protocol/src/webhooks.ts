import { Schema } from "effect"

/**
 * Webhook automations: a stable gateway URL per automation that accepts a sender's POST and starts a thread on the
 * owner's box. A delivery is durably accepted (and answered `202`) before the box sees it; delivery then retries
 * only against the same target and never reroutes an attempt whose outcome is unknown.
 */

/** Limits enforced by the control plane. Provisional until measured; tune them here, not at call sites. */
export const WEBHOOK_LIMITS = {
  /** Largest accepted request body, in bytes. Larger bodies are answered `413` before any delivery is stored. */
  maxBodyBytes: 64 * 1024,
  /** Largest sender `Idempotency-Key`, in characters. */
  maxSenderDeliveryIdLength: 128,
  /** Accepted deliveries per automation per minute. */
  perAutomationPerMinute: 30,
  /** Accepted deliveries per owner per minute. */
  perOwnerPerMinute: 120,
  /** Accepted deliveries per owner per day. */
  perOwnerPerDay: 2000,
  /** Requests per automation per minute that fail authentication (guards the secret against guessing). */
  failedAuthPerAutomationPerMinute: 60,
  /** Requests per minute across the whole gateway, authenticated or not. */
  globalPerMinute: 3000,
  /** Delivery attempts before a delivery fails for good (ambiguous attempts count too). */
  maxAttempts: 10,
  /** First retry delay; doubles per attempt up to `backoffCapMs`. */
  backoffBaseMs: 30_000,
  backoffCapMs: 30 * 60_000,
  /** A delivery that has not reached the box within this window expires and its payload is purged. */
  windowMs: 24 * 60 * 60_000,
  /** Recent terminal deliveries kept per automation for the owner's delivery list. */
  deliveriesKept: 50,
} as const

/** Request headers the gateway reads. Either the bearer secret or the signature authenticates a request. */
export const WEBHOOK_HEADERS = {
  /** `Authorization: Bearer <secret>`. */
  authorization: "authorization",
  /** `X-Kestrel-Signature: sha256=<hex HMAC-SHA256(secret, raw body)>`, for senders that sign payloads. */
  signature: "x-kestrel-signature",
  /** Sender's delivery id; a repeat within the window is answered with the first delivery, not run again. */
  senderDeliveryId: "idempotency-key",
} as const

/** What to do when the target box is not available: keep retrying it until the window closes, or fail at once. */
export const WebhookOnUnavailable = Schema.Literal("retry", "fail")
export type WebhookOnUnavailable = typeof WebhookOnUnavailable.Type

/** Where a webhook's deliveries go. `preferredBoxId` null = the Kestrel box; otherwise one of the owner's own boxes. */
export const WebhookSettings = Schema.Struct({
  preferredBoxId: Schema.NullOr(Schema.String),
  onUnavailable: WebhookOnUnavailable,
})
export type WebhookSettings = typeof WebhookSettings.Type

/** A webhook automation's public endpoint. `secret` is never returned here; see `WebhookRotated`. */
export const WebhookEndpoint = Schema.Struct({
  url: Schema.String,
  preferredBoxId: Schema.NullOr(Schema.String),
  onUnavailable: WebhookOnUnavailable,
})
export type WebhookEndpoint = typeof WebhookEndpoint.Type

/** The new secret, shown once. The previous secret stops working the moment this is returned. */
export const WebhookRotated = Schema.Struct({
  url: Schema.String,
  secret: Schema.String,
})
export type WebhookRotated = typeof WebhookRotated.Type

/**
 * `accepted` stored, not yet attempted. `delivering` an attempt is in flight. `retrying` waiting for the next attempt
 * after the target did not take it. `ambiguous` an attempt's outcome is unknown; reconciled against the same target
 * only. `delivered` the box holds the run (terminal). `failed` will not be retried (terminal). `expired` the window
 * closed first (terminal). Payloads are purged once terminal.
 */
export const WebhookDeliveryStatus = Schema.Literal(
  "accepted",
  "delivering",
  "retrying",
  "ambiguous",
  "delivered",
  "failed",
  "expired",
)
export type WebhookDeliveryStatus = typeof WebhookDeliveryStatus.Type

export const WebhookDelivery = Schema.Struct({
  /** Kestrel's delivery id: the stable idempotency key the box sees. */
  id: Schema.String,
  automationId: Schema.String,
  receivedAt: Schema.String, // ISO-8601
  updatedAt: Schema.String, // ISO-8601
  status: WebhookDeliveryStatus,
  /** The target box: null = the Kestrel box. */
  boxId: Schema.NullOr(Schema.String),
  taskId: Schema.NullOr(Schema.String),
  runId: Schema.NullOr(Schema.String),
  error: Schema.NullOr(Schema.String),
  attempts: Schema.Number,
  /** The sender's `Idempotency-Key`, when it sent one. */
  senderDeliveryId: Schema.NullOr(Schema.String),
  /** Same wording as `AutomationRun.reason`, e.g. "webhook". */
  reason: Schema.String,
})
export type WebhookDelivery = typeof WebhookDelivery.Type

/** The gateway's answer to an accepted request. `duplicate` true = the sender's id matched an earlier delivery. */
export const WebhookAccepted = Schema.Struct({
  id: Schema.String,
  status: WebhookDeliveryStatus,
  duplicate: Schema.Boolean,
})
export type WebhookAccepted = typeof WebhookAccepted.Type
