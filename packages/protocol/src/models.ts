import { Schema } from "effect"

/**
 * Model families the box runs, each through its own agent CLI: Claude Code for Anthropic, codex for OpenAI, and
 * OpenCode (over the Agent Client Protocol) for OpenCode's own models.
 */
export const ModelProvider = Schema.Literal("anthropic", "openai", "opencode")
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
 * Model id passed to the provider's CLI (`claude --model`, the Codex app-server thread's `model`, OpenCode's ACP
 * `model` config option, which names OpenCode's own provider first).
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
}

const CLAUDE_ALL: readonly AgentEffort[] = ["low", "medium", "high", "xhigh", "max"]
const CLAUDE_NO_XHIGH: readonly AgentEffort[] = ["low", "medium", "high", "max"]
const GPT_FROM_LOW: readonly AgentEffort[] = ["low", "medium", "high", "xhigh", "max"]
const GPT_FROM_NONE: readonly AgentEffort[] = ["none", "low", "medium", "high", "xhigh", "max"]
const OC_LOW_HIGH_MAX: readonly AgentEffort[] = ["low", "high", "max"]
const OC_LOW_TO_MAX: readonly AgentEffort[] = ["low", "medium", "high", "xhigh", "max"]

/**
 * Every model the box can run, in picker order (newest first within a provider). Effort support follows Claude
 * Code's model configuration docs and OpenAI's model pages; OpenCode's are what its ACP `effort` option offers per
 * model. OpenCode's are its free models, which need no sign-in; OpenCode rotates them, so the list follows its own.
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
]

export interface ModelProviderInfo {
  readonly id: ModelProvider
  readonly name: string
  /**
   * `Connection.provider` ids that give the box access to this provider's models: an API key or a CLI login. Empty
   * when the provider needs none: it is always on offer.
   */
  readonly connections: readonly string[]
}

export const MODEL_PROVIDERS: readonly ModelProviderInfo[] = [
  { id: "anthropic", name: "Anthropic", connections: ["anthropic", "claude-cli"] },
  { id: "openai", name: "OpenAI", connections: ["openai", "codex-cli"] },
  { id: "opencode", name: "OpenCode", connections: [] },
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
  connections: ReadonlyArray<{ readonly provider: string; readonly connected: boolean }>,
  harnesses: ReadonlyArray<ModelProvider> | undefined,
): readonly ModelProviderInfo[] =>
  MODEL_PROVIDERS.filter((p) =>
    p.connections.length === 0
      ? harnesses?.includes(p.id) === true
      : connections.some((c) => c.connected && p.connections.includes(c.provider)),
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
