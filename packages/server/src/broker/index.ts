import { Context, Effect, Layer } from "effect"
import { randomBytes, timingSafeEqual } from "node:crypto"
import type { ModelProvider, RelayCredentials } from "@cloudagents/protocol"
import { Config } from "../config"
import { CredentialStore } from "../credentials"

/**
 * Providers Kestrel brokers model calls for. An ACP harness is not a broker provider: OMP, Pi and Hermes use the
 * `harness` channel, which reaches DeepSeek through `HARNESS_UPSTREAMS`; OpenCode runs its own free models with no
 * broker access at all, and Antigravity reaches Google's models through the user's own sign-in.
 */
export type BrokerProvider = Exclude<ModelProvider, "opencode" | "opencode-go" | "omp" | "pi" | "hermes" | "google">

/**
 * What a run's broker token may reach: one provider (a gateway), both vendor APIs (`vendors`: a vendor CLI run), the
 * provider a standalone ACP harness's free models run on (`harness`), or nothing (`null`: no broker access at all).
 */
export type BrokerChannel = BrokerProvider | "vendors" | "harness" | null

/** Where the broker forwards each provider's calls, and the header that carries the real key. */
export const BROKER_UPSTREAMS: Record<BrokerProvider, { readonly base: string; readonly keyHeader: "x-api-key" | "bearer" }> = {
  anthropic: { base: "https://api.anthropic.com", keyHeader: "x-api-key" },
  openai: { base: "https://api.openai.com", keyHeader: "bearer" },
  // Anthropic-compatible: Claude Code's `/v1/messages` is forwarded with `Authorization: Bearer`.
  openrouter: { base: "https://openrouter.ai/api", keyHeader: "bearer" },
  zai: { base: "https://api.z.ai/api/anthropic", keyHeader: "bearer" },
  deepseek: { base: "https://api.deepseek.com/anthropic", keyHeader: "bearer" },
  minimax: { base: "https://api.minimax.io/anthropic", keyHeader: "bearer" },
  moonshot: { base: "https://api.moonshot.ai/anthropic", keyHeader: "bearer" },
  // DeepInfra exposes the Anthropic Messages API beside its OpenAI-compatible one.
  deepinfra: { base: "https://api.deepinfra.com/anthropic", keyHeader: "bearer" },
}

export const BROKER_PROVIDERS = Object.keys(BROKER_UPSTREAMS) as ReadonlyArray<BrokerProvider>

/**
 * An extra route a standalone ACP harness's CLI speaks, beside the Anthropic route `BROKER_UPSTREAMS` gives the vendor
 * CLIs. The harnesses' free models are DeepSeek's own, over its OpenAI-compatible API, so they need an OpenAI-format
 * upstream rather than the Anthropic one Claude Code uses. `provider` names the Settings › Connections key that pays
 * for the calls; it is what the run's grant authorizes.
 */
export interface HarnessUpstream {
  readonly base: string
  readonly keyHeader: "x-api-key" | "bearer"
  readonly provider: BrokerProvider
}

export const HARNESS_UPSTREAMS: Record<"deepseek-openai", HarnessUpstream> = {
  "deepseek-openai": { base: "https://api.deepseek.com/v1", keyHeader: "bearer", provider: "deepseek" },
}

export type HarnessUpstreamId = keyof typeof HARNESS_UPSTREAMS

/** The upstream a broker route forwards to, and the provider whose key it uses; null for an unknown route. */
export const brokerUpstream = (route: string): HarnessUpstream | null => {
  const provider = BROKER_PROVIDERS.find((candidate) => candidate === route)
  if (provider !== undefined) return { ...BROKER_UPSTREAMS[provider], provider }
  const harness = (HARNESS_UPSTREAMS as Record<string, HarnessUpstream>)[route]
  return harness ?? null
}

/**
 * The env that points a run's CLI at the broker for `channel`.
 *
 * Anthropic and OpenAI keep their own credential env. Every other provider speaks the Anthropic Messages API to
 * Claude Code, which reads a gateway key from `ANTHROPIC_AUTH_TOKEN`; `ANTHROPIC_API_KEY` must be empty or Claude
 * Code prefers it and sends `x-api-key` to the gateway. A standalone harness's CLI reads the DeepSeek key and base URL
 * from `DEEPSEEK_API_KEY` / `DEEPSEEK_BASE_URL`; both point at the run's token and the OpenAI-format DeepSeek route,
 * so the CLI never holds a real key.
 */
export const brokerEnv = (channel: BrokerChannel, base: string, token: string): Record<string, string> => {
  switch (channel) {
    case null:
      return {}
    case "anthropic":
    case "openai":
    case "vendors":
      // Both vendor CLIs are available to either run: a Claude agent may shell out to codex, and vice versa.
      return {
        ANTHROPIC_BASE_URL: `${base}/anthropic`,
        ANTHROPIC_API_KEY: token,
        // Codex appends `/responses` to its base URL, so the broker's OpenAI base carries the `/v1` segment.
        OPENAI_BASE_URL: `${base}/openai/v1`,
        OPENAI_API_KEY: token,
      }
    case "harness":
      // A standalone harness CLI's DeepSeek provider: the key is the run's token, and the base URL is the broker's
      // OpenAI-format DeepSeek route, so the token cannot reach any other provider.
      return {
        DEEPSEEK_API_KEY: token,
        DEEPSEEK_BASE_URL: `${base}/deepseek-openai`,
      }
    default:
      return {
        ANTHROPIC_BASE_URL: `${base}/${channel}`,
        ANTHROPIC_AUTH_TOKEN: token,
        ANTHROPIC_API_KEY: "",
      }
  }
}

/** The real key for `provider`, preferring the provider map and falling back to the legacy flat slots. */
export const credentialFor = (creds: RelayCredentials | null, provider: BrokerProvider): string | null => {
  const key = creds?.providers?.[provider]
  if (key !== undefined && key !== "") return key
  if (provider === "anthropic") return creds?.anthropic ?? null
  if (provider === "openai") return creds?.openai ?? null
  return null
}

/** A live broker token: the run it was minted for and the user who started that run. */
export interface BrokerGrant {
  readonly runId: string
  readonly user: string
  /** Vendor runs may use both vendor APIs; harness runs only DeepSeek; gateway runs only their selected provider. */
  readonly providers: readonly BrokerProvider[]
}

/** What a run gets for its token: the token itself, and the env that points the sandboxed agent at the broker. */
export interface BrokerLease {
  readonly token: string
  readonly env: Readonly<Record<string, string>>
}

export interface CredentialBrokerShape {
  /** Mints a per-run token, scoped to `channel` (null for MCP-only ACP runs). */
  readonly issue: (runId: string, user: string, channel: BrokerChannel) => Effect.Effect<BrokerLease>
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
      issue: (runId, user, channel) =>
        Effect.sync(() => {
          revokeSync(runId)
          const token = randomBytes(24).toString("base64url")
          // A vendor run keeps both vendor APIs, so either CLI may shell out to the other; a standalone harness run
          // reaches only the provider its free models run on; a gateway run is scoped to its own provider.
          const providers: readonly BrokerProvider[] =
            channel === null
              ? []
              : channel === "harness"
                ? ["deepseek"]
                : channel === "vendors" || channel === "anthropic" || channel === "openai"
                  ? ["anthropic", "openai"]
                  : [channel]
          grantByToken.set(token, { runId, user, providers })
          tokenByRun.set(runId, token)
          const base = `http://127.0.0.1:${config.sandboxPort}/broker/${token}`
          return { token, env: brokerEnv(channel, base, token) }
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
