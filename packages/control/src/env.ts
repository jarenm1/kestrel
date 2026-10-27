import type { Hub } from "./hub"

export interface Env {
  /** Static assets (the SPA build in ./dist). */
  ASSETS: Fetcher
  /** Singleton control-plane Durable Object. */
  HUB: DurableObjectNamespace<Hub>
  /** Comma-separated GitHub logins allowed to sign in. */
  ALLOWED_GITHUB_LOGINS: string
  /** Shared secret the agent box presents as `Authorization: Bearer <BOX_TOKEN>`. */
  BOX_TOKEN?: string
  GITHUB_CLIENT_ID?: string
  GITHUB_CLIENT_SECRET?: string
  /** Dev only: when set, enables `GET /auth/dev-login` as this login. Never set in production. */
  DEV_SESSION_LOGIN?: string
}

/** RPC stub for the single control-plane Hub instance. */
export const hub = (env: Env) => env.HUB.get(env.HUB.idFromName("main"))
