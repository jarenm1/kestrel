import { DEFAULT_MODEL_HARNESS, type ModelInfo, type ModelProvider } from "@cloudagents/protocol"
import { modelHarnessOf, type ModelMentionHarness } from "@cloudagents/composer/models"
import claudeLogo from "@/assets/claude.svg"
import openaiLogo from "@/assets/openai.svg"
import antigravityLogo from "@/assets/antigravity.svg"
import opencodeLogo from "@/assets/opencode.svg"
import devinLogo from "@/assets/devin.svg"

export type HarnessId = "claude" | "codex" | "opencode" | "antigravity" | "devin"

/** An agent CLI the box runs models in, with the logo the connections page and the model picker show for it. */
export interface Harness {
  readonly id: HarnessId
  readonly name: string
  readonly logo: string
  /** Drawn in the text color through a mask rather than as the image's own colors. */
  readonly monochrome: boolean
  /** The `Connection.provider` of the harness's own row on the connections page. */
  readonly connection: string
}

/** In the model picker's order. */
export const HARNESSES: readonly Harness[] = [
  { id: "claude", name: "Claude Code", logo: claudeLogo, monochrome: false, connection: "claude-cli" },
  { id: "codex", name: "Codex", logo: openaiLogo, monochrome: true, connection: "codex-cli" },
  { id: "opencode", name: "OpenCode", logo: opencodeLogo, monochrome: true, connection: "opencode" },
  { id: "antigravity", name: "Antigravity", logo: antigravityLogo, monochrome: false, connection: "antigravity-cli" },
  { id: "devin", name: "Devin", logo: devinLogo, monochrome: true, connection: "devin-cli" },
]

export const harnessById = (id: ModelMentionHarness): Harness =>
  HARNESSES.find((harness) => harness.id === id)!

/** The harness a model's catalog route actually runs, not its credential provider's default. */
export const harnessForModel = (model: ModelInfo): Harness => harnessById(modelHarnessOf(model).harness)

/**
 * The harness a provider ran before catalog routes existed. Only for runs recorded without a model (or route); every
 * current pick reads the model's actual harness through `harnessForModel`.
 */
export const harnessForProvider = (provider: ModelProvider): Harness =>
  harnessById(DEFAULT_MODEL_HARNESS[provider])
