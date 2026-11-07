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
    "fusion",
    "swe-2",
    "swe-2-flash",
    "swe-1-7",
    "swe-1-6",
    "swe-1-6-fast",
    "devin/claude-fable-5-1",
    "devin/claude-opus-5-5",
    "devin/claude-sonnet-5-5",
    "devin/claude-haiku-5-5",
    "devin/claude-opus-5",
    "devin/claude-sonnet-5",
    "devin/claude-opus-4-8",
    "devin/claude-opus-4-7",
    "devin/claude-opus-4-6",
    "devin/claude-sonnet-4-6",
    "devin/gpt-6-astra",
    "devin/gpt-6.1-sol",
    "devin/gpt-6.1-terra",
    "devin/gpt-6-luna",
    "devin/gpt-6-sol",
    "devin/gpt-5.6-sol",
    "devin/gpt-5.6-terra",
    "devin/gpt-5.6-luna",
    "devin/gpt-5.5",
    "devin/gemini-4-argon",
    "devin/gemini-3.8-flash",
    "devin/gemini-3.7-flash",
    "devin/gemini-3.5-flash",
    "devin/gemini-3.1-pro-preview",
    "devin/gemini-3-flash-preview",
    "devin/gemini-2.5-flash",
    "devin/kimi-k3",
    "devin/glm-5.3",
    "devin/glm-5.3-flash",
    "devin/glm-5.2",
    "devin/deepseek-v4.1-flash",
    "devin/deepseek-v4-pro",
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
 * Curated routes or a provider-qualified runtime model. Live ids are self-describing so persisted runs can be
 * decoded after a restart without sharing one user's discovered catalog with another user.
 */
export type AgentModel = BaseAgentModel | RouteAgentModel | `live/${ModelProvider}/${string}`

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
  // Family ids of Devin CLI's ACP `model` option for a signed-in account: its routers, Cognition SWE models, and the
  // frontier/open-weight families Devin CLI serves. Devin's catalog is account-scoped, so only Cognition's own models
  // are shown by default; the third-party families stay available on the Connections page but off the initial picker.
  { id: "adaptive", provider: "devin", name: "Adaptive", efforts: [], shownByDefault: true },
  { id: "fusion", provider: "devin", name: "Fusion", efforts: [], shownByDefault: true },
  { id: "swe-2", provider: "devin", name: "SWE-2", efforts: ["medium", "high", "max"], defaultEffort: "high", shownByDefault: true },
  { id: "swe-2-flash", provider: "devin", name: "SWE-2 Flash", efforts: ["medium", "high", "max"], defaultEffort: "medium", shownByDefault: true },
  { id: "swe-1-7", provider: "devin", name: "SWE-1.7", efforts: [], shownByDefault: true },
  { id: "swe-1-6", provider: "devin", name: "SWE-1.6", efforts: [], shownByDefault: true },
  { id: "swe-1-6-fast", provider: "devin", name: "SWE-1.6 Fast", efforts: [], shownByDefault: true },
  { id: "devin/claude-fable-5-1", provider: "devin", name: "Claude Fable 5.1", efforts: [], shownByDefault: false },
  { id: "devin/claude-opus-5-5", provider: "devin", name: "Claude Opus 5.5", efforts: [], shownByDefault: false },
  { id: "devin/claude-sonnet-5-5", provider: "devin", name: "Claude Sonnet 5.5", efforts: [], shownByDefault: false },
  { id: "devin/claude-haiku-5-5", provider: "devin", name: "Claude Haiku 5.5", efforts: [], shownByDefault: false },
  { id: "devin/claude-opus-5", provider: "devin", name: "Claude Opus 5", efforts: [], shownByDefault: false },
  { id: "devin/claude-sonnet-5", provider: "devin", name: "Claude Sonnet 5", efforts: [], shownByDefault: false },
  { id: "devin/claude-opus-4-8", provider: "devin", name: "Claude Opus 4.8", efforts: [], shownByDefault: false },
  { id: "devin/claude-opus-4-7", provider: "devin", name: "Claude Opus 4.7", efforts: [], shownByDefault: false },
  { id: "devin/claude-opus-4-6", provider: "devin", name: "Claude Opus 4.6", efforts: [], shownByDefault: false },
  { id: "devin/claude-sonnet-4-6", provider: "devin", name: "Claude Sonnet 4.6", efforts: [], shownByDefault: false },
  { id: "devin/gpt-6-astra", provider: "devin", name: "GPT-6 Astra", efforts: [], shownByDefault: false },
  { id: "devin/gpt-6.1-sol", provider: "devin", name: "GPT-6.1 Sol", efforts: [], shownByDefault: false },
  { id: "devin/gpt-6.1-terra", provider: "devin", name: "GPT-6.1 Terra", efforts: [], shownByDefault: false },
  { id: "devin/gpt-6-luna", provider: "devin", name: "GPT-6 Luna", efforts: [], shownByDefault: false },
  { id: "devin/gpt-6-sol", provider: "devin", name: "GPT-6 Sol", efforts: [], shownByDefault: false },
  { id: "devin/gpt-5.6-sol", provider: "devin", name: "GPT-5.6 Sol", efforts: [], shownByDefault: false },
  { id: "devin/gpt-5.6-terra", provider: "devin", name: "GPT-5.6 Terra", efforts: [], shownByDefault: false },
  { id: "devin/gpt-5.6-luna", provider: "devin", name: "GPT-5.6 Luna", efforts: [], shownByDefault: false },
  { id: "devin/gpt-5.5", provider: "devin", name: "GPT-5.5", efforts: [], shownByDefault: false },
  { id: "devin/gemini-4-argon", provider: "devin", name: "Gemini 4 Argon", efforts: [], shownByDefault: false },
  { id: "devin/gemini-3.8-flash", provider: "devin", name: "Gemini 3.8 Flash", efforts: [], shownByDefault: false },
  { id: "devin/gemini-3.7-flash", provider: "devin", name: "Gemini 3.7 Flash", efforts: [], shownByDefault: false },
  { id: "devin/gemini-3.5-flash", provider: "devin", name: "Gemini 3.5 Flash", efforts: [], shownByDefault: false },
  { id: "devin/gemini-3.1-pro-preview", provider: "devin", name: "Gemini 3.1 Pro Preview", efforts: [], shownByDefault: false },
  { id: "devin/gemini-3-flash-preview", provider: "devin", name: "Gemini 3 Flash Preview", efforts: [], shownByDefault: false },
  { id: "devin/gemini-2.5-flash", provider: "devin", name: "Gemini 2.5 Flash", efforts: [], shownByDefault: false },
  { id: "devin/kimi-k3", provider: "devin", name: "Kimi K3", efforts: [], shownByDefault: false },
  { id: "devin/glm-5.3", provider: "devin", name: "GLM-5.3", efforts: [], shownByDefault: false },
  { id: "devin/glm-5.3-flash", provider: "devin", name: "GLM-5.3 Flash", efforts: [], shownByDefault: false },
  { id: "devin/glm-5.2", provider: "devin", name: "GLM-5.2", efforts: [], shownByDefault: false },
  { id: "devin/deepseek-v4.1-flash", provider: "devin", name: "DeepSeek V4.1 Flash", efforts: [], shownByDefault: false },
  { id: "devin/deepseek-v4-pro", provider: "devin", name: "DeepSeek V4 Pro", efforts: [], shownByDefault: false },
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

const curatedModelIds = new Set<string>(AGENT_MODELS.map((model) => model.id))
const liveModelParts = (id: string): { provider: ModelProvider; upstream: string } | undefined => {
  const match = /^live\/([^/]+)\/([A-Za-z0-9][A-Za-z0-9._:/+-]{0,199})$/.exec(id)
  if (match === null || !Schema.is(ModelProvider)(match[1])) return undefined
  const provider = match[1]
  const upstream = match[2]!
  if ((provider === "opencode" || provider === "opencode-go") && !upstream.startsWith(`${provider}/`)) return undefined
  return { provider, upstream }
}

/** Tokens model ids spell in capitals; everything else is capitalized as a word. */
const NAME_ACRONYMS: Readonly<Record<string, string>> = {
  gpt: "GPT",
  glm: "GLM",
  swe: "SWE",
  ai: "AI",
  llm: "LLM",
  vl: "VL",
  api: "API",
  oss: "OSS",
  mcp: "MCP",
}

/** Known curated routes plus bounded, shell-safe, provider-qualified native model identities. */
export const AgentModel = Schema.String.pipe(
  Schema.filter((id): id is AgentModel => curatedModelIds.has(id) || liveModelParts(id) !== undefined),
)

export const ModelInfo = Schema.Struct({
  id: AgentModel,
  provider: ModelProvider,
  name: Schema.String,
  efforts: Schema.Array(AgentEffort),
  defaultEffort: Schema.optional(AgentEffort),
  shownByDefault: Schema.Boolean,
  compactWindow: Schema.optional(Schema.Number),
  harness: Schema.optional(ModelHarness),
  upstreamModel: Schema.optional(Schema.String),
}).pipe(Schema.filter((model) => {
  const live = liveModelParts(model.id)
  return live === undefined || (
    live.provider === model.provider &&
    model.efforts.length === 0 &&
    model.defaultEffort === undefined &&
    (model.harness === undefined || model.harness === DEFAULT_MODEL_HARNESS[live.provider]) &&
    (model.upstreamModel === undefined || model.upstreamModel === live.upstream)
  )
}))

export const ModelDiscoverySource = Schema.Struct({
  provider: ModelProvider,
  source: Schema.String,
  status: Schema.Literal("ok", "unsupported", "error"),
  message: Schema.optional(Schema.String),
  checkedAt: Schema.String,
})
export type ModelDiscoverySource = typeof ModelDiscoverySource.Type

export const ModelCatalog = Schema.Struct({
  models: Schema.Array(ModelInfo),
  sources: Schema.Array(ModelDiscoverySource),
})
export type ModelCatalog = typeof ModelCatalog.Type

/** Retain curated metadata and supported routes; live models never acquire speculative effort levels or routes. */
export const mergeModelCatalog = (discovered: readonly ModelInfo[]): readonly ModelInfo[] => {
  const models = new Map(AGENT_MODELS.map((model) => [model.id, model]))
  for (const model of discovered) if (!models.has(model.id)) models.set(model.id, model)
  return [...models.values()]
}

/**
 * A readable name for a runtime model, from its id's own words: `anthropic/claude-opus-4-5` becomes
 * `Claude Opus 4.5`, `gpt-5.6-sol` becomes `GPT-5.6 Sol`. It is deterministic so a saved mention and every client
 * agree on the name without carrying a per-user catalog.
 */
const humanizedModelName = (upstream: string): string => {
  const leaf = upstream.slice(upstream.lastIndexOf("/") + 1).replace(/\[1m\]$/i, "")
  const words: string[] = []
  let afterAcronym = false
  for (const token of leaf.split(/[-_]+/)) {
    if (token === "") continue
    const previous = words.at(-1)
    // `5-1` in a version reads as `5.1`, not as two separate numbers.
    if (/^\d+$/.test(token) && previous !== undefined && /^\d+(?:\.\d+)*$/.test(previous)) {
      words[words.length - 1] = `${previous}.${token}`
      afterAcronym = false
      continue
    }
    // A version keeps the hyphen after an acronym: `gpt-5.6-sol` is `GPT-5.6 Sol`, not `GPT 5.6 Sol`.
    if (afterAcronym && previous !== undefined && /^\d/.test(token)) {
      words[words.length - 1] = `${previous}-${token}`
      afterAcronym = false
      continue
    }
    const acronym = NAME_ACRONYMS[token.toLowerCase()]
    words.push(
      acronym ??
        // OpenAI's reasoning models are named in lowercase (`o3`), so keep that id's own spelling.
        (/^o\d/.test(token) ? token : /[A-Z]/.test(token.slice(1)) ? token : `${token.charAt(0).toUpperCase()}${token.slice(1)}`),
    )
    afterAcronym = acronym !== undefined
  }
  return words.join(" ") || upstream
}

/** A source's native id, mapped back to curated metadata where it already exists. */
export const discoveredModel = (provider: ModelProvider, upstream: string): ModelInfo | undefined => {
  const id = `live/${provider}/${upstream}`
  if (liveModelParts(id) === undefined) return undefined
  const known = BASE_AGENT_MODELS.find((model) =>
    model.provider === provider && (model.upstreamModel ?? model.id).replace(/\[1m\]$/i, "") === upstream.replace(/\[1m\]$/i, ""),
  )
  if (known !== undefined) return known
  return {
    id: id as AgentModel,
    provider,
    name: humanizedModelName(upstream),
    efforts: [],
    shownByDefault: true,
    upstreamModel: upstream,
  }
}

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
  if (info === undefined) {
    const live = liveModelParts(id)
    if (live !== undefined) return {
      id,
      provider: live.provider,
      name: humanizedModelName(live.upstream),
      efforts: [],
      shownByDefault: true,
      upstreamModel: live.upstream,
    }
    throw new Error(`unknown model ${id}`)
  }
  return info
}

/**
 * `id` as an `AgentModel` when the catalog offers it, else undefined. Use it wherever an untrusted string becomes a
 * model id, so a client never turns an unsupported route into the bare `Error` from `modelInfo`.
 */
export const parseAgentModel = (id: string): AgentModel | undefined =>
  Schema.is(AgentModel)(id) ? id as AgentModel : undefined

/** The harness a model runs in: the route's explicit choice, else its provider's current harness. */
export const modelHarness = (id: AgentModel): ModelHarness => {
  const info = modelInfo(id)
  return info.harness ?? DEFAULT_MODEL_HARNESS[info.provider]
}

/** The model id to send to the routed harness's native API, never the protocol's route id. */
export const modelUpstreamId = (id: AgentModel): string => {
  const info = modelInfo(id)
  // Devin's third-party models carry a protocol-only `devin/` prefix; its ACP `model` option takes the family id.
  // Runtime ids store the CLI's own value, so the strip must happen before an `upstreamModel` is returned as-is.
  if (info.provider === "devin") {
    return (info.upstreamModel ?? id.replace(/@(?:claude|codex|opencode)$/, "")).replace(/^devin\//, "")
  }
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
export const shownModels = (
  provider: ModelProvider,
  chosen: ReadonlyArray<AgentModel> | null,
  catalog: readonly ModelInfo[] = AGENT_MODELS,
): readonly ModelInfo[] => {
  const chosenBase = chosen === null ? null : new Set(chosen.map(baseModelId))
  const bases = new Map(catalog.map((model) => [model.id, model]))
  return catalog.filter((m) => {
    if (m.provider !== provider) return false
    const base = baseModelId(m.id)
    return chosenBase === null ? (bases.get(base) ?? modelInfo(base)).shownByDefault : chosenBase.has(base)
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
