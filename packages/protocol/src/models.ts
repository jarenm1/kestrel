import { Schema } from "effect"

/**
 * Anthropic and the third-party gateways run through Claude Code, OpenAI through codex, and OpenCode (its free models
 * and its Go plan), Antigravity CLI and Devin CLI run their own providers' models over the Agent Client Protocol.
 */
export const ModelProvider = Schema.Literal(
  "anthropic",
  "openai",
  "openrouter",
  "zai",
  "deepseek",
  "minimax",
  "moonshot",
  "opencode",
  "opencode-go",
  "google",
  "devin",
)
export type ModelProvider = typeof ModelProvider.Type

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
 * The harness a model's route runs in. A base model id uses its provider's current harness; a route id names another
 * compatible harness explicitly (`${baseId}@${harness}`). Antigravity and Devin are not route suffixes: Google's and
 * Devin's models are only available through their own CLIs.
 */
export const ModelHarness = Schema.Literal("claude", "codex", "opencode", "antigravity", "devin")
export type ModelHarness = typeof ModelHarness.Type

/** A harness a base model id can be routed to with an `@` suffix. */
export const RouteHarness = Schema.Literal("claude", "codex", "opencode")
export type RouteHarness = typeof RouteHarness.Type

/** Every provider's current harness; a base model id keeps it, and a route id overrides it for one run. */
export const DEFAULT_MODEL_HARNESS = {
  anthropic: "claude",
  openai: "codex",
  openrouter: "claude",
  zai: "claude",
  deepseek: "claude",
  minimax: "claude",
  moonshot: "claude",
  opencode: "opencode",
  "opencode-go": "opencode",
  google: "antigravity",
  devin: "devin",
} as const satisfies Record<ModelProvider, ModelHarness>

/**
 * Base model ids per provider, passed to the provider's CLI (`claude --model`, the Codex app-server thread's
 * `model`, the ACP `model` config option of OpenCode, which names OpenCode's own provider first (`opencode` free,
 * `opencode-go` Go), and of Antigravity CLI). Grouping by provider is what lets `AgentModel` promise exactly the
 * route ids the catalog generates: a provider's models only route to its documented harnesses.
 */
const BASE_MODEL_IDS = {
  anthropic: [
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
  ],
  openai: [
    "gpt-6-astra",
    "gpt-6.1-sol",
    "gpt-6.1-terra",
    "gpt-6-luna",
    "gpt-6-sol",
  ],
  openrouter: [
    "anthropic/claude-fable-5.1",
    "anthropic/claude-opus-5.5",
    "anthropic/claude-sonnet-5.5",
    "anthropic/claude-haiku-5.5",
  ],
  zai: [
    "glm-5.3[1m]",
    "glm-5.3-flash[1m]",
    "glm-5.3-flashx[1m]",
    "glm-5.2[1m]",
  ],
  deepseek: [
    "deepseek-flash[1m]",
    "deepseek-v4-pro",
  ],
  minimax: [
    "MiniMax-M3.1-Flash[1m]",
    "MiniMax-M3[1m]",
  ],
  moonshot: [
    "kimi-k3.1-pro",
    "kimi-k3.1-pro-highspeed",
    "kimi-k3[1m]",
    "kimi-k2.7-code",
  ],
  opencode: [
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
  ],
  "opencode-go": [
    "opencode-go/kimi-k3.1-pro",
    "opencode-go/minimax-m3.1-flash",
    "opencode-go/mimo-v2.6-pro",
    "opencode-go/mimo-v2.6-flash",
    "opencode-go/grok-4.7",
    "opencode-go/step-5-preview",
    "opencode-go/deepseek-v4.1-flash",
    "opencode-go/hy4-preview",
    "opencode-go/glm-5.3-flash",
    "opencode-go/qwen3.8-flash",
    "opencode-go/glm-5.3",
    "opencode-go/qwen3.8-max",
    "opencode-go/kimi-k3",
    "opencode-go/hy3",
    "opencode-go/longcat-2.0",
    "opencode-go/glm-5.2",
    "opencode-go/kimi-k2.7-code",
    "opencode-go/qwen3.7-plus",
    "opencode-go/minimax-m3",
    "opencode-go/deepseek-v4-pro",
    "opencode-go/mimo-v2.5-pro",
    "opencode-go/mimo-v2.5",
  ],
  google: [
    "gemini-3.8-flash",
  ],
  devin: [
    "adaptive",
    "swe-1-6-fast",
  ],
} as const satisfies Record<ModelProvider, readonly string[]>

type BaseAgentModel = { [P in ModelProvider]: (typeof BASE_MODEL_IDS)[P][number] }[ModelProvider]

type RouteHarnessesFor<P extends ModelProvider> = P extends keyof typeof ROUTE_HARNESSES
  ? (typeof ROUTE_HARNESSES)[P][number]
  : never

type ProviderOf<I extends string> = {
  [P in ModelProvider]: I extends (typeof BASE_MODEL_IDS)[P][number] ? P : never
}[ModelProvider]

/** Harnesses the catalog offers for `I`: documented per provider, minus the provider's current harness. */
type DocumentedHarnesses<I extends string> = Exclude<
  RouteHarnessesFor<ProviderOf<I>>,
  (typeof DEFAULT_MODEL_HARNESS)[ProviderOf<I>]
>

type ExcludedHarnesses<I extends string> = I extends keyof typeof ROUTE_EXCLUSIONS
  ? (typeof ROUTE_EXCLUSIONS)[I][number]
  : never

/** The exact route ids the catalog can build, so the type and the schema cannot disagree. */
type RouteAgentModel = {
  [I in BaseAgentModel]: `${I}@${Exclude<DocumentedHarnesses<I>, ExcludedHarnesses<I>>}`
}[BaseAgentModel]

/**
 * A base model id, or a route id that runs that model in another compatible harness. The schema below is generated
 * from the catalog's supported routes, so no arbitrary `@harness` string is accepted.
 */
export type AgentModel = BaseAgentModel | RouteAgentModel

export interface ModelInfo {
  readonly id: AgentModel
  readonly provider: ModelProvider
  /** Display name; the id is never shown. */
  readonly name: string
  /** Thinking levels the model accepts, lowest first. Empty: the model takes no thinking level. */
  readonly efforts: readonly AgentEffort[]
  /** Composer fallback when no supported effort was chosen; otherwise the lowest supported level. */
  readonly defaultEffort?: AgentEffort
  /** In the chat model picker until the user edits the provider's list on the connections page. */
  readonly shownByDefault: boolean
  /** Provider-advertised context window for Claude Code's auto-compaction. */
  readonly compactWindow?: number
  /** The harness a route id selects; absent on a base id, which uses its provider's current harness. */
  readonly harness?: ModelHarness
  /** The model id the native API expects, without a route suffix or Claude Code's `[1m]` decoration. */
  readonly upstreamModel?: string
}

const CLAUDE_ALL: readonly AgentEffort[] = ["low", "medium", "high", "xhigh", "max"]
const CLAUDE_NO_XHIGH: readonly AgentEffort[] = ["low", "medium", "high", "max"]
const GATEWAY_LOW_HIGH_MAX: readonly AgentEffort[] = ["low", "high", "max"]
const GPT_FROM_LOW: readonly AgentEffort[] = ["low", "medium", "high", "xhigh", "max"]
const GPT_FROM_NONE: readonly AgentEffort[] = ["none", "low", "medium", "high", "xhigh", "max"]
const OC_LOW_HIGH_MAX: readonly AgentEffort[] = ["low", "high", "max"]
const OC_LOW_TO_MAX: readonly AgentEffort[] = ["low", "medium", "high", "xhigh", "max"]

/**
 * Every model the box can run, in picker order (newest first within a provider). Effort support follows Claude
 * Code's model configuration docs, OpenAI's model pages, and each third-party provider's Claude Code guide.
 * Providers without a documented effort scale list none, so the picker offers no unsupported control. OpenCode's
 * efforts are what its ACP `effort` option offers per model; OpenCode rotates its free models, so the list follows
 * its own. OpenCode Go's are the Go plan's models that no other provider here runs (its
 * Claude, GPT and Gemini models are left to theirs), and none of its free or contributor ones.
 */
const BASE_AGENT_MODELS: readonly ModelInfo[] = [
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
  { id: "glm-5.3[1m]", provider: "zai", name: "GLM-5.3", efforts: GATEWAY_LOW_HIGH_MAX, defaultEffort: "max", shownByDefault: true, compactWindow: 1_000_000 },
  { id: "glm-5.3-flash[1m]", provider: "zai", name: "GLM-5.3 Flash", efforts: GATEWAY_LOW_HIGH_MAX, defaultEffort: "max", shownByDefault: true, compactWindow: 1_000_000 },
  { id: "glm-5.3-flashx[1m]", provider: "zai", name: "GLM-5.3 FlashX", efforts: GATEWAY_LOW_HIGH_MAX, defaultEffort: "max", shownByDefault: false, compactWindow: 1_000_000 },
  { id: "glm-5.2[1m]", provider: "zai", name: "GLM-5.2", efforts: GATEWAY_LOW_HIGH_MAX, defaultEffort: "max", shownByDefault: false, compactWindow: 1_000_000 },
  // deepseek-flash is the live API alias for V4.1 Flash 1017, not the retired V4 Flash.
  { id: "deepseek-flash[1m]", provider: "deepseek", name: "DeepSeek V4.1 Flash 1017", efforts: CLAUDE_NO_XHIGH, shownByDefault: true, compactWindow: 786_432 },
  { id: "deepseek-v4-pro", provider: "deepseek", name: "DeepSeek V4 Pro 0813", efforts: CLAUDE_NO_XHIGH, shownByDefault: true },
  { id: "MiniMax-M3.1-Flash[1m]", provider: "minimax", name: "MiniMax M3.1 Flash", efforts: CLAUDE_ALL, shownByDefault: true, compactWindow: 524_288 },
  { id: "MiniMax-M3[1m]", provider: "minimax", name: "MiniMax M3", efforts: [], shownByDefault: true, compactWindow: 1_000_000 },
  { id: "kimi-k3.1-pro", provider: "moonshot", name: "Kimi K3.1 Pro", efforts: GATEWAY_LOW_HIGH_MAX, shownByDefault: true, compactWindow: 1_000_000 },
  { id: "kimi-k3.1-pro-highspeed", provider: "moonshot", name: "Kimi K3.1 Pro Highspeed", efforts: GATEWAY_LOW_HIGH_MAX, shownByDefault: true, compactWindow: 1_000_000 },
  { id: "kimi-k3[1m]", provider: "moonshot", name: "Kimi K3", efforts: GATEWAY_LOW_HIGH_MAX, shownByDefault: false, compactWindow: 1_000_000 },
  { id: "kimi-k2.7-code", provider: "moonshot", name: "Kimi K2.7 Code", efforts: [], shownByDefault: false },
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
  { id: "opencode-go/kimi-k3.1-pro", provider: "opencode-go", name: "Kimi K3.1 Pro", efforts: OC_LOW_HIGH_MAX, shownByDefault: true },
  { id: "opencode-go/minimax-m3.1-flash", provider: "opencode-go", name: "MiniMax M3.1 Flash", efforts: OC_LOW_TO_MAX, shownByDefault: true },
  { id: "opencode-go/mimo-v2.6-pro", provider: "opencode-go", name: "MiMo-V2.6-Pro", efforts: [], shownByDefault: false },
  { id: "opencode-go/mimo-v2.6-flash", provider: "opencode-go", name: "MiMo-V2.6-Flash", efforts: [], shownByDefault: false },
  { id: "opencode-go/grok-4.7", provider: "opencode-go", name: "Grok 4.7", efforts: ["low", "medium", "high", "xhigh"], shownByDefault: false },
  { id: "opencode-go/step-5-preview", provider: "opencode-go", name: "Step 5 Preview", efforts: ["low", "medium", "high"], shownByDefault: false },
  { id: "opencode-go/deepseek-v4.1-flash", provider: "opencode-go", name: "DeepSeek V4.1 Flash", efforts: OC_LOW_HIGH_MAX, shownByDefault: true },
  { id: "opencode-go/hy4-preview", provider: "opencode-go", name: "Hy4 preview", efforts: ["none", "high"], shownByDefault: false },
  { id: "opencode-go/glm-5.3-flash", provider: "opencode-go", name: "GLM-5.3-Flash", efforts: OC_LOW_HIGH_MAX, shownByDefault: false },
  { id: "opencode-go/qwen3.8-flash", provider: "opencode-go", name: "Qwen3.8 Flash", efforts: ["none", "low", "medium", "xhigh"], shownByDefault: false },
  { id: "opencode-go/glm-5.3", provider: "opencode-go", name: "GLM-5.3", efforts: OC_LOW_HIGH_MAX, shownByDefault: true },
  { id: "opencode-go/qwen3.8-max", provider: "opencode-go", name: "Qwen3.8 Max", efforts: ["none", "low", "medium", "xhigh"], shownByDefault: true },
  { id: "opencode-go/kimi-k3", provider: "opencode-go", name: "Kimi K3", efforts: ["max"], shownByDefault: false },
  { id: "opencode-go/hy3", provider: "opencode-go", name: "Hy3", efforts: ["none", "low", "high"], shownByDefault: false },
  { id: "opencode-go/longcat-2.0", provider: "opencode-go", name: "LongCat-2.0", efforts: [], shownByDefault: false },
  { id: "opencode-go/glm-5.2", provider: "opencode-go", name: "GLM-5.2", efforts: ["high", "max"], shownByDefault: false },
  { id: "opencode-go/kimi-k2.7-code", provider: "opencode-go", name: "Kimi K2.7 Code", efforts: [], shownByDefault: false },
  { id: "opencode-go/qwen3.7-plus", provider: "opencode-go", name: "Qwen3.7 Plus", efforts: ["none", "high", "max"], shownByDefault: false },
  // Its thinking switch (`none` / `thinking`) has no Kestrel level; it runs at OpenCode's default.
  { id: "opencode-go/minimax-m3", provider: "opencode-go", name: "MiniMax-M3", efforts: [], shownByDefault: false },
  { id: "opencode-go/deepseek-v4-pro", provider: "opencode-go", name: "DeepSeek V4 Pro", efforts: ["high", "max"], shownByDefault: false },
  { id: "opencode-go/mimo-v2.5-pro", provider: "opencode-go", name: "MiMo V2.5 Pro", efforts: [], shownByDefault: false },
  { id: "opencode-go/mimo-v2.5", provider: "opencode-go", name: "MiMo V2.5", efforts: [], shownByDefault: false },
  // What a signed-in Google account's Antigravity CLI offers, with its `thought_level` option.
  { id: "gemini-3.8-flash", provider: "google", name: "Gemini 3.8 Flash", efforts: ["low", "medium", "high"], shownByDefault: true },
  // Values of Devin CLI's ACP `model` option for a signed-in Devin account: its Adaptive router and its own fast model.
  { id: "adaptive", provider: "devin", name: "Adaptive", efforts: [], shownByDefault: true },
  { id: "swe-1-6-fast", provider: "devin", name: "SWE-1.6 Fast", efforts: [], shownByDefault: true },
]

/**
 * The additional harnesses each provider's models can run in. A base id keeps the provider's current harness; these
 * are the only `@harness` routes the catalog offers. Free OpenCode models and Google's Antigravity models stay on
 * their native harness; per-model exclusions below remove models a native route does not document.
 */
const ROUTE_HARNESSES = {
  anthropic: ["opencode"],
  openai: ["opencode"],
  openrouter: ["codex", "opencode"],
  zai: ["codex", "opencode"],
  deepseek: ["codex", "opencode"],
  minimax: ["codex", "opencode"],
  moonshot: ["codex", "opencode"],
  // The Go gateway is the one OpenCode provider whose models may run in Claude Code or Codex.
  "opencode-go": ["claude", "codex"],
} as const satisfies Partial<Record<ModelProvider, readonly RouteHarness[]>>

const ROUTE_HARNESS_LABELS: Record<RouteHarness, string> = {
  claude: "Claude Code",
  codex: "Codex",
  opencode: "OpenCode",
}

/**
 * Efforts a native API documents differently from the provider's Claude Code guide. DeepSeek's Codex integration
 * declares low/high/max only, so a route must not offer the Claude route's medium level.
 */
const ROUTE_EFFORTS: Readonly<Record<string, readonly AgentEffort[]>> = {
  "deepseek-flash[1m]@codex": ["low", "high", "max"],
  "deepseek-v4-pro@codex": ["low", "high", "max"],
}

/**
 * Base models whose provider's native route does not support the model. Kimi's Responses endpoint lists
 * `kimi-k3.1-pro`, `kimi-k3.1-pro-highspeed` and `kimi-k3` only, so its older code model keeps Claude/OpenCode routes.
 */
const ROUTE_EXCLUSIONS = {
  "kimi-k2.7-code": ["codex"],
} as const satisfies Readonly<Record<string, readonly RouteHarness[]>>

/** The model id the routed harness's native API expects. OpenCode's own catalog prefix stays only on its native route. */
const routedUpstreamId = (base: ModelInfo, harness: RouteHarness): string => {
  const id = base.id.replace(/@(?:claude|codex|opencode)$/, "")
  // Claude Code's 1m-context decoration is not part of the model id a native OpenAI/OpenCode API receives.
  const native = id.replace(/\[1m\]$/i, "")
  if (base.provider === "opencode-go") return native.replace(/^opencode-go\//, "")
  // Claude Code needs the decoration; a native OpenAI/OpenCode API must not receive it.
  return harness === "claude" ? id : native
}

const routeModel = (base: ModelInfo, harness: RouteHarness): ModelInfo => {
  const id = `${base.id}@${harness}` as AgentModel
  // OpenCode's ACP thought_level option is cosmetic for the openai-compatible package (it does not forward the level
  // upstream), so its routes advertise no thinking levels instead of silently running the provider default.
  const efforts = harness === "opencode" ? [] : ROUTE_EFFORTS[id] ?? base.efforts
  const defaultEffort =
    base.defaultEffort !== undefined && efforts.includes(base.defaultEffort) ? base.defaultEffort : undefined
  return {
    id,
    provider: base.provider,
    name: `${base.name} via ${ROUTE_HARNESS_LABELS[harness]}`,
    efforts,
    ...(defaultEffort === undefined ? {} : { defaultEffort }),
    // Route entries stay off the default picker so stored defaults and current behavior do not change.
    shownByDefault: false,
    ...(base.compactWindow === undefined ? {} : { compactWindow: base.compactWindow }),
    harness,
    upstreamModel: routedUpstreamId(base, harness),
  }
}

/**
 * Every model the box can run, in picker order: each base model followed by its supported route variants. A route id
 * only selects another compatible harness; the credential provider remains the base model's provider.
 */
export const AGENT_MODELS: readonly ModelInfo[] = BASE_AGENT_MODELS.flatMap((base) => {
  const excluded = (ROUTE_EXCLUSIONS as Readonly<Record<string, readonly RouteHarness[]>>)[base.id] ?? []
  const documented = (ROUTE_HARNESSES as Partial<Record<ModelProvider, readonly RouteHarness[]>>)[base.provider] ?? []
  const routes = documented.filter(
    (harness) => harness !== DEFAULT_MODEL_HARNESS[base.provider] && !excluded.includes(harness),
  )
  return [base, ...routes.map((harness) => routeModel(base, harness))]
})

/** Model ids accepted by the protocol: every base id plus the supported route ids generated above. */
const AGENT_MODEL_IDS = AGENT_MODELS.map((model) => model.id) as [AgentModel, ...AgentModel[]]
export const AgentModel = Schema.Literal(...AGENT_MODEL_IDS)

export interface ModelProviderInfo {
  readonly id: ModelProvider
  readonly name: string
  /**
   * `Connection.provider` ids that give the box access to this provider's models: an API key or a CLI login.
   */
  readonly connections: readonly string[]
  /** Provider-specific setup note shown in Connections. */
  readonly hint?: string
}

export const MODEL_PROVIDERS: readonly ModelProviderInfo[] = [
  { id: "anthropic", name: "Anthropic", connections: ["anthropic", "claude-cli"] },
  { id: "openai", name: "OpenAI", connections: ["openai", "codex-cli"] },
  { id: "openrouter", name: "OpenRouter", connections: ["openrouter"] },
  { id: "zai", name: "Z.ai", connections: ["zai"] },
  { id: "deepseek", name: "DeepSeek", connections: ["deepseek"] },
  { id: "minimax", name: "MiniMax", connections: ["minimax"] },
  { id: "moonshot", name: "Kimi (Moonshot AI)", connections: ["moonshot"], hint: "Use a Moonshot Platform API key. Kimi Code membership keys use a different host and model ids and are not supported." },
  // Free models require an OpenCode Console account, separate from the Go plan's key.
  { id: "opencode", name: "OpenCode", connections: ["opencode"] },
  // OpenCode Go runs on the same OpenCode CLI (2.1), but needs the Go plan's key.
  { id: "opencode-go", name: "OpenCode Go", connections: ["opencode-go"] },
  { id: "google", name: "Google", connections: ["antigravity-cli"] },
  { id: "devin", name: "Devin", connections: ["devin-cli"] },
]

/** The provider a message without a model runs on: the box's default harness. */
export const DEFAULT_MODEL_PROVIDER: ModelProvider = "anthropic"

export const modelInfo = (id: AgentModel): ModelInfo => {
  const info = AGENT_MODELS.find((m) => m.id === id)
  if (info === undefined) throw new Error(`model ${id} is missing from AGENT_MODELS`)
  return info
}

/**
 * `id` as an `AgentModel` when the catalog offers it, else undefined. Use it wherever an untrusted string becomes a
 * model id, so a client never turns an unsupported route into the bare `Error` from `modelInfo`.
 */
export const parseAgentModel = (id: string): AgentModel | undefined =>
  AGENT_MODELS.some((model) => model.id === id) ? (id as AgentModel) : undefined

/** The harness a model runs in: the route's explicit choice, else its provider's current harness. */
export const modelHarness = (id: AgentModel): ModelHarness => {
  const info = modelInfo(id)
  return info.harness ?? DEFAULT_MODEL_HARNESS[info.provider]
}

/** The model id to send to the routed harness's native API, never the protocol's route id. */
export const modelUpstreamId = (id: AgentModel): string => {
  const info = modelInfo(id)
  if (info.upstreamModel !== undefined) return info.upstreamModel
  const base = id.replace(/@(?:claude|codex|opencode)$/, "")
  // Native OpenCode/Claude refs keep their own decorations and provider prefix; only a Codex route drops `[1m]`.
  return modelHarness(id) === "codex" ? base.replace(/\[1m\]$/i, "") : base
}

export const providerModels = (provider: ModelProvider): readonly ModelInfo[] =>
  AGENT_MODELS.filter((m) => m.provider === provider)

/** Providers with an available, authenticated connection, in catalog order. */
export const connectedModelProviders = (
  connections: ReadonlyArray<{ readonly provider: string; readonly connected: boolean; readonly available?: boolean }>,
): readonly ModelProviderInfo[] =>
  MODEL_PROVIDERS.filter((p) =>
    connections.some((c) => c.connected && c.available !== false && p.connections.includes(c.provider)),
  )

/**
 * The catalog model a route id belongs to: its base id without the `@harness` suffix. Visibility is stored per model,
 * not per route, so enabling a model enables it in every harness it supports.
 */
export const baseModelId = (id: AgentModel): AgentModel =>
  id.replace(/@(?:claude|codex|opencode)$/, "") as AgentModel

/**
 * The provider's models in the chat picker, in catalog order. `chosen` is the user's saved list for the provider
 * (from the connections page), or null before they edited it. A saved list is compared by base model id, so a model
 * selected once appears under every supported harness.
 */
export const shownModels = (provider: ModelProvider, chosen: ReadonlyArray<AgentModel> | null): readonly ModelInfo[] => {
  const chosenBase = chosen === null ? null : new Set(chosen.map(baseModelId))
  return providerModels(provider).filter((m) => {
    const base = baseModelId(m.id)
    return chosenBase === null ? modelInfo(base).shownByDefault : chosenBase.has(base)
  })
}

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
  const effort = level !== undefined && level !== "default" && model?.efforts.includes(level)
    ? level
    : model?.defaultEffort ?? model?.efforts[0]
  return { model, effort }
}
