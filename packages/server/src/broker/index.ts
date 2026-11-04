import { Context, Effect, Layer } from "effect"
import { randomBytes, timingSafeEqual } from "node:crypto"
import { MODEL_PROVIDERS, type ModelProvider, type RelayCredentials } from "@cloudagents/protocol"
import { Config } from "../config"
import { CredentialStore } from "../credentials"

/** Providers Kestrel brokers model calls for. ACP harnesses bring their own login and are not brokered. */
export type BrokerProvider = Exclude<ModelProvider, "omp" | "pi" | "hermes">

/** Where the broker forwards each provider's calls, and the header that carries the real key. */
export const BROKER_UPSTREAMS: Record<BrokerProvider, { readonly base: string; readonly keyHeader: "x-api-key" | "bearer" }> = {
  anthropic: { base: "https://api.anthropic.com", keyHeader: "x-api-key" },
  openai: { base: "https://api.openai.com", keyHeader: "bearer" },
}

export const BROKER_PROVIDERS = Object.keys(BROKER_UPSTREAMS) as ReadonlyArray<BrokerProvider>

/**
 * The env that points a run's CLI at the broker for `provider`.
 *
 * Anthropic and OpenAI keep their own credential env.
 */
export const brokerEnv = (provider: BrokerProvider, base: string, token: string): Record<string, string> => {
  switch (provider) {
    case "anthropic":
    case "openai":
      // Both vendor CLIs are available to either run: a Claude agent may shell out to codex, and vice versa.
      return {
        ANTHROPIC_BASE_URL: `${base}/anthropic`,
        ANTHROPIC_API_KEY: token,
        // Codex appends `/responses` to its base URL, so the broker's OpenAI base carries the `/v1` segment.
        OPENAI_BASE_URL: `${base}/openai/v1`,
        OPENAI_API_KEY: token,
      }
  }
}

/** The real key for `provider`. */
export const credentialFor = (creds: RelayCredentials | null, provider: BrokerProvider): string | null => {
  if (provider === "anthropic") return creds?.anthropic ?? null
  if (provider === "openai") return creds?.openai ?? null
  return null
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
  /** Mints a per-run token, with env pointing the run's CLI at `provider` (none for an ACP harness). */
  readonly issue: (runId: string, user: string, provider: BrokerProvider | null) => Effect.Effect<BrokerLease>
  /** Invalidates the run's token and notifies revoke listeners. Idempotent. */
  readonly revoke: (runId: string) => Effect.Effect<void>
  /** Grant for a live token; null when unknown or revoked. */
  readonly grantForToken: (token: string) => Effect.Effect<BrokerGrant | null>
  /** Calls `listener` with the run id each time a run's token is revoked. Returns the unsubscribe. */
  readonly onRevoke: (listener: (runId: string) => void) => () => void
  /** Real upstream key: the run user's control-plane credential, or null when they have none. */
  readonly upstreamKey: (provider: BrokerProvider, user: string) => Effect.Effect<string | null>
}

export class CredentialBroker extends Context.Tag("cloudagents/CredentialBroker")<
  CredentialBroker,
  CredentialBrokerShape
>() {}

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
      issue: (runId, user, provider) =>
        Effect.sync(() => {
          revokeSync(runId)
          const token = randomBytes(24).toString("base64url")
          grantByToken.set(token, { runId, user })
          tokenByRun.set(runId, token)
          const base = `http://127.0.0.1:${config.port}/broker/${token}`
          return { token, env: provider === null ? {} : brokerEnv(provider, base, token) }
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
          return credentialFor(creds, provider)
        }),
    }
    return broker
  }),
)
