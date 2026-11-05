/** The custom protocol the control plane uses to hand a finished sign-in back to the desktop app. */
export const CALLBACK_SCHEME = "kestrel-desktop"
/** The mobile app's scheme; the desktop uses it until a control plane has the desktop callback. */
const MOBILE_SCHEME = "kestrel"

export type CallbackPath = "/auth/desktop-callback" | "/auth/mobile-callback"

/** `kestrel-desktop://auth-callback?session=<id>&state=<nonce>` (or the mobile fallback) -> the session id and nonce. */
export const parseCallback = (value: string): { session: string; state: string | null } | null => {
  let url: URL
  try {
    url = new URL(value)
  } catch {
    return null
  }
  if ((url.protocol !== `${CALLBACK_SCHEME}:` && url.protocol !== `${MOBILE_SCHEME}:`) || url.hostname !== "auth-callback") {
    return null
  }
  const session = url.searchParams.get("session")
  if (session === null || session === "") return null
  return { session, state: url.searchParams.get("state") }
}

/** The control-plane URL that starts GitHub sign-in and returns through `returnPath`, bound to a one-time `state`. */
export const loginUrl = (controlUrl: string, returnPath: CallbackPath = "/auth/desktop-callback", state?: string): string =>
  `${controlUrl.replace(/\/+$/, "")}/auth/github/login?return=${encodeURIComponent(returnPath)}${state === undefined ? "" : `&state=${encodeURIComponent(state)}`}`

/**
 * Which callback the deployed control plane supports. The desktop route is preferred; a 404 means the Worker is
 * older, so the mobile route (which exists there) is used with the `kestrel://` scheme.
 */
export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>

export const callbackPath = async (_controlUrl: string, _fetchFn: FetchLike = fetch): Promise<CallbackPath> => "/auth/desktop-callback"

/** A same-origin path from `?return=`, never an absolute or protocol-relative URL. */
export const safeLocalPath = (value: string | null): string =>
  value !== null && value.startsWith("/") && !value.startsWith("//") ? value : "/"
