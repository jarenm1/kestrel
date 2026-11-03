import { Schema } from "effect"
import type { DesktopClose } from "@/desktop/session"

/** Tags every message to and from the host, so unrelated `postMessage` traffic is ignored. */
export const HOST_TYPE = "kestrel-desktop"

const HostMessage = Schema.Struct({ type: Schema.Literal(HOST_TYPE), ws: Schema.String })
const decodeHostMessage = Schema.decodeUnknownOption(Schema.Union(HostMessage, Schema.parseJson(HostMessage)))

const DESKTOP_STREAM_PATH = /^\/api\/tasks\/[^/]+\/desktop\/stream$/

/** The WebSocket URL a host message names, or null when the message is not for this viewer. */
export function hostWs(data: unknown): string | null {
  const decoded = decodeHostMessage(data)
  return decoded._tag === "Some" ? decoded.value.ws : null
}

/** The `ws` fragment value, decoded once by URLSearchParams. `hash` is `location.hash`, with or without `#`. */
export function fragmentWs(hash: string): string | null {
  return new URLSearchParams(hash.replace(/^#/, "")).get("ws")
}

/** Where the embed page is running, as `mayConnect` judges it. */
export interface EmbedContext {
  /** `location.origin`. */
  origin: string
  /** Inside the app's native WebView (`window.ReactNativeWebView`), which a web page cannot arrange. */
  bridged: boolean
  framed: "no" | "same-origin" | "cross-origin"
}

/**
 * Whether the page may stream from `ws`. The page needs no sign-in and shows whatever the URL's server sends, taking the
 * user's keystrokes in return, so a crafted link must not make it a viewer for someone else's server on the app's
 * origin. It connects only to a desktop stream, is never framed by another site, and leaves its own host only for the
 * app itself (the native WebView or the app's own frame), which names the user's box.
 */
export function mayConnect(ws: string, context: EmbedContext): boolean {
  let url: URL
  try {
    url = new URL(ws)
  } catch {
    return false
  }
  if ((url.protocol !== "wss:" && url.protocol !== "ws:") || !DESKTOP_STREAM_PATH.test(url.pathname)) return false
  if (context.framed === "cross-origin") return false
  return context.bridged || context.framed === "same-origin" || url.host === new URL(context.origin).host
}

/**
 * A close that says the socket is not authorized: 4401 is the app's unauthorized close, 401 covers a proxy that closes
 * with the HTTP status. The viewer stops until the host sends a new URL.
 */
export function isAuthClose(close: DesktopClose): boolean {
  return close.code === 4401 || close.code === 401
}

/**
 * The handshake failed. A browser gives no reason, so this may be an expired token or a box or network that is down:
 * the viewer keeps retrying, and the host is asked for a new URL in case it is the token.
 */
export function isUnreachable(close: DesktopClose): boolean {
  return !close.opened && !isAuthClose(close)
}
