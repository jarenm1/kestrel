import type { Hub } from "./hub"

export interface Env {
  /** Static assets (the SPA build in ./dist). */
  ASSETS: Fetcher
  /** Singleton control-plane Durable Object. */
  HUB: DurableObjectNamespace<Hub>
  /** Comma-separated GitHub logins allowed to use Kestrel. */
  ALLOWED_GITHUB_LOGINS?: string
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
  /**
   * The domain Nest boxes are served under (`<boxId>.<host slug>.<domain>`). Unset disables Nest: the Nest routes 404
   * and `Me.nestEnabled` is false.
   */
  KESTREL_NEST_DOMAIN?: string
  /**
   * A JSON price list for Nest box estimates, such as `{"currency":"USD","vcpuHour":0.05,...}`. Unset uses the proposed
   * shadow-billing defaults; an invalid value leaves estimates off rather than breaking the box list.
   */
  KESTREL_NEST_RATES?: string
  /**
   * Cloudflare Realtime TURN key id and provider API token, for `POST /box/turn`. Both unset: boxes get 204 and keep
   * their own TURN configuration. One without the other: the route answers 502, naming both.
   */
  KESTREL_TURN_KEY_ID?: string
  KESTREL_TURN_API_TOKEN?: string
}

/** RPC stub for the single control-plane Hub instance. */
export const hub = (env: Env) => env.HUB.get(env.HUB.idFromName("main"))

/** Fail closed when the allowlist is missing; local dev sessions are explicitly enabled separately. */
export const isAllowedLogin = (env: Env, login: string, dev = false): boolean =>
  (dev && !!env.DEV_SESSION_LOGIN) ||
  (env.ALLOWED_GITHUB_LOGINS ?? "").split(",").some((entry) => entry.trim() !== "" && entry.trim().toLowerCase() === login.toLowerCase())

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
