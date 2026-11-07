import { type HarnessCommand } from "@cloudagents/protocol"
import type { ModelMentionHarness } from "./models"

/** App actions run on selection or submission; harness commands only complete the draft on selection. */
export const APP_COMMANDS = [
  { name: "usage", description: "Show your usage limits and activity", prefix: "/" },
] as const satisfies readonly HarnessCommand[]

export type AppCommand = (typeof APP_COMMANDS)[number]
/** Adding an app action requires an implementation on every composer host. */
export type AppCommandHandlers = Record<AppCommand["name"], () => void>

/**
 * How a command is typed under its actual harness. A catalog route can run a provider's models in another harness, so
 * the harness — not the credential provider — decides an unprefixed command's invocation.
 */
export const commandPrefixForHarness = (
  command: HarnessCommand,
  harness: ModelMentionHarness | undefined,
): "/" | "$" => command.prefix ?? (harness === "codex" ? "$" : "/")

export function appCommandOfHarness(
  command: HarnessCommand,
  harness: ModelMentionHarness | undefined,
): AppCommand | undefined {
  if (commandPrefixForHarness(command, harness) !== "/") return undefined
  const name = command.name.toLowerCase()
  return APP_COMMANDS.find((candidate) => candidate.name === name)
}

/** App actions are always available and take precedence over same-named slash commands, but not $skills. */
export function withAppCommandsForHarness(
  commands: readonly HarnessCommand[],
  harness: ModelMentionHarness | undefined,
): readonly HarnessCommand[] {
  return [...APP_COMMANDS, ...commands.filter((command) => appCommandOfHarness(command, harness) === undefined)]
}

/** Consume the leading token and gap. A menu selection may complete a prefix, but must still match the live token. */
export function matchAppCommand(text: string, selected?: AppCommand["name"]): { command: AppCommand; consumed: number } | undefined {
  const token = /^\s*\/([^\s]*)(?:\s+|$)/.exec(text)
  if (token === null) return undefined
  const name = token[1]!.toLowerCase()
  const command = APP_COMMANDS.find((candidate) => selected === undefined
    ? candidate.name === name
    : candidate.name === selected && candidate.name.startsWith(name))
  return command === undefined ? undefined : { command, consumed: token[0].length }
}
