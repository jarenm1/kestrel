import { modelHarnessOf } from "@cloudagents/composer/models";
import type { ModelProvider } from "@cloudagents/protocol";
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

export const harnessOf = (provider: ModelProvider): Harness =>
  HARNESSES.find((harness) => harness.id === modelHarnessOf(provider).harness)!;
