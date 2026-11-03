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
  /** Comma- or whitespace-separated GitHub logins that run the managed-box fleet (`/api/fleet/boxes`). */
  KESTREL_OPERATORS?: string
}

/** RPC stub for the single control-plane Hub instance. */
export const hub = (env: Env) => env.HUB.get(env.HUB.idFromName("main"))

/** Whether `login` is one of `KESTREL_OPERATORS`; GitHub logins compare case-insensitively. */
export const isOperator = (env: Env, login: string): boolean =>
  (env.KESTREL_OPERATORS ?? "").split(/[\s,]+/).some((op) => op !== "" && op.toLowerCase() === login.toLowerCase())

/**
 * Worker -> Hub only: the caller's session id (from the session cookie). The Hub resolves it, attaches credentials and
 * relays, all in the one Durable Object request. Whatever a browser sends in
 * this header is overwritten by the Worker.
 */
export const SESSION_HEADER = "x-kestrel-session"

/**
 * Worker -> Hub only: a `FileToken` the Worker accepted as `?access_token=` on a box file (`isBoxFilePath`). The Hub
 * resolves it to its user, drops it and the query parameter, and relays the file with that user's credentials. Whatever
 * a browser sends in this header is overwritten or dropped by the Worker.
 */
export const FILE_TOKEN_HEADER = "x-kestrel-file-token"
