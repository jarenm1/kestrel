import type { ModelProvider } from "@cloudagents/protocol"
import { modelHarnessOf } from "@cloudagents/composer/models"
import claudeLogo from "@/assets/claude.svg"
import openaiLogo from "@/assets/openai.svg"
import antigravityLogo from "@/assets/antigravity.svg"
import opencodeLogo from "@/assets/opencode.svg"

export type HarnessId = "claude" | "codex" | "opencode" | "antigravity"

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
]


export const harnessOf = (provider: ModelProvider): Harness =>
  HARNESSES.find((harness) => harness.id === modelHarnessOf(provider).harness)!
