/** The custom protocol the control plane uses to hand a finished sign-in back to the desktop app. */
export const CALLBACK_SCHEME = "kestrel-desktop"
/** The mobile app's scheme; the desktop uses it until a control plane has the desktop callback. */
const MOBILE_SCHEME = "kestrel"

export type CallbackPath = "/auth/desktop-callback" | "/auth/mobile-callback"

/** `kestrel-desktop://auth-callback?session=<id>` (or the mobile fallback) -> the session id. */
export const parseCallback = (value: string): string | null => {
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
  return session === null || session === "" ? null : session
}

/** The control-plane URL that starts GitHub sign-in and returns through `returnPath`. */
export const loginUrl = (controlUrl: string, returnPath: CallbackPath = "/auth/desktop-callback"): string =>
  `${controlUrl.replace(/\/+$/, "")}/auth/github/login?return=${encodeURIComponent(returnPath)}`

/**
 * Which callback the deployed control plane supports. The desktop route is preferred; a 404 means the Worker is
 * older, so the mobile route (which exists there) is used with the `kestrel://` scheme.
 */
export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>

export const callbackPath = async (controlUrl: string, fetchFn: FetchLike = fetch): Promise<CallbackPath> => {
  try {
    const response = await fetchFn(`${controlUrl.replace(/\/+$/, "")}/auth/desktop-callback`, {
      redirect: "manual",
    })
    return response.status === 404 ? "/auth/mobile-callback" : "/auth/desktop-callback"
  } catch {
    return "/auth/desktop-callback"
  }
}

/** A same-origin path from `?return=`, never an absolute or protocol-relative URL. */
export const safeLocalPath = (value: string | null): string =>
  value !== null && value.startsWith("/") && !value.startsWith("//") ? value : "/"
