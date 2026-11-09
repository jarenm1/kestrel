import type { PendingPairing } from "@cloudagents/protocol"
import { ApiError } from "@/api/errors"

/** While a code is pending, the page re-reads it at this interval: approval elsewhere or expiry becomes visible. */
export const PAIRING_POLL_MS = 2000

export type PairingPhase =
  | { readonly _tag: "pending"; readonly pending: PendingPairing }
  | { readonly _tag: "approved" }
  | { readonly _tag: "expired" }

/**
 * The approval page's phase. Approval wins over whichever code it came from; a code is expired at its `expiresAt`
 * (the control plane's TTL) or as soon as the server answers 404, so the form is never left editable past it.
 */
export function pairingPhase(
  pending: PendingPairing | undefined,
  approved: boolean,
  now: number,
  gone = false,
): PairingPhase | undefined {
  if (approved) return { _tag: "approved" }
  if (pending === undefined) return undefined
  return gone || Date.parse(pending.expiresAt) <= now ? { _tag: "expired" } : { _tag: "pending", pending }
}

/**
 * Poll while the code can still change: pending, or unresolved after a transient failure. A terminal phase, a
 * permanent 404 (unknown or expired) or 409 (already approved) stops it.
 */
export function pairingPollMs(phase: PairingPhase | undefined, error: unknown): number | false {
  if (phase?._tag === "pending") return PAIRING_POLL_MS
  if (phase !== undefined) return false
  const terminal = error instanceof ApiError && (error.status === 404 || error.status === 409)
  return terminal ? false : PAIRING_POLL_MS
}
