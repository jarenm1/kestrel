import { Schema } from "effect"

/** Model families the box runs, each through its own agent CLI: Claude Code for Anthropic, codex for OpenAI. */
export const ModelProvider = Schema.Literal("anthropic", "openai")
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

/** Model id passed to the provider's CLI (`claude --model`, `codex exec -m`). */
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

/**
 * Every model the box can run, in picker order (newest first within a provider). Effort support follows Claude
 * Code's model configuration docs and OpenAI's model pages.
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
]

export interface ModelProviderInfo {
  readonly id: ModelProvider
  readonly name: string
  /** `Connection.provider` ids that give the box access to this provider's models: an API key or a CLI login. */
  readonly connections: readonly string[]
}

export const MODEL_PROVIDERS: readonly ModelProviderInfo[] = [
  { id: "anthropic", name: "Anthropic", connections: ["anthropic", "claude-cli"] },
  { id: "openai", name: "OpenAI", connections: ["openai", "codex-cli"] },
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

/** Providers with at least one connected connection, in `MODEL_PROVIDERS` order. */
export const connectedModelProviders = (
  connections: ReadonlyArray<{ readonly provider: string; readonly connected: boolean }>,
): readonly ModelProviderInfo[] =>
  MODEL_PROVIDERS.filter((p) => connections.some((c) => c.connected && p.connections.includes(c.provider)))

/**
 * The provider's models in the chat picker, in catalog order. `chosen` is the user's saved list for the provider
 * (from the connections page), or null before they edited it.
 */
export const shownModels = (provider: ModelProvider, chosen: ReadonlyArray<AgentModel> | null): readonly ModelInfo[] =>
  providerModels(provider).filter((m) => (chosen === null ? m.shownByDefault : chosen.includes(m.id)))
