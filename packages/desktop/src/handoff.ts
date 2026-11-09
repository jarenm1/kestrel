import { parseCallback } from "./auth"

/** What a `kestrel-desktop://auth-callback` URL did to the sign-in in progress. */
export type HandoffOutcome =
  /** Not a callback, or it did not match the sign-in this app started. Nothing was consumed. */
  | { readonly _tag: "ignored" }
  /** A newer sign-in replaced this one while its session was being stored; the previous session is restored. */
  | { readonly _tag: "superseded" }
  | { readonly _tag: "signed-in"; readonly session: string }

export interface HandoffPorts {
  /** The nonce set before redirecting to GitHub, without consuming it. */
  readonly pendingNonce: () => string | null
  /** Consumes the nonce only when it still matches; false when a newer sign-in replaced it. */
  readonly claimPendingNonce: (nonce: string) => boolean
  readonly readSession: () => Promise<string | null>
  readonly storeSession: (session: string) => Promise<void>
  readonly clearSession: () => Promise<void>
}

/**
 * The one writer of the Electron sign-in handoff. The session is stored first and the nonce consumed second, so a
 * crash between the two cannot leave a consumed nonce and no session. A stray or forged callback is compared against
 * the pending nonce without consuming it, so guessing wrong never burns the sign-in the user actually started, and a
 * nonce is single-use once its session is stored. Callers serialize calls: this function alone is not atomic.
 */
export const acceptCallback = async (value: string, ports: HandoffPorts): Promise<HandoffOutcome> => {
  const parsed = parseCallback(value)
  if (parsed === null || parsed.state === null) return { _tag: "ignored" }
  if (ports.pendingNonce() !== parsed.state) return { _tag: "ignored" }

  const previous = await ports.readSession()
  await ports.storeSession(parsed.session)

  if (!ports.claimPendingNonce(parsed.state)) {
    // A new sign-in started while this session was being written. Put the file back rather than keeping a session the
    // user's newer attempt did not authorise.
    if (previous === null) await ports.clearSession()
    else await ports.storeSession(previous)
    return { _tag: "superseded" }
  }
  return { _tag: "signed-in", session: parsed.session }
}
