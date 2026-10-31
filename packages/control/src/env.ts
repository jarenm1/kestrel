import type { Hub } from "./hub"

export interface Env {
  /** Static assets (the SPA build in ./dist). */
  ASSETS: Fetcher
  /** Singleton control-plane Durable Object. */
  HUB: DurableObjectNamespace<Hub>
  /** Shared secret the trusted managed-box service presents as `Authorization: Bearer <BOX_TOKEN>`. Never sent to a browser. */
  BOX_TOKEN?: string
  /** Origin of the managed agent box (https, or http on loopback). Unset: the managed box is unavailable (503), never relayed. */
  MANAGED_BOX_URL?: string
  /** Private P-256 signing key for managed box grants, as JWK JSON. Unset: the managed box is unavailable (503). */
  MANAGED_BOX_SIGNING_KEY?: string
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

