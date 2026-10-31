/**
 * HTTP base URL of the Kestrel control plane, without a trailing slash.
 * Same-origin by default (the Worker serves the SPA and the API); VITE_CLOUDAGENTS_SERVER overrides it at build time.
 */
export const SERVER_URL: string = (import.meta.env.VITE_CLOUDAGENTS_SERVER || window.location.origin).replace(
  /\/+$/,
  "",
)

