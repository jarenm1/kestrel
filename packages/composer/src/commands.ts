import { harnessCommandPrefix, type HarnessCommand, type ModelProvider } from "@cloudagents/protocol"

/** App actions run on selection or submission; harness commands only complete the draft on selection. */
export const APP_COMMANDS = [
  { name: "usage", description: "Show your usage limits and activity", prefix: "/" },
] as const satisfies readonly HarnessCommand[]

export type AppCommand = (typeof APP_COMMANDS)[number]
/** Adding an app action requires an implementation on every composer host. */
export type AppCommandHandlers = Record<AppCommand["name"], () => void>

/** Resolve by invocation, not object identity: a harness's /usage is the same app-owned action. */
export function appCommandOf(command: HarnessCommand, provider: ModelProvider | undefined): AppCommand | undefined {
  if (harnessCommandPrefix(command, provider) !== "/") return undefined
  const name = command.name.toLowerCase()
  return APP_COMMANDS.find((candidate) => candidate.name === name)
}

/** App actions are always available and take precedence over same-named slash commands, but not $skills. */
export function withAppCommands(commands: readonly HarnessCommand[], provider: ModelProvider | undefined): readonly HarnessCommand[] {
  return [...APP_COMMANDS, ...commands.filter((command) => appCommandOf(command, provider) === undefined)]
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
