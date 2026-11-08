import { createHash } from "node:crypto"
import { readdir, readFile, stat } from "node:fs/promises"
import { join } from "node:path"
import { Effect, Schema } from "effect"
import {
  ModelCatalog,
  ModelDiscoverySource,
  ModelInfo,
  discoveredModel,
  mergeModelCatalog,
  type CliAuthStatus,
  type CliProvider,
  type ModelProvider,
  type RelayCredentials,
} from "@cloudagents/protocol"
import { AGENT_CLIS, CLI_PROVIDERS } from "./agent-clis"
import { credentialFor } from "./broker"
import {
  CLI_ACCOUNTS_DIR,
  CLI_AUTH_STATE_FILE,
  DEFAULT_CLI_ACCOUNT,
  cliAccountHome,
} from "./cliauth"
import type { CredentialStoreShape } from "./credentials"

/*
 * The runtime model catalog of one box: curated models keep their metadata and routes, and each signed-in
 * provider's own model list adds the models the curated catalog does not know. API lists are read with the
 * user's brokered keys, never from the sandbox and never logged; a failing source is a safe status entry, not a
 * failed catalog. Native harnesses (Claude Code, Codex, OpenCode, Antigravity, Devin) enumerate through
 * CliAuth.discoverModels, which owns their isolated process launches.
 */

/** How long a successful catalog is reused for one owner and credential/login generation. */
export const CATALOG_TTL_MS = 60 * 60 * 1000
/** A load whose native login state could not be established is not trusted for an hour. */
const DEGRADED_TTL_MS = 60 * 1000
/** A provider's whole paginated list gets this long; concurrent sources do not multiply the wall clock. */
const SOURCE_TIMEOUT = "6 seconds"
/** One HTTP request inside a provider's pagination. */
const REQUEST_TIMEOUT_MS = 4_000
/** External model lists are JSON metadata; a larger body is refused before it can allocate without bound. */
const MAX_RESPONSE_BYTES = 4 * 1024 * 1024
/** The most model rows one catalog will carry from any source. */
const MAX_MODELS = 2000
/** Native CLI status probes: enough for a warm CLI, short enough for the relay's 30s request budget. */
const LOGIN_TIMEOUT = "4 seconds"
/** Native discovery runs CLIs; it is capped below the helper's own 18s budget for partial results. */
const NATIVE_TIMEOUT = "19 seconds"
const MESSAGE_MAX = 240
const PAGE_MAX = 3
const OPENROUTER_PAGE = 1000
const OPENROUTER_MAX = 3000
const USER_PATTERN = /^[A-Za-z0-9-]{1,39}$/

/** Key-authenticated model-list providers. Z.AI's Coding Plan endpoint exists but is undocumented (best effort). */
export type ApiListProvider = "anthropic" | "openai" | "openrouter" | "deepseek" | "moonshot" | "minimax" | "zai"

/** The native half of discovery, supplied by CliAuth (`harness-model-discovery.ts`). */
export interface NativeModelDiscovery {
  /** Status diagnostics distinguish signed-out accounts from a failed native login probe. */
  readonly status: (user: string) => Effect.Effect<ReadonlyArray<CliAuthStatus>, unknown>
  /**
   * Models and one source per native CLI for `user`. Only an invalid user fails; per-CLI failures are source
   * entries. Callers cache, so this may launch isolated CLI processes.
   */
  readonly discoverModels: (user: string) => Effect.Effect<
    { readonly models: readonly ModelInfo[]; readonly sources: readonly ModelDiscoverySource[] },
    unknown
  >
}

export interface ModelDiscoveryDeps {
  readonly credentials: CredentialStoreShape
  /** The native half (CliAuth): subscription logins, never a silent fallback. */
  readonly native: NativeModelDiscovery
  /** Root of the per-user CLI login directories (`<dataDir>/users/<user>/<cli dir>`). */
  readonly dataDir: string
  /** Injectable for smoke tests; defaults to the platform `fetch`. */
  readonly fetch?: typeof fetch
  readonly now?: () => number
}

export interface ModelDiscoveryOptions {
  /** `?refresh=1`: bypass the owner's catalog cache. Concurrent refreshes still share one load. */
  readonly refresh?: boolean
}

export interface ModelDiscoveryShape {
  readonly get: (user: string, options?: ModelDiscoveryOptions) => Effect.Effect<ModelCatalog>
  /** The cached-or-loaded catalog; the shape MCP's `models.list` dependency expects. */
  readonly list: (user: string) => Effect.Effect<ModelCatalog>
}

interface SourceRun {
  readonly source: { readonly provider: ModelProvider; readonly label: string }
  readonly models: ReadonlyArray<ModelInfo>
  readonly status: "ok" | "error" | "unsupported"
  readonly message?: string
}

/** The safe, provider-specific explanation shown beside a discovered list. */
const API_LIMITATIONS: Readonly<Record<ApiListProvider, string>> = {
  anthropic: "Anthropic's list reports API model ids, not Claude Code compatibility or thinking levels.",
  openai: "OpenAI's list does not report Codex Responses or tool support; only known GPT-5+/o-series families are listed.",
  openrouter: "OpenRouter's Anthropic skin documents Anthropic first-party ids; only tool-capable text models from that set are listed.",
  zai: "Z.AI does not document this Coding Plan list; its models are read best-effort.",
  deepseek: "DeepSeek's list does not report coding-harness compatibility.",
  moonshot: "Moonshot's list does not report coding-harness compatibility.",
  minimax: "MiniMax's list does not report coding-harness compatibility.",
}

const safeMessage = (message: string): string =>
  message.replace(/[\u0000-\u001f\u007f]+/g, " ").trim().slice(0, MESSAGE_MAX)

const nonTextModel = /(embedding|audio|speech|tts|transcri|whisper|dall-e|image|imagen|video|sora|moderation|rerank|realtime|voice|music|hailuo)/i

/** A text ids-only list row (OpenAI, DeepSeek, Moonshot, MiniMax). */
const ListPage = Schema.Struct({
  data: Schema.Array(Schema.Struct({ id: Schema.String })),
})

/** Anthropic's cursor page: `after_id` walks forward while `has_more`. */
const AnthropicPage = Schema.Struct({
  data: Schema.Array(
    Schema.Struct({
      id: Schema.String,
      lifecycle: Schema.optional(Schema.String),
    }),
  ),
  has_more: Schema.optional(Schema.Boolean),
  last_id: Schema.optional(Schema.NullOr(Schema.String)),
})

/** OpenRouter's offset page; tool capability is declared per model. */
const OpenRouterPage = Schema.Struct({
  data: Schema.Array(
    Schema.Struct({
      id: Schema.String,
      supported_parameters: Schema.optional(Schema.Array(Schema.String)),
      architecture: Schema.optional(
        Schema.Struct({
          output_modalities: Schema.optional(Schema.Array(Schema.String)),
        }),
      ),
    }),
  ),
})

const decode = <A, I>(schema: Schema.Schema<A, I, never>, value: unknown): Effect.Effect<A, string> =>
  Schema.decodeUnknown(schema)(value).pipe(Effect.mapError(() => "unexpected model list response"))

class ResponseTooLarge extends Error {}

/** Reads a JSON response under a hard byte cap: Content-Length first, then the stream itself. */
const readJsonBody = async (response: Response): Promise<unknown> => {
  const declared = Number(response.headers.get("content-length") ?? "")
  if (Number.isFinite(declared) && declared > MAX_RESPONSE_BYTES) throw new ResponseTooLarge()
  const reader = response.body?.getReader()
  if (reader === undefined) throw new ResponseTooLarge()
  const chunks: Uint8Array[] = []
  let size = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    size += value.byteLength
    if (size > MAX_RESPONSE_BYTES) {
      await reader.cancel()
      throw new ResponseTooLarge()
    }
    chunks.push(value)
  }
  const body = new Uint8Array(size)
  let offset = 0
  for (const chunk of chunks) {
    body.set(chunk, offset)
    offset += chunk.byteLength
  }
  return JSON.parse(new TextDecoder().decode(body)) as unknown
}

/** A JSON GET with a bounded wait; failures carry no body, URL key, or provider payload. */
const requestJson = (
  fetchImpl: typeof fetch,
  url: string,
  headers: Readonly<Record<string, string>>,
): Effect.Effect<unknown, string> =>
  Effect.gen(function* () {
    const response = yield* Effect.tryPromise({
      try: () => fetchImpl(url, { headers, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) }),
      catch: () => "model list request failed",
    })
    if (!response.ok) return yield* Effect.fail(`model list request failed (HTTP ${response.status})`)
    return yield* Effect.tryPromise({
      try: () => readJsonBody(response),
      catch: (error) => error instanceof ResponseTooLarge
        ? "model list response was too large"
        : "model list response was not valid JSON",
    })
  })

const modelOf = (provider: ModelProvider, upstream: string): readonly ModelInfo[] => {
  const model = discoveredModel(provider, upstream)
  return model === undefined ? [] : [model]
}

const dedupe = (models: ReadonlyArray<ModelInfo>): ReadonlyArray<ModelInfo> => {
  const seen = new Set<string>()
  return models.filter((model) => {
    if (seen.has(model.id)) return false
    seen.add(model.id)
    return true
  })
}

const textId = (id: string): boolean => id !== "" && id.length <= 200 && !nonTextModel.test(id)

/** Newer GPT families and the o-series run through Codex Responses with tools; legacy chat models do not. */
const openAiRunnable = (id: string): boolean => {
  if (!textId(id) || id.startsWith("chatgpt-") || id.includes(":")) return false
  // Chat-only aliases have no Responses/tool surface, and o1's preview/mini models predate it.
  if (/(?:^|-)(?:chat)(?:-|$)/.test(id) || /^o1-(?:preview|mini)(?:-|$)/.test(id)) return false
  const gpt = /^gpt-(\d+)(?:\.(\d+))?/.exec(id)
  if (gpt !== null) return Number(gpt[1]) >= 5
  return /^o\d+(?:-|$)/.test(id) || /^codex-mini(?:-|$)/.test(id)
}

/**
 * Kestrel runs OpenRouter through Claude Code's Anthropic skin, where only Anthropic first-party ids are
 * documented to work. `:batch` variants are batch-priced catalog entries served by the Batch API, not
 * interactive Messages. Discovery stays inside that set and applies the declared tool/text capabilities when the
 * catalog reports them (a model row that omits `supported_parameters` is still included).
 */
const openRouterRunnable = (row: {
  readonly id: string
  readonly supported_parameters?: ReadonlyArray<string>
  readonly architecture?: { readonly output_modalities?: ReadonlyArray<string> }
}): boolean => {
  if (!row.id.startsWith("anthropic/") || !textId(row.id)) return false
  if (row.id.split(":").slice(1).some((variant) => variant.includes("batch"))) return false
  const parameters = row.supported_parameters
  if (parameters !== undefined && !parameters.includes("tools")) return false
  const outputs = row.architecture?.output_modalities
  return outputs === undefined || outputs.includes("text")
}

/** Anthropic `/v1/models`, newest first, `after_id` pagination, active models only. */
export const listAnthropicModels = (
  apiKey: string,
  fetchImpl: typeof fetch = fetch,
): Effect.Effect<ReadonlyArray<ModelInfo>, string> =>
  Effect.gen(function* () {
    const models: ModelInfo[] = []
    let after: string | null = null
    for (let page = 0; page < PAGE_MAX; page++) {
      const url = new URL("https://api.anthropic.com/v1/models")
      url.searchParams.set("limit", "1000")
      if (after !== null) url.searchParams.set("after_id", after)
      const body = yield* requestJson(fetchImpl, url.toString(), {
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
      })
      const parsed = yield* decode(AnthropicPage, body)
      for (const row of parsed.data) {
        if (row.lifecycle !== undefined && row.lifecycle !== "active") continue
        if (textId(row.id)) models.push(...modelOf("anthropic", row.id))
        if (models.length >= MAX_MODELS) break
      }
      if (parsed.has_more !== true || parsed.last_id === null || parsed.last_id === undefined || models.length >= MAX_MODELS) break
      after = parsed.last_id
    }
    return dedupe(models)
  }).pipe(Effect.timeoutFail({ duration: SOURCE_TIMEOUT, onTimeout: () => "model list request timed out" }))

const listOpenAiCompatible = (
  provider: ApiListProvider,
  url: string,
  apiKey: string,
  fetchImpl: typeof fetch,
  accept: (id: string) => boolean = textId,
): Effect.Effect<ReadonlyArray<ModelInfo>, string> =>
  Effect.gen(function* () {
    const body = yield* requestJson(fetchImpl, url, { authorization: `Bearer ${apiKey}` })
    const parsed = yield* decode(ListPage, body)
    return dedupe(parsed.data.slice(0, MAX_MODELS).flatMap((row) => (accept(row.id) ? modelOf(provider, row.id) : [])))
  }).pipe(Effect.timeoutFail({ duration: SOURCE_TIMEOUT, onTimeout: () => "model list request timed out" }))

/** OpenAI `/v1/models`: only families Codex Responses can run with tools, never embedding/image/audio models. */
export const listOpenAiModels = (
  apiKey: string,
  fetchImpl: typeof fetch = fetch,
): Effect.Effect<ReadonlyArray<ModelInfo>, string> =>
  listOpenAiCompatible("openai", "https://api.openai.com/v1/models", apiKey, fetchImpl, openAiRunnable)

/** OpenRouter `/api/v1/models`: tool-capable text models, offset pagination with a hard record cap. */
export const listOpenRouterModels = (
  apiKey: string,
  fetchImpl: typeof fetch = fetch,
): Effect.Effect<ReadonlyArray<ModelInfo>, string> =>
  Effect.gen(function* () {
    const models: ModelInfo[] = []
    for (let offset = 0; offset < OPENROUTER_MAX; offset += OPENROUTER_PAGE) {
      const url = new URL("https://openrouter.ai/api/v1/models")
      url.searchParams.set("limit", String(OPENROUTER_PAGE))
      url.searchParams.set("offset", String(offset))
      url.searchParams.set("output_modalities", "text")
      url.searchParams.set("supported_parameters", "tools")
      const body = yield* requestJson(fetchImpl, url.toString(), { authorization: `Bearer ${apiKey}` })
      const parsed = yield* decode(OpenRouterPage, body)
      for (const row of parsed.data) {
        if (openRouterRunnable(row)) models.push(...modelOf("openrouter", row.id))
        if (models.length >= MAX_MODELS) break
      }
      if (parsed.data.length < OPENROUTER_PAGE || models.length >= MAX_MODELS) break
    }
    return dedupe(models)
  }).pipe(Effect.timeoutFail({ duration: SOURCE_TIMEOUT, onTimeout: () => "model list request timed out" }))

const DeepSeekPage = Schema.Struct({
  data: Schema.Array(
    Schema.Struct({
      id: Schema.String,
      api_capabilities: Schema.optional(Schema.Unknown),
    }),
  ),
})

const field = (value: unknown, key: string): unknown =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)[key]
    : undefined

/**
 * DeepSeek `/models` (no `/v1` segment, as its API docs define). A model whose declared Anthropic Messages
 * capability is false cannot run in the Claude Code route this provider uses, so it is left out.
 */
export const listDeepSeekModels = (
  apiKey: string,
  fetchImpl: typeof fetch = fetch,
): Effect.Effect<ReadonlyArray<ModelInfo>, string> =>
  Effect.gen(function* () {
    const body = yield* requestJson(fetchImpl, "https://api.deepseek.com/models", {
      authorization: `Bearer ${apiKey}`,
    })
    const parsed = yield* decode(DeepSeekPage, body)
    return dedupe(
      parsed.data.slice(0, MAX_MODELS).flatMap((row) => {
        const anthropic = field(row.api_capabilities, "anthropic_messages")
        const runnable = textId(row.id) && anthropic !== false && field(anthropic, "supported") !== false
        return runnable ? modelOf("deepseek", row.id) : []
      }),
    )
  }).pipe(Effect.timeoutFail({ duration: SOURCE_TIMEOUT, onTimeout: () => "model list request timed out" }))

/** Moonshot `/v1/models`; image-input variants are still text models at their output. */
export const listMoonshotModels = (
  apiKey: string,
  fetchImpl: typeof fetch = fetch,
): Effect.Effect<ReadonlyArray<ModelInfo>, string> =>
  listOpenAiCompatible("moonshot", "https://api.moonshot.ai/v1/models", apiKey, fetchImpl)

/** MiniMax's documented OpenAI-compatible `/v1/models`. */
export const listMiniMaxModels = (
  apiKey: string,
  fetchImpl: typeof fetch = fetch,
): Effect.Effect<ReadonlyArray<ModelInfo>, string> =>
  listOpenAiCompatible("minimax", "https://api.minimax.io/v1/models", apiKey, fetchImpl)

/**
 * Z.AI's Coding Plan list exists but is undocumented; it is read best-effort with the same OpenAI-compatible
 * shape, and its status/message say so rather than claiming a documented source.
 */
export const listZaiModels = (
  apiKey: string,
  fetchImpl: typeof fetch = fetch,
): Effect.Effect<ReadonlyArray<ModelInfo>, string> =>
  listOpenAiCompatible("zai", "https://api.z.ai/api/coding/paas/v4/models", apiKey, fetchImpl)

const ApiListSources: ReadonlyArray<{
  readonly provider: ApiListProvider
  readonly label: string
  readonly list: (key: string, fetchImpl: typeof fetch) => Effect.Effect<ReadonlyArray<ModelInfo>, string>
}> = [
  { provider: "anthropic", label: "Anthropic API", list: listAnthropicModels },
  { provider: "openai", label: "OpenAI API", list: listOpenAiModels },
  { provider: "openrouter", label: "OpenRouter API", list: listOpenRouterModels },
  { provider: "zai", label: "Z.AI API (undocumented)", list: listZaiModels },
  { provider: "deepseek", label: "DeepSeek API", list: listDeepSeekModels },
  { provider: "moonshot", label: "Moonshot API", list: listMoonshotModels },
  { provider: "minimax", label: "MiniMax API", list: listMiniMaxModels },
]

/**
 * One provider's list, keyed by the user's credential; exported so a smoke script can exercise a real adapter
 * (e.g. OpenRouter's public endpoint with a placeholder key) without the box's credential store.
 */
export const listProviderModels = (
  provider: ApiListProvider,
  apiKey: string,
  fetchImpl: typeof fetch = fetch,
): Effect.Effect<ReadonlyArray<ModelInfo>, string> => {
  const source = ApiListSources.find((candidate) => candidate.provider === provider)
  return source === undefined ? Effect.fail("unknown model provider") : source.list(apiKey, fetchImpl)
}

const credentialIdentity = (credentials: RelayCredentials | null): string => {
  const providers = Object.entries(credentials?.providers ?? {})
    .filter(([, key]) => key !== "")
    .sort(([left], [right]) => left.localeCompare(right))
  return createHash("sha256")
    .update(JSON.stringify([providers, credentials?.anthropic ?? "", credentials?.openai ?? ""]))
    .digest("hex")
}

/** Directories that hold session/transcript state, not login material: walking them would only add run churn. */
const SESSION_STATE_DIR: Readonly<Record<string, true>> = {
  projects: true, todos: true, sessions: true, session: true, storage: true, history: true,
  "shell-snapshots": true, statsig: true, logs: true, log: true, cache: true, tmp: true,
  node_modules: true, plugins: true, telemetry: true,
}
/** Login material a CLI may rewrite in place without touching its parent directory's mtime. */
const CREDENTIAL_FILE = /(auth|credential|token|oauth|opencode\.db|\.db(?:-wal|-shm)?$|session-generation)/i

const fileSignature = async (path: string): Promise<string> => {
  try {
    const info = await stat(path)
    return `${info.mtimeMs}:${info.ctimeMs}:${info.size}:${info.ino}`
  } catch {
    return "missing"
  }
}

/**
 * Metadata-only names/signatures of credential files under a provider's login directory (two levels), never
 * contents: a Go key import or account switch rewrites a DB/auth file in place without changing the directory.
 */
const credentialSignatures = async (dir: string, depth: number): Promise<ReadonlyArray<string>> => {
  const rows: string[] = []
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => [])
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name)).slice(0, 80)) {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) {
      if (depth > 0 && SESSION_STATE_DIR[entry.name] !== true) {
        rows.push(...await credentialSignatures(path, depth - 1))
      }
      continue
    }
    if (CREDENTIAL_FILE.test(entry.name)) rows.push(`${entry.name}=${await fileSignature(path)}`)
  }
  return rows
}

/** Login directories by provider, with metadata signatures for the files a login rewrites in place. */
const loginDirectoryFingerprint = (
  dataDir: string,
  user: string,
): Effect.Effect<{ readonly present: boolean; readonly fingerprint: string }> =>
  Effect.promise(async () => {
    if (!USER_PATTERN.test(user)) return { present: false, fingerprint: "invalid-user" }
    const root = join(dataDir, "users", user)
    let present = false
    const loginRow = async (label: string, home: string, provider: CliProvider): Promise<string> => {
      const dir = join(home, AGENT_CLIS[provider].dir)
      const dirSignature = await fileSignature(dir)
      if (dirSignature === "missing") return `${label}:${provider}:-`
      present = true
      const files = await credentialSignatures(dir, 1)
      return `${label}:${provider}:${dirSignature}:${files.join("|")}`
    }
    const rows = await Promise.all(
      CLI_PROVIDERS.map((provider) => loginRow(DEFAULT_CLI_ACCOUNT, root, provider)),
    )
    // An extra account is its own isolated home; switching the selected one must invalidate the catalog even when
    // the legacy default login is untouched.
    const accountsDir = join(root, CLI_ACCOUNTS_DIR)
    const accounts = await readdir(accountsDir, { withFileTypes: true }).catch(() => [])
    for (const account of accounts) {
      if (!account.isDirectory()) continue
      const label = `account:${account.name}`
      for (const provider of CLI_PROVIDERS) {
        rows.push(await loginRow(label, cliAccountHome(root, account.name), provider))
      }
    }
    const selected = await readFile(join(root, CLI_AUTH_STATE_FILE), "utf8").catch(() => "")
    return { present, fingerprint: `${rows.join(",")}|active:${selected}` }
  })

const nativeProviderOfCli: Readonly<Record<CliProvider, ModelProvider>> = {
  "claude-cli": "anthropic",
  "codex-cli": "openai",
  "antigravity-cli": "google",
  opencode: "opencode",
  "opencode-go": "opencode-go",
  "devin-cli": "devin",
}

/** A safe source entry for a native CLI whose enumeration failed before it could report itself. */
const nativeFailureSources = (
  providers: ReadonlyArray<CliProvider>,
  checkedAt: string,
): ReadonlyArray<ModelDiscoverySource> =>
  providers.map((cli) => ({
    provider: nativeProviderOfCli[cli],
    source: cli,
    status: "error" as const,
    message: "native model discovery failed or timed out",
    checkedAt,
  }))

/** Keeps only schema-valid models and safe source entries from the native helper. */
const validateNativeResult = (
  result: { readonly models: readonly ModelInfo[]; readonly sources: readonly ModelDiscoverySource[] },
  checkedAt: string,
): { readonly models: ReadonlyArray<ModelInfo>; readonly sources: ReadonlyArray<ModelDiscoverySource> } => ({
  models: dedupe(result.models.filter((model) => Schema.is(ModelInfo)(model))),
  sources: result.sources.flatMap((source) => {
    const message = source.message === undefined ? undefined : safeMessage(source.message)
    const parsed = Number.isNaN(Date.parse(source.checkedAt)) ? checkedAt : source.checkedAt
    const candidate = {
      provider: source.provider,
      source: source.source,
      status: source.status,
      ...(message === undefined || message === "" ? {} : { message }),
      checkedAt: parsed,
    }
    return Schema.is(ModelDiscoverySource)(candidate) ? [candidate] : []
  }),
})

interface CachedCatalog {
  readonly fingerprint: string
  readonly at: number
  readonly ttl: number
  readonly catalog: ModelCatalog
}

/** Owner-scoped, credential-aware model discovery with one coalesced load per user at a time. */
export const makeModelDiscovery = (
  deps: ModelDiscoveryDeps,
): Effect.Effect<ModelDiscoveryShape> =>
  Effect.sync(() => {
    const fetchImpl = deps.fetch ?? fetch
    const now = deps.now ?? Date.now
    const cache = new Map<string, CachedCatalog>()
    const locks = new Map<string, Effect.Semaphore>()

    /** A synchronous per-user semaphore: waiters re-check the cache after the winner stores its result. */
    const lockFor = (user: string): Effect.Semaphore => {
      const existing = locks.get(user)
      if (existing !== undefined) return existing
      const created = Effect.unsafeMakeSemaphore(1)
      locks.set(user, created)
      return created
    }

    const probeLogins = (user: string) =>
      deps.native.status(user).pipe(
        Effect.timeoutFail({ duration: LOGIN_TIMEOUT, onTimeout: () => "timeout" as const }),
        Effect.map((statuses) => {
          const uncertain = new Set<ModelProvider>()
          const unavailable = new Set<CliProvider>()
          for (const status of statuses) {
            // A CLI that cannot hold a login here (missing, or a version that cannot sign in) does not make a
            // subscription possible: a native login's precedence over an API key then cannot apply.
            if (status.cannotSignIn === true) {
              unavailable.add(status.provider)
              continue
            }
            // Only a status probe that failed leaves the answer open.
            if (status.error !== undefined) uncertain.add(nativeProviderOfCli[status.provider])
          }
          for (const cli of ["claude-cli", "codex-cli"] as const) {
            if (!statuses.some((entry) => entry.provider === cli)) uncertain.add(nativeProviderOfCli[cli])
          }
          return {
            logins: statuses.filter((status) => status.loggedIn).map((status) => status.provider),
            uncertain,
            unavailable,
          }
        }),
        // A failed status probe cannot rule out a subscription; never advertise API-only models through it.
        Effect.catchAll(() => Effect.succeed({
          logins: [] as ReadonlyArray<CliProvider>,
          uncertain: new Set<ModelProvider>(["anthropic", "openai"]),
          unavailable: new Set<CliProvider>(),
        })),
      )

    const loadCatalog = (
      user: string,
      credentials: RelayCredentials | null,
      logins: ReadonlyArray<CliProvider>,
      uncertain: ReadonlySet<ModelProvider>,
      unavailable: ReadonlySet<CliProvider>,
    ): Effect.Effect<ModelCatalog> =>
      Effect.gen(function* () {
        const checkedAt = new Date(now()).toISOString()
        const nativeVendors = new Set(logins)
        const suppressed = new Set(uncertain)
        if (nativeVendors.has("claude-cli")) suppressed.add("anthropic")
        if (nativeVendors.has("codex-cli")) suppressed.add("openai")
        const suppression = (provider: ModelProvider): { readonly status: "unsupported" | "error"; readonly message: string } =>
          !uncertain.has(provider)
            ? {
                status: "unsupported",
                message: provider === "anthropic"
                  ? "Claude Code subscription login takes precedence over Anthropic API models."
                  : "Codex subscription login takes precedence over OpenAI API models.",
              }
            : {
                status: "error",
                message: "native CLI login state could not be checked; API models for this provider were not listed.",
              }

        const nativeEffect =
          logins.length === 0 && uncertain.size === 0
            ? Effect.succeed({ models: [] as ReadonlyArray<ModelInfo>, sources: [] as ReadonlyArray<ModelDiscoverySource> })
            : deps.native.discoverModels(user).pipe(
                Effect.timeoutFail({ duration: NATIVE_TIMEOUT, onTimeout: () => "timeout" as const }),
                Effect.map((result) => validateNativeResult(result, checkedAt)),
                Effect.catchAll(() => Effect.succeed({
                  models: [] as ReadonlyArray<ModelInfo>,
                  sources: nativeFailureSources(
                    logins.length === 0 ? [...CLI_PROVIDERS] : logins,
                    checkedAt,
                  ),
                })),
              )

        const apiEffects = ApiListSources.map((source): Effect.Effect<SourceRun> => {
          if (suppressed.has(source.provider)) {
            return Effect.succeed({ source, models: [], ...suppression(source.provider) })
          }
          const key = credentialFor(credentials, source.provider)
          if (key === null || key === "") {
            return Effect.succeed({
              source,
              models: [],
              status: "unsupported",
              message: `${source.label} is not connected on this box.`,
            })
          }
          return source.list(key, fetchImpl).pipe(
            Effect.map((models): SourceRun => ({
              source,
              models,
              status: "ok",
              message: API_LIMITATIONS[source.provider],
            })),
            Effect.catchAll((message) => Effect.succeed<SourceRun>({
              source,
              models: [],
              status: "error",
              message: safeMessage(message),
            })),
          )
        })

        const [native, api] = yield* Effect.all(
          [nativeEffect, Effect.all(apiEffects, { concurrency: "unbounded" })],
          { concurrency: "unbounded" },
        )

        const sources: ModelDiscoverySource[] = [...native.sources]
        const models: ModelInfo[] = [...native.models]
        for (const entry of api) {
          sources.push({
            provider: entry.source.provider,
            source: entry.source.label,
            status: entry.status,
            ...(entry.message === undefined ? {} : { message: entry.message }),
            checkedAt,
          })
          models.push(...entry.models)
        }
        // A native CLI that reported nothing still has a status: the catalog never leaves a provider's state
        // implicit.
        const covered = new Set(sources.map((source) => `${source.provider}:${source.source}`))
        for (const cli of CLI_PROVIDERS) {
          const provider = nativeProviderOfCli[cli]
          if (covered.has(`${provider}:${cli}`)) continue
          sources.push({
            provider,
            source: cli,
            status: uncertain.has(provider) ? "error" : "unsupported",
            message: uncertain.has(provider)
              ? "native login state could not be checked"
              : unavailable.has(cli) ? "the CLI is not installed or cannot sign in" : "not signed in",
            checkedAt,
          })
        }
        return { models: mergeModelCatalog(dedupe(models)), sources }
      })

    const get = (user: string, options?: ModelDiscoveryOptions): Effect.Effect<ModelCatalog> =>
      Effect.gen(function* () {
        const refresh = options?.refresh === true
        const startedAt = now()
        const credentials = yield* deps.credentials.get(user)
        const directory = yield* loginDirectoryFingerprint(deps.dataDir, user)
        const fingerprint = createHash("sha256")
          .update(`${credentialIdentity(credentials)}|${directory.present ? directory.fingerprint : "-"}`)
          .digest("hex")

        const cached = cache.get(user)
        if (!refresh && cached !== undefined && cached.fingerprint === fingerprint && now() - cached.at < cached.ttl) {
          return cached.catalog
        }

        const semaphore = lockFor(user)
        return yield* semaphore.withPermits(1)(
          Effect.gen(function* () {
            // A request that waited behind another load takes that load's result when it is no older than the
            // request itself; this is what makes simultaneous refresh clicks one CLI run.
            const shared = cache.get(user)
            if (shared !== undefined && shared.fingerprint === fingerprint && shared.at >= startedAt) {
              return shared.catalog
            }
            if (!refresh && shared !== undefined && shared.fingerprint === fingerprint && now() - shared.at < shared.ttl) {
              return shared.catalog
            }

            const login = directory.present ? yield* probeLogins(user) : {
              logins: [] as ReadonlyArray<CliProvider>,
              uncertain: new Set<ModelProvider>(),
              // No login directory has ever existed, so no CLI status was probed; nothing is known to be missing.
              unavailable: new Set<CliProvider>(),
            }
            const catalog = yield* loadCatalog(user, credentials, login.logins, login.uncertain, login.unavailable)
            cache.set(user, {
              fingerprint,
              at: now(),
              ttl: login.uncertain.size === 0 ? CATALOG_TTL_MS : DEGRADED_TTL_MS,
              catalog,
            })
            return catalog
          }),
        )
      })

    return {
      get,
      list: (user) => get(user),
    }
  })
