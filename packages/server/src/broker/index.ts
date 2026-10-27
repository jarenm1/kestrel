import { Context, Effect, Layer } from "effect"
import { randomBytes } from "node:crypto"
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

export interface CredentialBrokerShape {
  /** Mints a per-run token and returns the env the sandboxed agent uses to reach the broker. */
  readonly issue: (runId: string, user: string) => Effect.Effect<Record<string, string>>
  /** Invalidates the run's token. Idempotent. */
  readonly revoke: (runId: string) => Effect.Effect<void>
  /** Grant for a live token; null when unknown or revoked. */
  readonly grantForToken: (token: string) => Effect.Effect<BrokerGrant | null>
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

    const revokeSync = (runId: string) => {
      const token = tokenByRun.get(runId)
      if (token === undefined) return
      tokenByRun.delete(runId)
      grantByToken.delete(token)
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
            ANTHROPIC_BASE_URL: `${base}/anthropic`,
            ANTHROPIC_API_KEY: token,
            OPENAI_BASE_URL: `${base}/openai`,
            OPENAI_API_KEY: token,
          }
        }),
      revoke: (runId) => Effect.sync(() => revokeSync(runId)),
      grantForToken: (token) => Effect.sync(() => grantByToken.get(token) ?? null),
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
