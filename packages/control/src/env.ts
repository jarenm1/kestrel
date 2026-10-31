import type { Hub } from "./hub"

export interface Env {
  /** Static assets (the SPA build in ./dist). */
  ASSETS: Fetcher
  /** Singleton control-plane Durable Object. */
  HUB: DurableObjectNamespace<Hub>
  /** Shared secret the agent box presents as `Authorization: Bearer <BOX_TOKEN>`. */
  BOX_TOKEN?: string
  GITHUB_CLIENT_ID?: string
  GITHUB_CLIENT_SECRET?: string
  /** Dev only: when set, enables `GET /auth/dev-login` as this login. Never set in production. */
  DEV_SESSION_LOGIN?: string
  /**
   * Dev only: the app's origin (Vite) for links the Worker hands out, such as a box pairing's approval page. `wrangler
   * dev` rewrites request URLs to the configured route's host, so the request cannot tell. Unset in production.
   */
  APP_ORIGIN?: string
}

/** RPC stub for the single control-plane Hub instance. */
export const hub = (env: Env) => env.HUB.get(env.HUB.idFromName("main"))

/**
 * Worker -> Hub only: the caller's session id (from the session cookie). The Hub resolves it, attaches credentials and
 * relays, all in the one Durable Object request. Whatever a browser sends in
 * this header is overwritten by the Worker.
 */
export const SESSION_HEADER = "x-kestrel-session"
