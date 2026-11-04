import { Effect } from "effect"
import {
  CliProvider,
  InternalError,
  type CLI_SIGN_IN,
  type CliAuthStatus,
  type CliSignIn,
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
import { probeClaudeUsage, probeCodexUsage, probeOpenCodeGoUsage, useCodexBankedReset } from "./provider-usage"

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

/** The CLI's own sign-in, which the user finishes on the provider's page. */
interface PageSignIn {
  readonly kind: "page"
  /** Starts the sign-in; `dir` is the user's login directory (also `configEnv` in the CLI's environment). */
  readonly args: (dir: string) => ReadonlyArray<string>
  /** The sign-in link (and device code, when the CLI uses one) in its output with ANSI codes removed; null until printed. */
  readonly parseLoginLink: (text: string) => { readonly url: string; readonly userCode: string | null } | null
  /** Sign-in ends with a code the user pastes back; otherwise it ends on the provider's page (a device code). */
  readonly needsCode: boolean
}

/** A sign-in with the user's API key, which the CLI stores itself. */
interface KeySignIn {
  readonly kind: "key"
  /** Stores the key, which it reads from stdin; the CLI's `logout` first removes the one it holds. */
  readonly args: ReadonlyArray<string>
  /** What to write to the CLI's stdin for `key`. */
  readonly stdin: (key: string) => string
}

/**
 * Everything the box knows about one agent CLI with a login Kestrel manages: where its login and sessions live, how a
 * user signs in to it, and how to ask it for commands and limits. A CLI with a login is a new `CliProvider` with an
 * entry in `AGENT_CLIS` and in `CLI_SIGN_IN`, which picks its kind of sign-in; the record type makes every field required.
 */
export interface AgentCli<K extends CliSignIn = CliSignIn> {
  readonly bin: string
  /** Directory under the user's root that holds their login: the CLI's config home while they are signed in. */
  readonly dir: string
  /** Env var naming the CLI's config home, which holds its login and its sessions. */
  readonly configEnv: string
  /** The broker env the CLI reads for its model calls; a user's own login replaces it. */
  readonly brokerEnv: ReadonlyArray<string>
  /**
   * Whether the user is signed in: what the CLI's status command prints, or, for a CLI without one, whether its token
   * file exists (a path under the login directory).
   */
  readonly status:
    | { readonly kind: "command"; readonly args: ReadonlyArray<string>; readonly parse: (out: CliOutput) => Effect.Effect<CliAuthStatus, InternalError> }
    | { readonly kind: "file"; readonly path: string }
  readonly signIn: K extends "page" ? PageSignIn : KeySignIn
  /** Revokes the login before its directory is removed; null when removing the directory is the whole sign-out. */
  readonly logout: ReadonlyArray<string> | null
  /** The CLI's machine interface for command discovery and limits; null when Kestrel asks it for neither. */
  readonly probe: {
    /** Starts the interface that command discovery and the usage probe talk to. */
    readonly args: ReadonlyArray<string>
    readonly discoverCommands: (launch: DiscoveryLaunch) => Promise<ReadonlyArray<HarnessCommand>>
    readonly probeUsage: (launch: DiscoveryLaunch) => Promise<ProviderUsage>
    /** Spends a banked usage reset; null when the provider has none. */
    readonly useBankedReset: ((launch: DiscoveryLaunch, resetId: string) => Promise<UseBankedResetResult>) | null
  } | null
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

/** OpenCode's own id for the Go plan's integration, and for the one credential Kestrel keeps in it. */
const OPENCODE_GO = "opencode-go"
const OPENCODE_GO_CREDENTIAL = "cred_kestrel"

/** `auth list --format json`: the integrations with their connections; Go is signed in while it has one. */
const parseOpenCodeGoStatus = (out: CliOutput): Effect.Effect<CliAuthStatus, InternalError> =>
  Effect.gen(function* () {
    let parsed: unknown
    try {
      parsed = JSON.parse(out.stdout)
    } catch {
      const detail = out.stderr.trim().split("\n")[0]?.slice(0, 200) || "no output"
      return yield* Effect.fail(new InternalError({ message: `opencode auth list: unreadable output (${detail})` }))
    }
    if (!Array.isArray(parsed)) return yield* Effect.fail(new InternalError({ message: "opencode auth list: unexpected output" }))
    const go: unknown = parsed.find((entry) => typeof entry === "object" && entry !== null && entry.id === OPENCODE_GO)
    const connections = typeof go === "object" && go !== null && "connections" in go ? go.connections : null
    return { provider: "opencode-go", loggedIn: Array.isArray(connections) && connections.length > 0, account: null }
  })

export const AGENT_CLIS: { readonly [P in CliProvider]: AgentCli<(typeof CLI_SIGN_IN)[P]> } = {
  "claude-cli": {
    bin: "claude",
    dir: "claude",
    configEnv: "CLAUDE_CONFIG_DIR",
    brokerEnv: ["ANTHROPIC_API_KEY", "ANTHROPIC_BASE_URL"],
    status: { kind: "command", args: ["auth", "status", "--json"], parse: parseClaudeStatus },
    signIn: {
      kind: "page",
      args: () => ["auth", "login"],
      parseLoginLink: (text) => {
        // The line ends with the link, so a half-written link is not taken.
        const url = /https:\/\/[^\s]*claude\.(?:com|ai)\/[^\s]*(?=\r?\n)/.exec(text)?.[0]
        return url === undefined ? null : { url, userCode: null }
      },
      needsCode: true,
    },
    logout: ["auth", "logout"],
    probe: { args: CLAUDE_DISCOVERY_ARGS, discoverCommands: discoverClaudeCommands, probeUsage: probeClaudeUsage, useBankedReset: null },
  },
  "codex-cli": {
    bin: "codex",
    dir: "codex",
    configEnv: "CODEX_HOME",
    brokerEnv: ["OPENAI_API_KEY", "OPENAI_BASE_URL"],
    status: { kind: "command", args: ["login", "status"], parse: parseCodexStatus },
    signIn: {
      kind: "page",
      args: () => ["login", "--device-auth"],
      parseLoginLink: (text) => {
        const lines = text.split(/\r?\n/).map((line) => line.trim())
        const url = lines.map((line) => /^https:\/\/auth\.openai\.com\/\S*$/.exec(line)?.[0]).find((u) => u !== undefined)
        const at = lines.findIndex((line) => /one-time code/i.test(line))
        const userCode = at < 0 ? undefined : lines.slice(at + 1).find((line) => line !== "")
        if (url === undefined || userCode === undefined || !/^[A-Z0-9]+(?:-[A-Z0-9]+)+$/.test(userCode)) return null
        return { url, userCode }
      },
      needsCode: false,
    },
    logout: ["logout"],
    probe: { args: CODEX_DISCOVERY_ARGS, discoverCommands: discoverCodexCommands, probeUsage: probeCodexUsage, useBankedReset: useCodexBankedReset },
  },
  // Antigravity CLI keeps everything (its sign-in token, sessions, settings) under the directory `--gemini-dir`
  // names; `AGY_GEMINI_DIR` is Kestrel's own variable for it, which the run command passes on. It has no status or
  // sign-out command: a signed-in directory holds its token file, and removing the directory signs it out.
  "antigravity-cli": {
    bin: "agy",
    dir: "antigravity",
    configEnv: "AGY_GEMINI_DIR",
    brokerEnv: [],
    status: { kind: "file", path: "antigravity-cli/antigravity-oauth-token" },
    signIn: {
      kind: "page",
      // `acp --login` signs in and exits: it prints a Google link whose page shows a code, and takes the code (or that
      // page's URL) on stdin.
      args: (dir) => ["acp", "--login", "--gemini-dir", dir, "--disable-telemetry"],
      parseLoginLink: (text) => {
        // The line ends with the link, so a half-written link is not taken.
        const url = /^\s*(https:\/\/accounts\.google\.com\/\S+)[ \t]*\r?\n/m.exec(text)?.[1]
        return url === undefined ? null : { url, userCode: null }
      },
      needsCode: true,
    },
    logout: null,
    // Its commands and limits only show inside an ACP session.
    probe: null,
  },
  // OpenCode 2 keeps its credentials and its sessions in one database under `$XDG_DATA_HOME/opencode`; the user's Go
  // key goes in as one credential Kestrel names, which `auth import` (reading stdin, so the key is on no command line)
  // adds and `auth logout` removes. `--standalone` keeps each command off OpenCode's background service.
  "opencode-go": {
    bin: "opencode",
    dir: "opencode-go",
    configEnv: "XDG_DATA_HOME",
    brokerEnv: [],
    status: { kind: "command", args: ["auth", "list", "--format", "json", "--standalone"], parse: parseOpenCodeGoStatus },
    signIn: {
      kind: "key",
      args: ["auth", "import", "--standalone"],
      stdin: (key) =>
        JSON.stringify([
          { id: OPENCODE_GO_CREDENTIAL, integrationID: OPENCODE_GO, label: "OpenCode Go", active: true, value: { type: "key", key } },
        ]),
    },
    logout: ["auth", "logout", OPENCODE_GO, OPENCODE_GO_CREDENTIAL, "--standalone"],
    // OpenCode's commands do nothing over ACP; the limits come from the Go plan's usage endpoint, with the key
    // `auth export` prints.
    probe: { args: ["auth", "export", "--standalone"], discoverCommands: async () => [], probeUsage: probeOpenCodeGoUsage, useBankedReset: null },
  },
}

/** Every agent CLI, in a fixed order. */
export const CLI_PROVIDERS: ReadonlyArray<CliProvider> = CliProvider.literals

/**
 * How each model provider's runs work: the conversation the harness holds with its CLI, and the CLI whose login can
 * stand in for the broker, which also discovers the commands a thread can run. OpenCode offers no commands: its
 * `/init` and `/review` do nothing over ACP (2.0.6 answers `end_turn` at once).
 */
export interface Harness {
  readonly conversation: ConversationKind
  readonly cli: CliProvider | null
  /** The executable the default command runs; the box offers the provider only where it finds it (`capabilities.ts`). */
  readonly bin: string
  /** The oldest `[major, minor]` version (`<bin> --version`) the harness works with; null when any will do. */
  readonly minVersion: readonly [number, number] | null
  /**
   * The ACP method that reopens a recorded session, when the adapter does not implement `session/resume`. Pi's
   * `pi-acp` implements only `session/new` and `session/load` (`loadSession: true`, no `resumeSession`).
   */
  readonly acpResume?: "session/load"
  /** Executables the harness's own binary starts from PATH; a run needs them as much as the binary itself. */
  readonly requires?: readonly string[]
  /**
   * Whether a run gets the broker's keys. A vendor CLI or a standalone ACP harness (OMP, Pi, Hermes) reaches models
   * through the broker like a vendor CLI; OpenCode (free or Go) and Antigravity run their own provider's models, so
   * the broker's keys would only offer them models they are not there for.
   */
  readonly broker: boolean
}

export const MODEL_HARNESS: Record<ModelProvider, Harness> = {
  anthropic: { conversation: "claude", cli: "claude-cli", bin: "claude", minVersion: null, broker: true },
  openai: { conversation: "codex", cli: "codex-cli", bin: "codex", minVersion: null, broker: true },
  // Anthropic-compatible gateways run through Claude Code.
  openrouter: { conversation: "claude", cli: "claude-cli", bin: "claude", minVersion: null, broker: true },
  zai: { conversation: "claude", cli: "claude-cli", bin: "claude", minVersion: null, broker: true },
  deepseek: { conversation: "claude", cli: "claude-cli", bin: "claude", minVersion: null, broker: true },
  minimax: { conversation: "claude", cli: "claude-cli", bin: "claude", minVersion: null, broker: true },
  moonshot: { conversation: "claude", cli: "claude-cli", bin: "claude", minVersion: null, broker: true },
  deepinfra: { conversation: "claude", cli: "claude-cli", bin: "claude", minVersion: null, broker: true },
  // The ACP driver is built against OpenCode 2 (`session/resume`, session config options); OpenCode 1 is its own line.
  opencode: { conversation: "acp", cli: null, bin: "opencode", minVersion: [2, 0], broker: false },
  // The Go plan's sign-in is a key in OpenCode's credential store, which `auth import` fills from 2.1.
  "opencode-go": { conversation: "acp", cli: "opencode-go", bin: "opencode", minVersion: [2, 1], broker: false },
  // Sign-in from a terminal (`acp --login`) and `session/resume` arrived in 1.5.
  google: { conversation: "acp", cli: "antigravity-cli", bin: "agy", minVersion: [1, 5], broker: false },
  // Standalone ACP harnesses speak ACP themselves and reach models through the broker's harness channel (`core/harness.ts`).
  omp: { conversation: "acp", cli: null, bin: "omp", minVersion: null, broker: true },
  pi: { conversation: "acp", cli: null, bin: "pi-acp", minVersion: null, acpResume: "session/load", requires: ["pi"], broker: true },
  hermes: { conversation: "acp", cli: null, bin: "hermes", minVersion: null, broker: true },
}
