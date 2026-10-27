/**
 * HTTP base URL of the Kestrel control plane, without a trailing slash.
 * Same-origin by default (the Worker serves the SPA and the API); VITE_CLOUDAGENTS_SERVER overrides it at build time.
 */
export const SERVER_URL: string = (import.meta.env.VITE_CLOUDAGENTS_SERVER || window.location.origin).replace(
  /\/+$/,
  "",
)

/** WebSocket base URL derived from SERVER_URL (http -> ws, https -> wss). */
export const WS_URL: string = SERVER_URL.replace(/^http/, "ws")
