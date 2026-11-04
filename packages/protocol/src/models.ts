import { Schema } from "effect"

/**
 * Model families the box runs. Anthropic models run through Claude Code, OpenAI models through codex, OpenCode and
 * Antigravity CLI run their own providers' models over the Agent Client Protocol, and every other provider exposes an
 * Anthropic Messages endpoint and runs through Claude Code too (see `harness` below).
 */
export const ModelProvider = Schema.Literal(
  "anthropic",
  "openai",
  "openrouter",
  "zai",
  "deepseek",
  "opencode",
  "google",
  "omp",
  "pi",
  "hermes",
)
export type ModelProvider = typeof ModelProvider.Type

/** The CLI that runs a provider's models. `acp` is a CLI that speaks the Agent Client Protocol over stdio. */
export const AgentHarness = Schema.Literal("claude", "codex", "acp")
export type AgentHarness = typeof AgentHarness.Type

/**
 * The harness a thread selects: a vendor CLI (`claude`, `codex`), an ACP harness with its own sign-in (`google`), or a
 * standalone ACP harness (`opencode`, `omp`, `pi`, `hermes`). A provider maps to exactly one of these
 * (`harnessIdOfProvider`), which is how a model id is scoped to a harness.
 */
export const HarnessId = Schema.Literal("claude", "codex", "opencode", "google", "omp", "pi", "hermes")
export type HarnessId = typeof HarnessId.Type

export const HARNESS_IDS: readonly HarnessId[] = ["claude", "codex", "opencode", "google", "omp", "pi", "hermes"]

/**
 * Standalone ACP harnesses: their own CLI runs the model, so the box has to have that CLI before the harness can be
 * offered. The box reports which of these it can launch (`HarnessStatus`), and only those reach the picker.
 */
export const AcpHarnessId = Schema.Literal("opencode", "omp", "pi", "hermes")
export type AcpHarnessId = typeof AcpHarnessId.Type

export const HARNESS_LABELS: Record<HarnessId, string> = {
  claude: "Claude Code",
  codex: "Codex",
  opencode: "OpenCode",
  google: "Antigravity",
  omp: "OMP",
  pi: "Pi",
  hermes: "Hermes",
}

/**
 * Thinking level: Claude Code's `--effort`, codex's `model_reasoning_effort`. Each model supports its own subset
 * (`ModelInfo.efforts`); `SendMessageBody` rejects a level the chosen model does not support.
 */
export const AgentEffort = Schema.Literal("none", "low", "medium", "high", "xhigh", "max")
export type AgentEffort = typeof AgentEffort.Type

export const EFFORT_LABELS: Record<AgentEffort, string> = {
  none: "None",
  low: "Low",
  medium: "Medium",
  high: "High",
  xhigh: "Extra high",
  max: "Max",
}

/**
 * Model id passed to the provider's CLI (`claude --model`, the Codex app-server thread's `model`, the ACP `model`
 * config option of OpenCode, which names OpenCode's own provider first, and of Antigravity CLI).
 */
export const AgentModel = Schema.Literal(
  "claude-fable-5-1",
  "claude-opus-5-5",
  "claude-sonnet-5-5",
  "claude-haiku-5-5",
  "claude-fable-5",
  "claude-opus-5",
  "claude-sonnet-5",
  "claude-opus-4-8",
  "claude-opus-4-7",
  "claude-opus-4-6",
  "claude-sonnet-4-6",
  "claude-opus-4-5",
  "claude-haiku-4-5",
  "gpt-6-astra",
  "gpt-6.1-sol",
  "gpt-6.1-terra",
  "gpt-6-luna",
  "gpt-6-sol",
  "anthropic/claude-fable-5.1",
  "anthropic/claude-opus-5.5",
  "anthropic/claude-sonnet-5.5",
  "anthropic/claude-haiku-5.5",
  "glm-5.3[1m]",
  "glm-5.3-flash[1m]",
  "deepseek-flash[1m]",
  "deepseek-v4-pro",
  "opencode/big-pickle",
  "opencode/glm-5.3-flash-free",
  "opencode/deepseek-v4.1-flash-free",
  "opencode/mimo-v2.6-flash-free",
  "opencode/beam-free",
  "opencode/crouton-alpha-free",
  "opencode/flint-40b-free",
  "opencode/nemotron-3.5-lightning-free",
  "opencode/nemotron-3.5-super-vl-free",
  "opencode/pulse-alpha-free",
  "gemini-3.8-flash",
  "omp-deepseek-flash",
  "omp-deepseek-pro",
  "pi-deepseek-flash",
  "pi-deepseek-pro",
  "hermes-deepseek-flash",
  "hermes-deepseek-pro",
)
export type AgentModel = typeof AgentModel.Type

export interface ModelInfo {
  readonly id: AgentModel
  readonly provider: ModelProvider
  /** Display name; the id is never shown. */
  readonly name: string
  /** Thinking levels the model accepts, lowest first. Empty: the model takes no thinking level. */
  readonly efforts: readonly AgentEffort[]
  /** In the chat model picker until the user edits the provider's list on the connections page. */
  readonly shownByDefault: boolean
  /** The model id the ACP harness's `session/set_config_option` expects, for ACP models. */
  readonly acpModel?: string
  /** Context window Claude Code should auto-compact at for this gateway model, when its guide recommends less than the id implies. */
  readonly compactWindow?: number
}

const CLAUDE_ALL: readonly AgentEffort[] = ["low", "medium", "high", "xhigh", "max"]
const CLAUDE_NO_XHIGH: readonly AgentEffort[] = ["low", "medium", "high", "max"]
const GPT_FROM_LOW: readonly AgentEffort[] = ["low", "medium", "high", "xhigh", "max"]
const GPT_FROM_NONE: readonly AgentEffort[] = ["none", "low", "medium", "high", "xhigh", "max"]
const OC_LOW_HIGH_MAX: readonly AgentEffort[] = ["low", "high", "max"]
const OC_LOW_TO_MAX: readonly AgentEffort[] = ["low", "medium", "high", "xhigh", "max"]

/**
 * Every model the box can run, in picker order (newest first within a provider). Effort support follows Claude
 * Code's model configuration docs, OpenAI's model pages, and each third-party provider's Claude Code guide.
 * Providers without a documented effort scale list none, so the picker offers no unsupported control. OpenCode's
 * efforts are what its ACP `effort` option offers per model; its free models need no sign-in, and OpenCode rotates
 * them, so the list follows its own.
 */
export const AGENT_MODELS: readonly ModelInfo[] = [
  { id: "claude-fable-5-1", provider: "anthropic", name: "Claude Fable 5.1", efforts: CLAUDE_ALL, shownByDefault: true },
  { id: "claude-opus-5-5", provider: "anthropic", name: "Claude Opus 5.5", efforts: CLAUDE_ALL, shownByDefault: true },
  { id: "claude-sonnet-5-5", provider: "anthropic", name: "Claude Sonnet 5.5", efforts: CLAUDE_ALL, shownByDefault: true },
  { id: "claude-haiku-5-5", provider: "anthropic", name: "Claude Haiku 5.5", efforts: CLAUDE_ALL, shownByDefault: true },
  { id: "claude-fable-5", provider: "anthropic", name: "Claude Fable 5", efforts: CLAUDE_ALL, shownByDefault: false },
  { id: "claude-opus-5", provider: "anthropic", name: "Claude Opus 5", efforts: CLAUDE_ALL, shownByDefault: false },
  { id: "claude-sonnet-5", provider: "anthropic", name: "Claude Sonnet 5", efforts: CLAUDE_ALL, shownByDefault: false },
  { id: "claude-opus-4-8", provider: "anthropic", name: "Claude Opus 4.8", efforts: CLAUDE_ALL, shownByDefault: false },
  { id: "claude-opus-4-7", provider: "anthropic", name: "Claude Opus 4.7", efforts: CLAUDE_ALL, shownByDefault: false },
  { id: "claude-opus-4-6", provider: "anthropic", name: "Claude Opus 4.6", efforts: CLAUDE_NO_XHIGH, shownByDefault: false },
  { id: "claude-sonnet-4-6", provider: "anthropic", name: "Claude Sonnet 4.6", efforts: CLAUDE_NO_XHIGH, shownByDefault: false },
  { id: "claude-opus-4-5", provider: "anthropic", name: "Claude Opus 4.5", efforts: [], shownByDefault: false },
  { id: "claude-haiku-4-5", provider: "anthropic", name: "Claude Haiku 4.5", efforts: [], shownByDefault: false },
  { id: "gpt-6-astra", provider: "openai", name: "GPT-6 Astra", efforts: GPT_FROM_LOW, shownByDefault: true },
  { id: "gpt-6.1-sol", provider: "openai", name: "GPT-6.1 Sol", efforts: GPT_FROM_LOW, shownByDefault: true },
  { id: "gpt-6.1-terra", provider: "openai", name: "GPT-6.1 Terra", efforts: GPT_FROM_NONE, shownByDefault: true },
  { id: "gpt-6-luna", provider: "openai", name: "GPT-6 Luna", efforts: GPT_FROM_NONE, shownByDefault: true },
  { id: "gpt-6-sol", provider: "openai", name: "GPT-6 Sol", efforts: GPT_FROM_NONE, shownByDefault: false },
  // OpenRouter's Anthropic skin only guarantees Claude Code compatibility for Anthropic first-party models.
  { id: "anthropic/claude-opus-5.5", provider: "openrouter", name: "Claude Opus 5.5", efforts: CLAUDE_ALL, shownByDefault: true },
  { id: "anthropic/claude-sonnet-5.5", provider: "openrouter", name: "Claude Sonnet 5.5", efforts: CLAUDE_ALL, shownByDefault: true },
  { id: "anthropic/claude-fable-5.1", provider: "openrouter", name: "Claude Fable 5.1", efforts: CLAUDE_ALL, shownByDefault: false },
  { id: "anthropic/claude-haiku-5.5", provider: "openrouter", name: "Claude Haiku 5.5", efforts: CLAUDE_ALL, shownByDefault: false },
  { id: "glm-5.3[1m]", provider: "zai", name: "GLM-5.3", efforts: [], shownByDefault: true, compactWindow: 1_000_000 },
  { id: "glm-5.3-flash[1m]", provider: "zai", name: "GLM-5.3 Flash", efforts: [], shownByDefault: false, compactWindow: 1_000_000 },
  { id: "deepseek-flash[1m]", provider: "deepseek", name: "DeepSeek Flash", efforts: CLAUDE_NO_XHIGH, shownByDefault: true, compactWindow: 786_432 },
  { id: "deepseek-v4-pro", provider: "deepseek", name: "DeepSeek V4 Pro", efforts: CLAUDE_NO_XHIGH, shownByDefault: false },
  // OpenCode's catalog id is the value its ACP `model` config option takes.
  { id: "opencode/big-pickle", provider: "opencode", name: "Big Pickle", efforts: [], shownByDefault: true },
  { id: "opencode/glm-5.3-flash-free", provider: "opencode", name: "GLM-5.3-Flash Free", efforts: OC_LOW_HIGH_MAX, shownByDefault: true },
  { id: "opencode/deepseek-v4.1-flash-free", provider: "opencode", name: "DeepSeek V4.1 Flash Free", efforts: OC_LOW_HIGH_MAX, shownByDefault: true },
  { id: "opencode/mimo-v2.6-flash-free", provider: "opencode", name: "MiMo-V2.6-Flash Free", efforts: [], shownByDefault: true },
  { id: "opencode/beam-free", provider: "opencode", name: "Beam Free", efforts: OC_LOW_TO_MAX, shownByDefault: false },
  { id: "opencode/crouton-alpha-free", provider: "opencode", name: "Crouton Alpha Free", efforts: OC_LOW_TO_MAX, shownByDefault: false },
  { id: "opencode/flint-40b-free", provider: "opencode", name: "Flint 40B Free", efforts: OC_LOW_TO_MAX, shownByDefault: false },
  { id: "opencode/nemotron-3.5-lightning-free", provider: "opencode", name: "Nemotron 3.5 Lightning Free", efforts: [], shownByDefault: false },
  { id: "opencode/nemotron-3.5-super-vl-free", provider: "opencode", name: "Nemotron 3.5 Super VL Free", efforts: ["none", "low", "medium", "high", "xhigh"], shownByDefault: false },
  { id: "opencode/pulse-alpha-free", provider: "opencode", name: "Pulse Alpha Free", efforts: OC_LOW_HIGH_MAX, shownByDefault: false },
  // What a signed-in Google account's Antigravity CLI offers, with its `thought_level` option.
  { id: "gemini-3.8-flash", provider: "google", name: "Gemini 3.8 Flash", efforts: ["low", "medium", "high"], shownByDefault: true },
  // ACP harnesses can switch models per chat; `acpModel` is the value their ACP config option takes.
  { id: "omp-deepseek-flash", provider: "omp", name: "DeepSeek Flash", efforts: [], shownByDefault: true, acpModel: "deepseek/deepseek-flash" },
  { id: "omp-deepseek-pro", provider: "omp", name: "DeepSeek V4 Pro", efforts: [], shownByDefault: true, acpModel: "deepseek/deepseek-v4-pro" },
  { id: "pi-deepseek-flash", provider: "pi", name: "DeepSeek Flash", efforts: [], shownByDefault: true, acpModel: "deepseek/deepseek-flash" },
  { id: "pi-deepseek-pro", provider: "pi", name: "DeepSeek V4 Pro", efforts: [], shownByDefault: true, acpModel: "deepseek/deepseek-v4-pro" },
  { id: "hermes-deepseek-flash", provider: "hermes", name: "DeepSeek Flash", efforts: [], shownByDefault: true, acpModel: "deepseek:deepseek-flash" },
  { id: "hermes-deepseek-pro", provider: "hermes", name: "DeepSeek V4 Pro", efforts: [], shownByDefault: true, acpModel: "deepseek:deepseek-v4-pro" },
]

export interface ModelProviderInfo {
  readonly id: ModelProvider
  readonly name: string
  /** The CLI every model of this provider runs through. */
  readonly harness: AgentHarness
  /**
   * `Connection.provider` ids that give the box access to this provider's models: an API key or a CLI login. Empty
   * for a standalone harness, which needs none (the box reports whether it has the harness's CLI instead).
   */
  readonly connections: readonly string[]
  /** A harness whose CLI carries its own login/config on the box; no Connections key is required to select it. */
  readonly standalone?: boolean
  /** The command a user runs on the box to sign the standalone harness's CLI in. */
  readonly setup?: string
  /** How the box authenticates a run on this provider; the Connections section shows it. */
  readonly auth: "api-key" | "cli-login" | "harness-login"
  /** Whether Kestrel's MCP tools reach the harness. Pi's ACP adapter advertises no MCP support. */
  readonly mcp: boolean
  /** Provider-specific setup note shown in Connections, e.g. which key a provider accepts. */
  readonly hint?: string
}

export const MODEL_PROVIDERS: readonly ModelProviderInfo[] = [
  { id: "anthropic", name: "Anthropic", harness: "claude", connections: ["anthropic", "claude-cli"], auth: "cli-login", mcp: true },
  { id: "openai", name: "OpenAI", harness: "codex", connections: ["openai", "codex-cli"], auth: "cli-login", mcp: true },
  { id: "openrouter", name: "OpenRouter", harness: "claude", connections: ["openrouter"], auth: "api-key", mcp: true },
  { id: "zai", name: "Z.ai", harness: "claude", connections: ["zai"], auth: "api-key", mcp: true },
  { id: "deepseek", name: "DeepSeek", harness: "claude", connections: ["deepseek"], auth: "api-key", mcp: true },
  // OpenCode's free models need no connection: its own CLI runs them, so the box has to have it (OpenCode 2).
  { id: "opencode", name: "OpenCode", harness: "acp", connections: [], standalone: true, setup: "npm i -g @opencode/cli", auth: "harness-login", mcp: true },
  // Google's models reach Antigravity CLI only through the user's Google sign-in, a CLI login like Claude's or ChatGPT's.
  { id: "google", name: "Google", harness: "acp", connections: ["antigravity-cli"], auth: "cli-login", mcp: true, hint: "Sign in with your Google account above; Antigravity CLI has no key." },
  { id: "omp", name: "OMP", harness: "acp", connections: [], standalone: true, setup: "omp login, run in its harness home", auth: "harness-login", mcp: true },
  { id: "pi", name: "Pi", harness: "acp", connections: [], standalone: true, setup: "pi, then /login, run in its harness home", auth: "harness-login", mcp: false },
  { id: "hermes", name: "Hermes", harness: "acp", connections: [], standalone: true, setup: "hermes setup, run in its harness home", auth: "harness-login", mcp: true },
]

/** The provider a message without a model runs on: the box's default harness. */
export const DEFAULT_MODEL_PROVIDER: ModelProvider = "anthropic"

export const modelInfo = (id: AgentModel): ModelInfo => {
  const info = AGENT_MODELS.find((m) => m.id === id)
  if (info === undefined) throw new Error(`model ${id} is missing from AGENT_MODELS`)
  return info
}

export const providerInfo = (id: ModelProvider): ModelProviderInfo => {
  const info = MODEL_PROVIDERS.find((p) => p.id === id)
  if (info === undefined) throw new Error(`provider ${id} is missing from MODEL_PROVIDERS`)
  return info
}

/** The CLI that runs a provider's models. */
export const providerHarness = (id: ModelProvider): AgentHarness => providerInfo(id).harness

/** The thread-facing harness id of a provider: the provider itself for ACP, otherwise its CLI. */
export const harnessIdOfProvider = (id: ModelProvider): HarnessId => {
  const info = providerInfo(id)
  // An ACP harness is the provider itself: OpenCode and Antigravity run their own models, OMP/Pi/Hermes their own CLI.
  return info.harness === "acp" ? (id as HarnessId) : info.harness === "codex" ? "codex" : "claude"
}

/** The harness a model runs on; a model id is scoped to this harness before a connection is chosen. */
export const harnessIdOfModel = (model: AgentModel): HarnessId => harnessIdOfProvider(modelInfo(model).provider)

/** The providers that expose models on `harness`, in catalog order. */
export const providersForHarness = (harness: HarnessId): readonly ModelProviderInfo[] =>
  MODEL_PROVIDERS.filter((p) => harnessIdOfProvider(p.id) === harness)

/**
 * The provider a choice runs on: the explicitly selected connection wins over the model's own provider, so a
 * duplicate model id can be scoped to the harness the thread selected. The caller still validates the pair.
 */
export const agentChoiceProvider = (choice: {
  readonly model?: AgentModel | undefined
  readonly provider?: ModelProvider | undefined
}): ModelProvider =>
  choice.provider ?? (choice.model === undefined ? DEFAULT_MODEL_PROVIDER : modelInfo(choice.model).provider)

/** Why a model/connection pair cannot run, or null when it can. Does not depend on network state. */
export const agentChoiceProblem = (choice: {
  readonly model?: AgentModel | undefined
  readonly provider?: ModelProvider | undefined
}): string | null => {
  if (choice.model === undefined || choice.provider === undefined) return null
  const owner = modelInfo(choice.model).provider
  return owner === choice.provider
    ? null
    : `${modelInfo(choice.model).name} belongs to ${providerInfo(owner).name}, not ${providerInfo(choice.provider).name}`
}

export const providerModels = (provider: ModelProvider): readonly ModelInfo[] =>
  AGENT_MODELS.filter((m) => m.provider === provider)

/** The model a run of `provider` uses when the message names none: its first default-shown model, else its first. */
export const defaultModelOf = (provider: ModelProvider): ModelInfo | undefined =>
  providerModels(provider).find((m) => m.shownByDefault) ?? providerModels(provider)[0]

/**
 * Providers with at least one connected connection, in `MODEL_PROVIDERS` order. `enabledHarnesses` is the set the
 * user enabled in Connections (all when omitted); it can only narrow the result, never invent availability.
 *
 * A standalone ACP harness is a connection of its own (`Connection.provider` is the harness id): the box reports it
 * only when that harness's CLI is present there, so a harness the box does not have is never offered by default.
 */
export const connectedModelProviders = (
  connections: ReadonlyArray<{
    readonly provider: string
    readonly connected: boolean
    readonly enabled?: boolean
    readonly available?: boolean
  }>,
  enabledHarnesses: readonly HarnessId[] = HARNESS_IDS,
): readonly ModelProviderInfo[] =>
  MODEL_PROVIDERS.filter(
    (p) =>
      enabledHarnesses.includes(harnessIdOfProvider(p.id)) &&
      (p.standalone === true
        ? connections.some((c) => c.provider === p.id && c.connected && c.enabled !== false && c.available !== false)
        : connections.some((c) => c.connected && c.enabled !== false && p.connections.includes(c.provider))),
  )

/**
 * The provider's models in the chat picker, in catalog order. `chosen` is the user's saved list for the provider
 * (from the connections page), or null before they edited it.
 */
export const shownModels = (provider: ModelProvider, chosen: ReadonlyArray<AgentModel> | null): readonly ModelInfo[] =>
  providerModels(provider).filter((m) => (chosen === null ? m.shownByDefault : chosen.includes(m.id)))

/** A stored thinking-level pick. "default" is an explicit pick of the model's default level, unlike having no pick. */
export const EffortPick = Schema.Union(AgentEffort, Schema.Literal("default"))
export type EffortPick = typeof EffortPick.Type

/**
 * The run whose choice a thread's pickers restore, from its runs oldest first: the latest that recorded a model,
 * skipping runs another thread or GitHub woke, which use the provider's default rather than the thread's choice. The
 * first run counts whoever started it, since a delegated thread's assignment names its model. Only a run's first user
 * message says who started it; a later one with `fromThread` is mail reaching a run already going.
 */
export const threadChoiceRun = <R extends { readonly id: string; readonly model?: AgentModel | undefined }>(
  runs: readonly R[],
  messages: ReadonlyArray<{
    readonly role: string
    readonly runId: string | null
    readonly createdAt: string
    readonly fromThread?: unknown
  }>,
): R | undefined => {
  const prompts = new Map<string, (typeof messages)[number]>()
  for (const message of [...messages].sort((a, b) => b.createdAt.localeCompare(a.createdAt))) {
    if (message.role === "user" && message.runId !== null) prompts.set(message.runId, message)
  }
  return runs
    .filter((run, index) => {
      const prompt = prompts.get(run.id)
      return run.model !== undefined && (index === 0 || (prompt !== undefined && prompt.fromThread === undefined))
    })
    .at(-1)
}

/**
 * What a composer's pickers show and its next message sends. An unsent pick wins while it is on offer; a thread then
 * stays on what its last run used, even a model since hidden from the picker, as long as its provider is connected.
 * The device's default covers the rest (the new-thread picks, or a thread whose runs recorded no model), and the
 * first model on offer stands in last. Everything is undefined until `offered` has loaded.
 */
export const resolveAgentChoice = (input: {
  readonly offered: readonly ModelInfo[]
  readonly connected: readonly ModelProviderInfo[]
  readonly pickedModel: AgentModel | undefined
  readonly pickedEffort: EffortPick | undefined
  readonly lastRun: { readonly model?: AgentModel | undefined; readonly effort?: AgentEffort | null | undefined } | undefined
  readonly defaultModel: AgentModel | undefined
  readonly defaultEffort: EffortPick | undefined
}): { readonly model: ModelInfo | undefined; readonly effort: AgentEffort | undefined } => {
  const { offered, connected, pickedModel, pickedEffort, lastRun, defaultModel, defaultEffort } = input
  const onOffer = (id: AgentModel | undefined) => offered.find((m) => m.id === id)
  const lastModel = lastRun?.model === undefined ? undefined : modelInfo(lastRun.model)
  const model =
    onOffer(pickedModel) ??
    (connected.some((p) => p.id === lastModel?.provider) ? lastModel : undefined) ??
    onOffer(defaultModel) ??
    offered[0]
  const level = pickedEffort ?? (lastRun?.effort === null ? "default" : lastRun?.effort ?? defaultEffort)
  const effort = level !== undefined && level !== "default" && model?.efforts.includes(level) ? level : model?.efforts[0]
  return { model, effort }
}

/** A Connections row as the route resolver needs it; `enabled` defaults to true. */
export interface ConnectionState {
  readonly provider: string
  readonly connected: boolean
  readonly enabled?: boolean
  /** False when the provider is configured but cannot serve (missing server secret, CLI not installed, ...). */
  readonly available?: boolean
  readonly error?: string
}

export type ModelRouteFailureCode =
  | "missing-model"
  | "unknown-harness"
  | "harness-mismatch"
  | "ambiguous-model"
  | "missing-connection"
  | "disabled-connection"
  | "connection-unavailable"

/** Where a thread's model selection runs: its harness, connection, catalog entry and ACP model value. */
export interface ModelRoute {
  readonly harness: HarnessId
  readonly provider: ModelProvider
  readonly model: ModelInfo
  readonly connectionId: string
  readonly acpModel?: string
}

export type ModelRouteResult =
  | { readonly ok: true; readonly route: ModelRoute }
  | { readonly ok: false; readonly code: ModelRouteFailureCode; readonly message: string }

const routeFailure = (code: ModelRouteFailureCode, message: string): ModelRouteResult => ({ ok: false, code, message })

const connectionFailure = (
  model: ModelInfo,
  connections: readonly ConnectionState[],
): { readonly ok: true; readonly route: ModelRoute } | { readonly ok: false; readonly code: ModelRouteFailureCode; readonly message: string } => {
  const info = providerInfo(model.provider)
  const harness = harnessIdOfProvider(model.provider)
  if (info.standalone === true) {
    // The harness is its own connection: its row says whether the box has that CLI at all.
    const row = connections.find((c) => c.provider === model.provider)
    if (row?.enabled === false) {
      return {
        ok: false,
        code: "disabled-connection",
        message: `${info.name} is disabled. Enable it in Settings › Connections.`,
      }
    }
    if (row === undefined) {
      return {
        ok: false,
        code: "connection-unavailable",
        message: `Kestrel's box has not reported ${info.name} as available. Install its CLI on the box${info.setup === undefined ? "" : ` and set it up (${info.setup})`}, or connect another provider in Settings › Connections.`,
      }
    }
    if (row.available === false) {
      return {
        ok: false,
        code: "connection-unavailable",
        message: `${info.name} is unavailable${row.error === undefined ? "" : `: ${row.error}`}. Install its CLI on the box${info.setup === undefined ? "" : ` and set it up (${info.setup})`}.`,
      }
    }
    if (!row.connected) {
      return {
        ok: false,
        code: "connection-unavailable",
        message: `${info.name} is not set up on the box${info.setup === undefined ? "" : `; run ${info.setup}`}.`,
      }
    }
    return { ok: true, route: { harness, provider: model.provider, model, connectionId: model.provider, ...(model.acpModel === undefined ? {} : { acpModel: model.acpModel }) } }
  }
  const rows = connections.filter((c) => info.connections.includes(c.provider))
  const connected = rows.filter((c) => c.connected)
  const enabled = connected.filter((c) => c.enabled !== false)
  const usable = enabled.find((c) => c.available !== false)
  if (usable !== undefined) {
    return { ok: true, route: { harness, provider: model.provider, model, connectionId: usable.provider } }
  }
  const unavailable = enabled.find((c) => c.available === false)
  if (unavailable !== undefined) {
    return {
      ok: false,
      code: "connection-unavailable",
      message: `The ${unavailable.provider} connection cannot serve ${info.name}${unavailable.error === undefined ? "" : `: ${unavailable.error}`}. Reconnect it in Settings › Connections.`,
    }
  }
  if (connected.length > 0) {
    return {
      ok: false,
      code: "disabled-connection",
      message: `The ${info.name} connection is disabled. Enable it in Settings › Connections.`,
    }
  }
  return {
    ok: false,
    code: "missing-connection",
    message: `Connect ${info.name} in Settings › Connections to use ${model.name}.`,
  }
}

/**
 * Resolve a thread's model selection to the harness connection that runs it, without touching the network.
 *
 * `harnessId` scopes the model id first: a model that exists on another harness (or a duplicate id across two
 * harnesses) never wins by catalog order, alphabetical order or a global default. With no harness, a model id that
 * appears more than once is an explicit `ambiguous-model` failure. The chosen connection must be configured and
 * enabled; a missing, disabled or unavailable connection is a typed failure with an actionable message.
 */
export const resolveModelRoute = (input: {
  readonly harnessId?: HarnessId | undefined
  readonly modelId: string | undefined
  readonly connections: readonly ConnectionState[]
}): ModelRouteResult => {
  const { harnessId, modelId, connections } = input
  if (modelId === undefined || modelId === "") {
    return routeFailure("missing-model", "Choose a model before sending.")
  }
  if (harnessId !== undefined && !HARNESS_IDS.includes(harnessId)) {
    return routeFailure("unknown-harness", `Unknown harness "${String(harnessId)}". Choose one in Settings › Connections.`)
  }
  const candidates = AGENT_MODELS.filter((m) => m.id === modelId)
  if (candidates.length === 0) {
    return routeFailure("missing-model", `Model "${modelId}" is not in Kestrel's catalog. Pick another in the model menu.`)
  }
  const scoped = harnessId === undefined ? candidates : candidates.filter((m) => harnessIdOfProvider(m.provider) === harnessId)
  if (scoped.length === 0) {
    const harnesses = [...new Set(candidates.map((m) => harnessIdOfProvider(m.provider)))]
    return routeFailure(
      "harness-mismatch",
      `${candidates[0]!.name} is not available on ${HARNESS_LABELS[harnessId as HarnessId]}; it runs on ${harnesses.map((h) => HARNESS_LABELS[h]).join(", ")}.`,
    )
  }
  if (scoped.length > 1) {
    return routeFailure(
      "ambiguous-model",
      `Model "${modelId}" exists on more than one harness (${[...new Set(scoped.map((m) => HARNESS_LABELS[harnessIdOfProvider(m.provider)]))].join(", ")}). Select the thread's harness to disambiguate.`,
    )
  }
  return connectionFailure(scoped[0]!, connections)
}
