import { Context, Effect, Layer } from "effect"
import { randomBytes, timingSafeEqual } from "node:crypto"
import { DEFAULT_MODEL_HARNESS, type ModelHarness, type ModelProvider, type RelayCredentials } from "@cloudagents/protocol"
import { Config } from "../config"
import { CredentialStore } from "../credentials"
import { StateStore } from "../core/state"

/**
 * Providers Kestrel brokers model calls for. Free OpenCode, Antigravity and Devin are not broker providers: they reach their
 * own models only through the user's own sign-in. OpenCode Go is brokered when another harness runs its models
 * (`<id>@claude`, `<id>@codex`): its key lives in the user's OpenCode credential store, not in Kestrel's.
 */
export type BrokerProvider = Exclude<ModelProvider, "opencode" | "google" | "devin">

/** A native model API a brokered request can speak. */
export type BrokerApi = "anthropic" | "openai"

export type BrokerKeyHeader = "x-api-key" | "bearer"

/** One upstream: the base the API's documented paths hang from, and the header carrying the real key. */
export interface BrokerUpstream {
  readonly base: string
  readonly keyHeader: BrokerKeyHeader
}

/**
 * Every API a provider documents, each with its own base. The OpenAI routes carry the conventional `/v1` segment in
 * the broker path (`/openai/v1/responses`); the base already includes the provider's documented prefix, so the
 * handler drops that literal `/v1` and appends `/responses` or `/chat/completions`.
 *
 * A null API is one the provider does not document. The broker refuses it instead of guessing at a translation.
 */
export interface BrokerUpstreams {
  readonly anthropic: BrokerUpstream | null
  readonly openai: {
    readonly chat: BrokerUpstream
    readonly responses: BrokerUpstream | null
  } | null
}

/**
 * Where the broker forwards each provider's calls.
 *
 * Anthropic, OpenRouter and the other gateways serve Anthropic Messages; the coding gateways that document an OpenAI
 * Responses endpoint (Z.AI, MiniMax, DeepSeek, Moonshot, OpenRouter, OpenCode Go) also serve it natively, so a Codex
 * route never needs a chat-to-responses translation. Anthropic documents only its OpenAI-compatible chat endpoint.
 */
export const BROKER_UPSTREAMS: Record<BrokerProvider, BrokerUpstreams> = {
  anthropic: {
    anthropic: { base: "https://api.anthropic.com", keyHeader: "x-api-key" },
    // Anthropic's OpenAI SDK compatibility layer: the OpenAI SDK sends a Bearer token.
    openai: { chat: { base: "https://api.anthropic.com/v1", keyHeader: "bearer" }, responses: null },
  },
  openai: {
    anthropic: null,
    openai: {
      chat: { base: "https://api.openai.com/v1", keyHeader: "bearer" },
      responses: { base: "https://api.openai.com/v1", keyHeader: "bearer" },
    },
  },
  openrouter: {
    anthropic: { base: "https://openrouter.ai/api", keyHeader: "bearer" },
    openai: {
      chat: { base: "https://openrouter.ai/api/v1", keyHeader: "bearer" },
      // OpenRouter's Codex guide names `https://openrouter.ai/api/v1` as the Responses base.
      responses: { base: "https://openrouter.ai/api/v1", keyHeader: "bearer" },
    },
  },
  zai: {
    anthropic: { base: "https://api.z.ai/api/anthropic", keyHeader: "bearer" },
    openai: {
      // GLM Coding Plan's OpenAI chat endpoint (the standard API is a different, non-interchangeable key).
      chat: { base: "https://api.z.ai/api/coding/paas/v4", keyHeader: "bearer" },
      // The dedicated OpenAI Responses endpoint its Codex guide requires.
      responses: { base: "https://api.z.ai/api/v1", keyHeader: "bearer" },
    },
  },
  deepseek: {
    anthropic: { base: "https://api.deepseek.com/anthropic", keyHeader: "bearer" },
    openai: {
      // DeepSeek documents both of these at `https://api.deepseek.com`, without a `/v1` segment.
      chat: { base: "https://api.deepseek.com", keyHeader: "bearer" },
      responses: { base: "https://api.deepseek.com", keyHeader: "bearer" },
    },
  },
  minimax: {
    anthropic: { base: "https://api.minimax.io/anthropic", keyHeader: "bearer" },
    openai: {
      chat: { base: "https://api.minimax.io/v1", keyHeader: "bearer" },
      responses: { base: "https://api.minimax.io/v1", keyHeader: "bearer" },
    },
  },
  moonshot: {
    anthropic: { base: "https://api.moonshot.ai/anthropic", keyHeader: "bearer" },
    openai: {
      chat: { base: "https://api.moonshot.ai/v1", keyHeader: "bearer" },
      responses: { base: "https://api.moonshot.ai/v1", keyHeader: "bearer" },
    },
  },
  "opencode-go": {
    anthropic: { base: "https://opencode.ai/inference/go/anthropic", keyHeader: "bearer" },
    openai: {
      chat: { base: "https://opencode.ai/inference/go/openai/v1", keyHeader: "bearer" },
      // Go serves every model through Responses, Chat Completions and Anthropic Messages.
      responses: { base: "https://opencode.ai/inference/go/openai/v1", keyHeader: "bearer" },
    },
  },
}

export const BROKER_PROVIDERS = Object.keys(BROKER_UPSTREAMS) as ReadonlyArray<BrokerProvider>

/** The harness a provider's models run in by default; a route id names a different one explicitly. */
export type BrokerHarness = Exclude<ModelHarness, "antigravity" | "devin">

/** The native API a harness speaks at the broker. Codex reads Responses (`wire_api = "responses"`). */
export const brokerApiFor = (harness: BrokerHarness): BrokerApi => (harness === "codex" ? "openai" : "anthropic")

/** Every brokered provider's current harness, from the protocol's single provider→harness table. */
export const DEFAULT_BROKER_HARNESS: Record<BrokerProvider, BrokerHarness> = Object.fromEntries(
  BROKER_PROVIDERS.map((provider) => [provider, DEFAULT_MODEL_HARNESS[provider] as BrokerHarness]),
) as Record<BrokerProvider, BrokerHarness>

/**
 * The API a provider's legacy (unsuffixed) broker path speaks, derived from the same harness table: a provider whose
 * current harness is Codex gets Responses, every other one Anthropic Messages.
 */
export const DEFAULT_BROKER_API: Record<BrokerProvider, BrokerApi> = Object.fromEntries(
  BROKER_PROVIDERS.map((provider) => [provider, brokerApiFor(DEFAULT_BROKER_HARNESS[provider])]),
) as Record<BrokerProvider, BrokerApi>

/**
 * The base a CLI reads for one provider's native API, e.g. `http://box/broker/<token>/openrouter/openai/v1`. It is
 * what Claude Code (`ANTHROPIC_BASE_URL`), Codex (`OPENAI_BASE_URL`) and an OpenCode provider's `baseURL` expect:
 * Anthropic SDKs append `/v1/messages`, OpenAI ones append `/responses` or `/chat/completions`.
 */
export const brokerApiBase = (base: string, provider: BrokerProvider, api: BrokerApi): string =>
  `${base}/${provider}/${api === "openai" ? "openai/v1" : "anthropic"}`

/**
 * The env that points a run's CLI at the broker for `provider`.
 *
 * Anthropic and OpenAI keep their own credential env. Every other provider speaks the Anthropic Messages API to
 * Claude Code, which reads a gateway key from `ANTHROPIC_AUTH_TOKEN`; `ANTHROPIC_API_KEY` must be empty or Claude
 * Code prefers it and sends `x-api-key` to the gateway.
 *
 * `harness` selects the env the run's own CLI reads: a Codex route needs the OpenAI base (Codex appends
 * `/responses`), a Claude route the Anthropic base. An OpenCode route reads its provider from generated
 * configuration instead: it gets no vendor credential env, only the per-run broker token the configuration names.
 */
export const brokerEnv = (
  provider: BrokerProvider | null,
  base: string,
  token: string,
  harness: BrokerHarness | null = provider === null ? null : DEFAULT_BROKER_HARNESS[provider],
): Record<string, string> => {
  if (provider === null) return {}
  // The generated OpenCode provider config names this variable instead of embedding the token in the command line.
  if (harness === "opencode") return { KESTREL_BROKER_TOKEN: token }
  if ((provider === "anthropic" && harness === "claude") || (provider === "openai" && harness === "codex")) {
    // Both vendor CLIs are available to either vendor run: a Claude agent may shell out to codex, and vice versa.
    return {
      ANTHROPIC_BASE_URL: `${base}/anthropic`,
      ANTHROPIC_API_KEY: token,
      // Codex appends `/responses` to its base URL, so the broker's OpenAI base carries the `/v1` segment.
      OPENAI_BASE_URL: `${base}/openai/v1`,
      OPENAI_API_KEY: token,
    }
  }
  if (harness === "codex") {
    // Codex appends `/responses` after this base; the explicit `/openai/v1` route maps it to the provider's
    // documented Responses endpoint.
    return {
      OPENAI_BASE_URL: brokerApiBase(base, provider, "openai"),
      OPENAI_API_KEY: token,
    }
  }
  return {
    // The legacy gateway path stays for Claude Code; OpenCode Go names its Anthropic endpoint explicitly because it
    // has no legacy path.
    ANTHROPIC_BASE_URL: provider === "opencode-go" ? brokerApiBase(base, provider, "anthropic") : `${base}/${provider}`,
    ANTHROPIC_AUTH_TOKEN: token,
    ANTHROPIC_API_KEY: "",
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

/**
 * A grant's default horizon. A finite TTL cannot be the authority while `task_ask` may wait indefinitely, so expiry is
 * checked against the run's liveness: a live run keeps (and renews) its grant, and only an abandoned grant is revoked.
 */
export const BROKER_GRANT_TTL_MS = 24 * 60 * 60_000

/** A live broker token: the run it was minted for and the user who started that run. */
export interface BrokerGrant {
  readonly runId: string
  readonly user: string
  /** Epoch milliseconds; checked against the run's liveness, so a live run never loses its grant to the clock. */
  readonly expiresAt: number
  /** Native vendor runs retain both vendor APIs; every alternate-harness route is scoped to its selected provider. */
  readonly providers: readonly BrokerProvider[]
  /**
   * A stable conversation session for OpenCode's gateway, sent as `x-opencode-session` when the harness sends none of
   * its own. Go routes need one for routing and prompt-cache reuse, so it is derived from the caller's conversation
   * identity and stays the same across the thread's runs.
   */
  readonly opencodeSession: string
  /**
   * The Go plan's exported key, when this run runs OpenCode Go models in another harness. It is not in Kestrel's
   * credential store, so it is held with the grant and never written to the sandbox.
   */
  readonly opencodeGoKey: string | null
}

/** What a run gets for its token: the token itself, its provider base, and the env that points the CLI at it. */
export interface BrokerLease {
  readonly token: string
  /** Epoch milliseconds; the grant is renewed past it while its run is live and revoked once the run is abandoned. */
  readonly expiresAt: number
  /** `http://127.0.0.1:<sandboxPort>/broker/<token>`; routes append `/<provider>/<api>/...`. */
  readonly base: string
  readonly env: Readonly<Record<string, string>>
}

/** How a run uses its lease: the harness it runs, the Go key when it needs one, and its conversation identity. */
export interface BrokerIssueOptions {
  /** The harness chosen by the model's route id; defaults to the provider's current harness. */
  readonly harness?: BrokerHarness
  /** `opencode auth export`'s Go key; required to broker `opencode-go` models. */
  readonly opencodeGoKey?: string | null
  /**
   * A stable conversation identity: the task id. Every call site passes just that, deliberately harness-independent, so
   * OpenCode Go can reuse one prompt cache for a thread even when the user switches between `@claude` and `@codex`.
   * Go's session header is derived from it, so a resumed thread keeps it.
   */
  readonly sessionId?: string
}

export interface CredentialBrokerShape {
  /** Mints a per-run token, scoped to its model provider (null for MCP-only ACP runs). */
  readonly issue: (
    runId: string,
    user: string,
    provider: BrokerProvider | null,
    options?: BrokerIssueOptions,
  ) => Effect.Effect<BrokerLease>
  /** Invalidates the run's token and notifies revoke listeners. Idempotent. */
  readonly revoke: (runId: string) => Effect.Effect<void>
  /** Grant for a live token; null when unknown or revoked. */
  readonly grantForToken: (token: string) => Effect.Effect<BrokerGrant | null>
  /** Calls `listener` with the run id each time a run's token is revoked. Returns the unsubscribe. */
  readonly onRevoke: (listener: (runId: string) => void) => () => void
  /**
   * Real upstream key: the run user's control-plane credential, or null when they have none. OpenCode Go's key is
   * not one of these; the run's grant carries it from the box-local OpenCode credential export instead.
   */
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
    const state = yield* StateStore
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

    /**
     * Go's session must name the conversation, not the run: a resumed thread has a new run and token. The caller's
     * stable identity is used when it is safe as a header value; a standalone issue gets its own random session.
     */
    const sessionFor = (requested: string | undefined): string => {
      // Header-safe, and still the same string for the same conversation on every run.
      const safe = (requested ?? "").replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 110)
      if (safe === "") return `ses_${randomBytes(12).toString("base64url")}`
      return safe.startsWith("ses_") ? safe : `ses_${safe}`
    }

    const broker: CredentialBrokerShape = {
      issue: (runId, user, provider, options) =>
        Effect.sync(() => {
          revokeSync(runId)
          const token = randomBytes(24).toString("base64url")
          const expiresAt = Date.now() + BROKER_GRANT_TTL_MS
          const harness = options?.harness ?? (provider === null ? null : DEFAULT_BROKER_HARNESS[provider])
          const nativeVendor =
            (provider === "anthropic" && harness === "claude") || (provider === "openai" && harness === "codex")
          const providers: readonly BrokerProvider[] =
            provider === null ? [] : nativeVendor ? ["anthropic", "openai"] : [provider]
          grantByToken.set(token, {
            runId,
            user,
            expiresAt,
            providers,
            opencodeSession: sessionFor(options?.sessionId),
            // Only a Go route needs it, and only for the run it was minted for.
            opencodeGoKey: provider === "opencode-go" && options?.opencodeGoKey ? options.opencodeGoKey : null,
          })
          tokenByRun.set(runId, token)
          const base = `http://127.0.0.1:${config.sandboxPort}/broker/${token}`
          return { token, expiresAt, base, env: brokerEnv(provider, base, token, harness) }
        }),
      revoke: (runId) => Effect.sync(() => revokeSync(runId)),
      grantForToken: (token) =>
        Effect.gen(function* () {
          const grant = grantFor(token)
          if (grant === null) return null
          if (grant.expiresAt > Date.now()) return grant
          // The horizon passed. A run can be waiting in `task_ask` for as long as the user takes, so only an abandoned
          // (settled or missing) run loses its token; a live one keeps the same token with a fresh horizon.
          const live = (yield* state.read).runs.some((run) => run.id === grant.runId && run.status === "running")
          if (!live) {
            revokeSync(grant.runId)
            return null
          }
          const renewed: BrokerGrant = { ...grant, expiresAt: Date.now() + BROKER_GRANT_TTL_MS }
          const liveToken = tokenByRun.get(grant.runId)
          if (liveToken !== undefined) grantByToken.set(liveToken, renewed)
          return renewed
        }),
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
