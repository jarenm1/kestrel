import { Effect } from "effect"
import {
  CliProvider,
  InternalError,
  type CliAuthStatus,
  type HarnessCommand,
  type ModelProvider,
  type ProviderUsage,
  type UseBankedResetResult,
} from "@cloudagents/protocol"
import {
  CLAUDE_DISCOVERY_ARGS,
  CODEX_DISCOVERY_ARGS,
  discoverClaudeCommands,
  discoverCodexCommands,
  type DiscoveryLaunch,
} from "./harness-commands"
import { probeClaudeUsage, probeCodexUsage, useCodexBankedReset } from "./provider-usage"

/**
 * How the harness holds a run's conversation with its CLI over stdin (`RunConversation` in `core/harness.ts`): Claude
 * Code's stream-json, Codex app-server, or the Agent Client Protocol (`core/acp.ts`).
 */
export type ConversationKind = "claude" | "codex" | "acp"

/** What a CLI printed: both streams, since CLIs differ in where they report. */
export interface CliOutput {
  readonly stdout: string
  readonly stderr: string
}

/**
 * Everything the box knows about one agent CLI with a login Kestrel manages: where its login and sessions live, how a
 * user signs in to it, and how to ask it for commands and limits. A CLI with a login is a new `CliProvider` with an
 * entry in `AGENT_CLIS`; the record type makes every field required.
 */
export interface AgentCli {
  readonly bin: string
  /** Directory under the user's root that holds their login: the CLI's config home while they are signed in. */
  readonly dir: string
  /** Env var naming the CLI's config home, which holds its login and its sessions. */
  readonly configEnv: string
  /** The broker env the CLI reads for its model calls; a user's own login replaces it. */
  readonly brokerEnv: ReadonlyArray<string>
  readonly status: ReadonlyArray<string>
  readonly parseStatus: (out: CliOutput) => Effect.Effect<CliAuthStatus, InternalError>
  readonly login: ReadonlyArray<string>
  readonly logout: ReadonlyArray<string>
  /** The sign-in link (and device code, when the CLI uses one) in its output with ANSI codes removed; null until printed. */
  readonly parseLoginLink: (text: string) => { readonly url: string; readonly userCode: string | null } | null
  /** Sign-in ends with a code the user pastes back; otherwise it ends on the provider's page (a device code). */
  readonly needsCode: boolean
  /** Starts the CLI's machine interface, which command discovery and the usage probe talk to. */
  readonly probeArgs: ReadonlyArray<string>
  readonly discoverCommands: (launch: DiscoveryLaunch) => Promise<ReadonlyArray<HarnessCommand>>
  readonly probeUsage: (launch: DiscoveryLaunch) => Promise<ProviderUsage>
  /** Spends a banked usage reset; null when the provider has none. */
  readonly useBankedReset: ((launch: DiscoveryLaunch, resetId: string) => Promise<UseBankedResetResult>) | null
}

const parseClaudeStatus = (out: CliOutput): Effect.Effect<CliAuthStatus, InternalError> =>
  Effect.gen(function* () {
    let parsed: unknown
    try {
      parsed = JSON.parse(out.stdout)
    } catch {
      const detail = out.stderr.trim().split("\n")[0]?.slice(0, 200) || "no output"
      return yield* Effect.fail(new InternalError({ message: `claude auth status: unreadable output (${detail})` }))
    }
    if (typeof parsed !== "object" || parsed === null || !("loggedIn" in parsed) || typeof parsed.loggedIn !== "boolean") {
      return yield* Effect.fail(new InternalError({ message: "claude auth status: unexpected output" }))
    }
    const field = (name: string): string | null => {
      const value = (parsed as Record<string, unknown>)[name]
      return typeof value === "string" && value !== "" ? value : null
    }
    // claude.ai logins carry email/orgName; API-key logins only an auth method.
    const account = parsed.loggedIn ? (field("email") ?? field("orgName") ?? field("authMethod")) : null
    return { provider: "claude-cli", loggedIn: parsed.loggedIn, account }
  })

const parseCodexStatus = (out: CliOutput): Effect.Effect<CliAuthStatus, InternalError> =>
  Effect.gen(function* () {
    const text = `${out.stdout}\n${out.stderr}`
    if (/^Not logged in/m.test(text)) return { provider: "codex-cli", loggedIn: false, account: null }
    // e.g. "Logged in using ChatGPT", "Logged in using an API key - sk-…": the part after " - " is
    // a key fragment and is dropped.
    const match = /^Logged in using (?:an? )?(.+?)(?: - .*)?$/m.exec(text)
    if (!match) return yield* Effect.fail(new InternalError({ message: "codex login status: unexpected output" }))
    return { provider: "codex-cli", loggedIn: true, account: match[1] ?? null }
  })

export const AGENT_CLIS: Record<CliProvider, AgentCli> = {
  "claude-cli": {
    bin: "claude",
    dir: "claude",
    configEnv: "CLAUDE_CONFIG_DIR",
    brokerEnv: ["ANTHROPIC_API_KEY", "ANTHROPIC_BASE_URL"],
    status: ["auth", "status", "--json"],
    parseStatus: parseClaudeStatus,
    login: ["auth", "login"],
    logout: ["auth", "logout"],
    parseLoginLink: (text) => {
      // The line ends with the link, so a half-written link is not taken.
      const url = /https:\/\/[^\s]*claude\.(?:com|ai)\/[^\s]*(?=\r?\n)/.exec(text)?.[0]
      return url === undefined ? null : { url, userCode: null }
    },
    needsCode: true,
    probeArgs: CLAUDE_DISCOVERY_ARGS,
    discoverCommands: discoverClaudeCommands,
    probeUsage: probeClaudeUsage,
    useBankedReset: null,
  },
  "codex-cli": {
    bin: "codex",
    dir: "codex",
    configEnv: "CODEX_HOME",
    brokerEnv: ["OPENAI_API_KEY", "OPENAI_BASE_URL"],
    status: ["login", "status"],
    parseStatus: parseCodexStatus,
    login: ["login", "--device-auth"],
    logout: ["logout"],
    parseLoginLink: (text) => {
      const lines = text.split(/\r?\n/).map((line) => line.trim())
      const url = lines.map((line) => /^https:\/\/auth\.openai\.com\/\S*$/.exec(line)?.[0]).find((u) => u !== undefined)
      const at = lines.findIndex((line) => /one-time code/i.test(line))
      const userCode = at < 0 ? undefined : lines.slice(at + 1).find((line) => line !== "")
      if (url === undefined || userCode === undefined || !/^[A-Z0-9]+(?:-[A-Z0-9]+)+$/.test(userCode)) return null
      return { url, userCode }
    },
    needsCode: false,
    probeArgs: CODEX_DISCOVERY_ARGS,
    discoverCommands: discoverCodexCommands,
    probeUsage: probeCodexUsage,
    useBankedReset: useCodexBankedReset,
  },
}

/** Every agent CLI, in a fixed order. */
export const CLI_PROVIDERS: ReadonlyArray<CliProvider> = CliProvider.literals

/**
 * How each model provider's runs work: the conversation the harness holds with its CLI, and the CLI whose login can
 * stand in for the broker, which also discovers the commands a thread can run. A harness without a login Kestrel
 * manages offers no commands: OpenCode's `/init` and `/review` do nothing over ACP (2.0.6 answers `end_turn` at once).
 */
export interface Harness {
  readonly conversation: ConversationKind
  readonly cli: CliProvider | null
  /** The executable the default command runs; the box offers the provider only where it finds it (`capabilities.ts`). */
  readonly bin: string
  /** The oldest major version (`<bin> --version`) the harness works with; null when any will do. */
  readonly minMajor: number | null
}

export const MODEL_HARNESS: Record<ModelProvider, Harness> = {
  anthropic: { conversation: "claude", cli: "claude-cli", bin: "claude", minMajor: null },
  openai: { conversation: "codex", cli: "codex-cli", bin: "codex", minMajor: null },
  // The ACP driver is built against OpenCode 2 (`session/resume`, session config options); OpenCode 1 is its own line.
  opencode: { conversation: "acp", cli: null, bin: "opencode", minMajor: 2 },
}
