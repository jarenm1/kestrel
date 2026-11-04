import { Schema } from "effect"

/**
 * Anthropic and the third-party gateways run through Claude Code, OpenAI through codex, and OpenCode (its free models
 * and its Go plan) and Antigravity CLI run their own providers' models over the Agent Client Protocol.
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
 * Model id passed to the provider's CLI (`claude --model`, the Codex app-server thread's `model`, the ACP `model`
 * config option of OpenCode, which names OpenCode's own provider first (`opencode` free, `opencode-go` Go), and of
 * Antigravity CLI).
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
  "MiniMax-M3.1-Flash[1m]",
  "kimi-k3.1-pro",
  "kimi-k3[1m]",
  "kimi-k2.7-code",
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
  "gemini-3.8-flash",
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
  /** Provider-advertised context window for Claude Code's auto-compaction. */
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
 * them, so the list follows its own. OpenCode Go's are the Go plan's models that no other provider here runs (its
 * Claude, GPT and Gemini models are left to theirs), and none of its free or contributor ones.
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
  { id: "MiniMax-M3.1-Flash[1m]", provider: "minimax", name: "MiniMax M3.1 Flash", efforts: CLAUDE_ALL, shownByDefault: true, compactWindow: 524_288 },
  { id: "kimi-k3.1-pro", provider: "moonshot", name: "Kimi K3.1 Pro", efforts: CLAUDE_NO_XHIGH, shownByDefault: true },
  { id: "kimi-k3[1m]", provider: "moonshot", name: "Kimi K3", efforts: CLAUDE_NO_XHIGH, shownByDefault: false, compactWindow: 1_000_000 },
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
]

export interface ModelProviderInfo {
  readonly id: ModelProvider
  readonly name: string
  /**
   * `Connection.provider` ids that give the box access to this provider's models: an API key or a CLI login. Empty
   * when the provider needs none: the box must report its harness in `BoxCapabilities.harnesses` instead.
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
  // OpenCode's free models need no connection: its own CLI runs them, so the box has to have it (OpenCode 2).
  { id: "opencode", name: "OpenCode", connections: [] },
  // OpenCode Go runs on the same OpenCode CLI (2.1), but needs the Go plan's key.
  { id: "opencode-go", name: "OpenCode Go", connections: ["opencode-go"] },
  { id: "google", name: "Google", connections: ["antigravity-cli"] },
]

/** The provider a message without a model runs on: the box's default harness. */
export const DEFAULT_MODEL_PROVIDER: ModelProvider = "anthropic"

export const modelInfo = (id: AgentModel): ModelInfo => {
  const info = AGENT_MODELS.find((m) => m.id === id)
  if (info === undefined) throw new Error(`model ${id} is missing from AGENT_MODELS`)
  return info
}

export const providerModels = (provider: ModelProvider): readonly ModelInfo[] =>
  AGENT_MODELS.filter((m) => m.provider === provider)

/**
 * Providers on offer, in `MODEL_PROVIDERS` order: those with a connected connection, and those needing none whose
 * harness the box has (`BoxCapabilities.harnesses`; a box that does not report it, or has not answered yet, offers
 * none of them).
 */
export const connectedModelProviders = (
  connections: ReadonlyArray<{ readonly provider: string; readonly connected: boolean; readonly available?: boolean }>,
  harnesses: ReadonlyArray<ModelProvider> | undefined,
): readonly ModelProviderInfo[] =>
  MODEL_PROVIDERS.filter((p) =>
    p.connections.length === 0
      ? harnesses?.includes(p.id) === true
      : connections.some((c) => c.connected && c.available !== false && p.connections.includes(c.provider)),
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
