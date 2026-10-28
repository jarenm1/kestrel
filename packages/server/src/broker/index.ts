import { Context, Effect, Layer } from "effect"
import { randomBytes, timingSafeEqual } from "node:crypto"
import { Config } from "../config"
import { CredentialStore } from "../credentials"

export type BrokerProvider = "anthropic" | "openai"

export const BROKER_PROVIDERS: ReadonlyArray<BrokerProvider> = ["anthropic", "openai"]

export const UPSTREAM_BASE: Record<BrokerProvider, string> = {
  anthropic: "https://api.anthropic.com",
  openai: "https://api.openai.com",
}

/** A live broker token: the run it was minted for and the user who started that run. */
export interface BrokerGrant {
  readonly runId: string
  readonly user: string
}

/** What a run gets for its token: the token itself, and the env that points the sandboxed agent at the broker. */
export interface BrokerLease {
  readonly token: string
  readonly env: Readonly<Record<string, string>>
}

export interface CredentialBrokerShape {
  /** Mints a per-run token. */
  readonly issue: (runId: string, user: string) => Effect.Effect<BrokerLease>
  /** Invalidates the run's token and notifies revoke listeners. Idempotent. */
  readonly revoke: (runId: string) => Effect.Effect<void>
  /** Grant for a live token; null when unknown or revoked. */
  readonly grantForToken: (token: string) => Effect.Effect<BrokerGrant | null>
  /** Calls `listener` with the run id each time a run's token is revoked. Returns the unsubscribe. */
  readonly onRevoke: (listener: (runId: string) => void) => () => void
  /** Real upstream key: the run user's control-plane credential first, then the host's env var. */
  readonly upstreamKey: (provider: BrokerProvider, user: string) => Effect.Effect<string | null>
}

export class CredentialBroker extends Context.Tag("cloudagents/CredentialBroker")<
  CredentialBroker,
  CredentialBrokerShape
>() {}

const HOST_ENV_KEY: Record<BrokerProvider, string> = {
  anthropic: "ANTHROPIC_API_KEY",
  openai: "OPENAI_API_KEY",
}

export const CredentialBrokerLive = Layer.effect(
  CredentialBroker,
  Effect.gen(function* () {
    const config = yield* Config
    const store = yield* CredentialStore
    const grantByToken = new Map<string, BrokerGrant>()
    const tokenByRun = new Map<string, string>()
    const revokeListeners = new Set<(runId: string) => void>()

    const revokeSync = (runId: string) => {
      const token = tokenByRun.get(runId)
      if (token === undefined) return
      tokenByRun.delete(runId)
      grantByToken.delete(token)
      for (const listener of revokeListeners) listener(runId)
    }

    /** Scans every live token without exiting early, so the lookup time does not reveal which token matched. */
    const grantFor = (token: string): BrokerGrant | null => {
      const candidate = Buffer.from(token)
      let found: BrokerGrant | null = null
      for (const [live, grant] of grantByToken) {
        const liveBytes = Buffer.from(live)
        if (liveBytes.length === candidate.length && timingSafeEqual(liveBytes, candidate)) found = grant
      }
      return found
    }

    const broker: CredentialBrokerShape = {
      issue: (runId, user) =>
        Effect.sync(() => {
          revokeSync(runId)
          const token = randomBytes(24).toString("base64url")
          grantByToken.set(token, { runId, user })
          tokenByRun.set(runId, token)
          const base = `http://127.0.0.1:${config.port}/broker/${token}`
          return {
            token,
            env: {
              ANTHROPIC_BASE_URL: `${base}/anthropic`,
              ANTHROPIC_API_KEY: token,
              OPENAI_BASE_URL: `${base}/openai`,
              OPENAI_API_KEY: token,
            },
          }
        }),
      revoke: (runId) => Effect.sync(() => revokeSync(runId)),
      grantForToken: (token) => Effect.sync(() => grantFor(token)),
      onRevoke: (listener) => {
        revokeListeners.add(listener)
        return () => {
          revokeListeners.delete(listener)
        }
      },
      upstreamKey: (provider, user) =>
        Effect.gen(function* () {
          const creds = yield* store.get(user)
          const fromStore = creds?.[provider]
          if (fromStore) return fromStore
          const fromEnv = process.env[HOST_ENV_KEY[provider]]
          return fromEnv && fromEnv.trim() !== "" ? fromEnv : null
        }),
    }
    return broker
  }),
)
