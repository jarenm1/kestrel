import { DEFAULT_MODEL_HARNESS, type ModelInfo, type ModelProvider } from "@cloudagents/protocol";
import { modelHarnessOf, type ModelMentionHarness } from "@cloudagents/composer/models";
import type { HarnessId } from "@cloudagents/ui/harness-logos";

/** An agent CLI the box runs models in, as the model picker's rail and search labels show it. */
export interface Harness {
  readonly id: HarnessId;
  readonly name: string;
}

/** The desktop picker's rail order. */
export const HARNESSES: readonly Harness[] = [
  { id: "claude", name: "Claude Code" },
  { id: "codex", name: "Codex" },
  { id: "opencode", name: "OpenCode" },
  { id: "antigravity", name: "Antigravity" },
];

export const harnessById = (id: ModelMentionHarness): Harness =>
  HARNESSES.find((harness) => harness.id === id)!;

/** The harness a model's catalog route actually runs, not its credential provider's default. */
export const harnessForModel = (model: ModelInfo): Harness => harnessById(modelHarnessOf(model).harness);

/**
 * The harness a provider ran before catalog routes existed. Only for runs recorded without a model (or route); every
 * current pick reads the model's actual harness through `harnessForModel`.
 */
export const harnessForProvider = (provider: ModelProvider): Harness =>
  harnessById(DEFAULT_MODEL_HARNESS[provider]);
