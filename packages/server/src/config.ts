import { Context, Layer, Schema } from "effect"
import { join, resolve } from "node:path"
import { availableParallelism } from "node:os"
import { DesktopRtcIceServer, NEST_BOX_ENV, type ModelProvider } from "@cloudagents/protocol"
import pkg from "../package.json"
import type { WebRtcSettings } from "./desktop/webrtc"
import type { SandboxLevel } from "./sandbox"
import { defaultMemoryHigh, type Provisioning, type SystemdSettings } from "./sandbox/systemd"
import { parseSize } from "./size"
import { readStoredSecret } from "./platform/secret"

export const VERSION: string = pkg.version

const shellQuote = (s: string): string => `'${s.replace(/'/g, `'\\''`)}'`

/**
 * Left to themselves, agents batch a multi-file change into a throwaway script, usually Python, which the strict
 * sandbox doesn't have, so the run fails once and redoes it in Bun. The Codex counterpart is in `core/codex-app-server.ts`.
 */
const CLAUDE_INSTRUCTIONS =
  "Change existing files with the Edit tool and create files with the Write tool, also when a change repeats across many places or files: send several Edit calls in one response rather than batching them in a script. Do not change files through python, bun -e, node -e, sed -i, perl -i or a shell heredoc. Python may not be installed here."

/**
 * The prompt goes in on stdin (`--input-format stream-json`), so the harness can add messages to a running turn and
 * interrupt it (`core/claude-stream.ts`). `--include-partial-messages` streams text and thinking as `stream_event`
 * deltas next to the finished blocks.
 */
export const DEFAULT_ANTHROPIC_COMMAND = `claude -p --input-format stream-json \${CLOUDAGENTS_RESUME_SESSION:+--resume "$CLOUDAGENTS_RESUME_SESSION"} --mcp-config "$CLOUDAGENTS_MCP_CONFIG" --dangerously-skip-permissions --append-system-prompt ${shellQuote(CLAUDE_INSTRUCTIONS)} --output-format stream-json --verbose --include-partial-messages \${CLOUDAGENTS_MODEL:+--model "$CLOUDAGENTS_MODEL"} \${CLOUDAGENTS_EFFORT:+--effort "$CLOUDAGENTS_EFFORT"}`

/**
 * Codex runs as app-server on stdio; the harness opens the thread and its turn over JSON-RPC
 * (`core/codex-app-server.ts`), with Codex's own sandbox and approvals off. Codex reads `openai_base_url` from
 * config, not from `OPENAI_BASE_URL`, so the broker URL is passed through explicitly; its base includes `/v1`
 * because codex appends `/responses`. `tool_timeout_sec` is ~2^31 ms in seconds, so a `task_ask` waits as long as
 * the user takes.
 */
const DEFAULT_OPENAI_COMMAND =
  'codex app-server ${OPENAI_BASE_URL:+-c openai_base_url="$OPENAI_BASE_URL"} -c mcp_servers.cloudagents.url="$CLOUDAGENTS_MCP_URL" -c mcp_servers.cloudagents.bearer_token_env_var="CLOUDAGENTS_MCP_TOKEN" -c mcp_servers.cloudagents.tool_timeout_sec=2147483.647'

/**
 * OpenCode runs as an Agent Client Protocol server on stdio (`core/acp.ts`); the harness hands it the thread's MCP
 * server with the session. Its config keeps sessions unshared and the binary as installed, and lets an MCP call run
 * ~2^31 ms, so a `task_ask` waits as long as the user takes. The Go plan is OpenCode's own provider, reached through
 * the same binary and the same command.
 */
const DEFAULT_OPENCODE_COMMAND = `OPENCODE_CONFIG_CONTENT=${shellQuote(
  JSON.stringify({ share: "disabled", update: "disable", mcp: { timeout: { execution: 2 ** 31 - 1 } } }),
)} opencode acp`

/**
 * Antigravity CLI runs as an ACP server on stdio too. It keeps its sign-in and sessions under `--gemini-dir`: the
 * user's login directory when they are signed in (`AGY_GEMINI_DIR`, see `AGENT_CLIS`), which a Google run needs, since
 * its models are reached only through that sign-in. Kestrel's sandbox is the boundary, so it asks for no permissions.
 */
const DEFAULT_GOOGLE_COMMAND =
  'agy acp --gemini-dir "${AGY_GEMINI_DIR:-$HOME/.gemini}" --dangerously-skip-permissions --disable-telemetry'

export interface ServerConfig {
  readonly port: number
  readonly host: string
  /** Loopback-only listener for MCP and the credential broker. */
  readonly sandboxPort: number
  /** Base URL the agent harness uses to reach this server's MCP endpoint. */
  readonly mcpBaseUrl: string
  readonly dataDir: string
  /** Bare mirrors of repositories, one per user per repository; host-only writes, read-only in sandboxes. */
  readonly mirrorsDir: string
  /** Per-thread workspaces, with one checkout directory per repository; the agent starts in the first checkout. */
  readonly threadsDir: string
  /** Host-only shadow git dirs, one per checkout; all host-side git on a checkout runs against these. */
  readonly shadowsDir: string
  readonly runsDir: string
  readonly attachmentsDir: string
  readonly stateFile: string
  /**
   * Shell commands run (via `sh -c`) for each agent run, one per model provider as picked by the message's model,
   * cwd = the thread's first checkout, else its workspace (`agentCwd` in `core/harness.ts`)
   * (`CLOUDAGENTS_ANTHROPIC_COMMAND`, `CLOUDAGENTS_OPENAI_COMMAND`, `CLOUDAGENTS_OPENROUTER_COMMAND`,
   * `CLOUDAGENTS_ZAI_COMMAND`, `CLOUDAGENTS_DEEPSEEK_COMMAND`, `CLOUDAGENTS_MINIMAX_COMMAND`,
   * `CLOUDAGENTS_MOONSHOT_COMMAND`, `CLOUDAGENTS_OPENCODE_COMMAND`, `CLOUDAGENTS_OPENCODE_GO_COMMAND` and
   * `CLOUDAGENTS_GOOGLE_COMMAND` override the defaults).
   * The Anthropic command must read Claude Code's stream-json input on stdin: the harness writes the prompt there as
   * the first user message, adds mid-run messages and sends `interrupt`, and closes stdin after the first `result`.
   * It reads `CLOUDAGENTS_MODEL` / `CLOUDAGENTS_EFFORT` when the message chose them (Claude Code's `--model` /
   * `--effort`), and `CLOUDAGENTS_RESUME_SESSION` when continuing a usable native session of this provider, including
   * after another provider ran. It must resume that session (`claude --resume`) to retain its native context.
   * Prompts travel only on stdin, not through the inherited environment. The OpenAI command must start
   * Codex app-server on stdio: the harness sends it the prompt, model, effort and the thread to resume. An OpenAI run
   * reaches the model through the broker: `OPENAI_BASE_URL` is passed to codex's `openai_base_url`. The OpenCode
   * command (also used for OpenCode Go) must start an ACP server on stdio: the harness opens or resumes the session
   * and sends the prompt, model and effort over it. OpenCode runs its own models and gets no broker keys.
   */
  readonly agentCommands: Record<ModelProvider, string>
  readonly fakeAgent: boolean
  /** Control plane relay (outbound box connection). Null unless `CLOUDAGENTS_BOX_TOKEN` is set. */
  readonly relay: { readonly controlUrl: string; readonly boxToken: string } | null
  /**
   * Direct mode: the box's own control-plane lookups and box-token verification, with apps reaching the box without
   * the relay. Null unless the box has an id and a secret (`CLOUDAGENTS_BOX_SECRET`, or the stored Nest secret). `managed`
   * (`CLOUDAGENTS_BOX_MANAGED=1`) marks a Kestrel fleet box that serves many users; otherwise it is the user's own box.
   */
  readonly direct: {
    readonly controlUrl: string
    readonly boxId: string
    readonly boxSecret: string
    readonly managed: boolean
  } | null
  /**
   * The Nest VM's guest agent socket (`CLOUDAGENTS_GUEST_AGENT_SOCKET`). Null on a plain box. When set the box is a
   * Nest VM: it reports suspend and GPU capability and speaks the guest protocol over this socket.
   */
  readonly nest: { readonly guestSocket: string } | null
  /** Per-task persisted homes; each is bound at /home/agent inside the sandbox. */
  readonly homesDir: string
  /**
   * How agent runs and MCP exec are sandboxed (CLOUDAGENTS_SANDBOX): `strict` (Nix toolchain, own network namespace),
   * `basic` (bubblewrap over the host filesystem and network), or `off` (plain `sh -c`).
   */
  readonly sandbox: SandboxLevel
  /** Toolchain dir (CLOUDAGENTS_SANDBOX_PATH) used as PATH inside the sandbox. */
  readonly sandboxPath: string | null
  /** CA bundle exposed inside the sandbox (CLOUDAGENTS_SANDBOX_SSL). */
  readonly sandboxSslCertFile: string | null
  /** Flake (CLOUDAGENTS_TOOLKITS_FLAKE, set by the flake) whose `toolkit-<name>` packages `toolkit_install` builds; null without Nix. */
  readonly toolkitsFlake: string | null
  /** Extra read-only binds the fake agent needs; empty for real agents. */
  readonly fakeAgentRoBinds: readonly string[]
  /** Per-task systemd resource limits; null when CLOUDAGENTS_SYSTEMD=0. */
  readonly systemd: SystemdSettings | null
  /** Agent runs that execute at once (CLOUDAGENTS_MAX_CONCURRENT_RUNS); 0 = unlimited. Runs past it wait for a slot. */
  readonly maxConcurrentRuns: number
  /**
   * Per-thread storage limit in bytes (CLOUDAGENTS_TASK_DISK_MAX, default 50G): the thread's workspace, home and
   * shadow repos. The box enforces it itself (see `core/storage.ts`); it applies with or without systemd.
   */
  readonly taskDiskMax: number
  /** WebRTC desktop media and its connectivity. Always on. See docs/box.md. */
  readonly webrtc: WebRtcSettings
  /** GitHub REST API base URL (no trailing slash). Defaults to api.github.com; set for GitHub Enterprise or tests. */
  readonly githubApiUrl: string
  /** Owners who explicitly selected GitHub's legacy username-only noreply address. Defaults to none. */
  readonly gitLegacyNoreplyUsers?: readonly string[]
}

export class Config extends Context.Tag("cloudagents/Config")<Config, ServerConfig>() {}

const repoRoot = resolve(import.meta.dir, "../../..")

/** The data dir: `CLOUDAGENTS_DATA_DIR`, else `.data` under the repo. Enrollment reads it before the config loads. */
export const dataDirFromEnv = (): string => resolve(process.env.CLOUDAGENTS_DATA_DIR ?? join(repoRoot, ".data"))

export const loadConfig = (): ServerConfig => {
  const portRaw = process.env.CLOUDAGENTS_PORT ?? "8787"
  const port = Number(portRaw)
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    throw new Error(`CLOUDAGENTS_PORT must be a valid port, got "${portRaw}"`)
  }
  const host = process.env.CLOUDAGENTS_HOST ?? "127.0.0.1"
  const sandboxPort = intEnv("CLOUDAGENTS_SANDBOX_PORT", ((port + 9999) % 65535) + 1, 1, 65535)
  if (sandboxPort === port) throw new Error("CLOUDAGENTS_SANDBOX_PORT must differ from CLOUDAGENTS_PORT")
  const dataDir = dataDirFromEnv()
  const fakeAgent = process.env.CLOUDAGENTS_FAKE_AGENT === "1"
  const fakeCommand = `${shellQuote(process.execPath)} ${shellQuote(join(repoRoot, "packages/server/scripts/fake-agent.ts"))}`
  const agentCommands: Record<ModelProvider, string> = fakeAgent
    ? {
        anthropic: fakeCommand,
        openai: fakeCommand,
        openrouter: "",
        zai: "",
        deepseek: "",
        minimax: "",
        moonshot: "",
        opencode: fakeCommand,
        "opencode-go": fakeCommand,
        google: fakeCommand,
      }
    : {
        anthropic: process.env.CLOUDAGENTS_ANTHROPIC_COMMAND ?? DEFAULT_ANTHROPIC_COMMAND,
        openai: process.env.CLOUDAGENTS_OPENAI_COMMAND ?? DEFAULT_OPENAI_COMMAND,
        openrouter: process.env.CLOUDAGENTS_OPENROUTER_COMMAND ?? DEFAULT_ANTHROPIC_COMMAND,
        zai: process.env.CLOUDAGENTS_ZAI_COMMAND ?? DEFAULT_ANTHROPIC_COMMAND,
        deepseek: process.env.CLOUDAGENTS_DEEPSEEK_COMMAND ?? DEFAULT_ANTHROPIC_COMMAND,
        minimax: process.env.CLOUDAGENTS_MINIMAX_COMMAND ?? DEFAULT_ANTHROPIC_COMMAND,
        moonshot: process.env.CLOUDAGENTS_MOONSHOT_COMMAND ?? DEFAULT_ANTHROPIC_COMMAND,
        // The Go plan runs the same OpenCode CLI; its command is the same ACP server with the Go key imported.
        opencode: process.env.CLOUDAGENTS_OPENCODE_COMMAND ?? DEFAULT_OPENCODE_COMMAND,
        "opencode-go": process.env.CLOUDAGENTS_OPENCODE_GO_COMMAND ?? DEFAULT_OPENCODE_COMMAND,
        google: process.env.CLOUDAGENTS_GOOGLE_COMMAND ?? DEFAULT_GOOGLE_COMMAND,
      }
  const sandboxPath = process.env.CLOUDAGENTS_SANDBOX_PATH?.trim() || null
  const sandbox = sandboxLevel(sandboxPath)
  if (sandbox === "off") console.warn("CLOUDAGENTS_SANDBOX=off: agent runs are NOT sandboxed")
  const sandboxSsl = process.env.CLOUDAGENTS_SANDBOX_SSL?.trim() || null
  const fakeAgentRoBinds = fakeAgent ? [process.execPath, join(repoRoot, "packages/server"), join(repoRoot, "node_modules")] : []
  const systemdEnabled = process.env.CLOUDAGENTS_SYSTEMD !== "0"
  if (!systemdEnabled) console.warn("CLOUDAGENTS_SYSTEMD=0: agent runs have NO resource limits")
  // One slice per box (ports are unique per box on a machine); task slices nest under it. Unset, these keep Kestrel's
  // shared box as it was (per-thread caps, no box totals, no run limit); a user's own box gets the `kestrel-box`
  // CLI's shipped config instead (packages/server/src/cli/config.ts).
  const cores = availableParallelism()
  const taskMemoryMax = limitEnv("CLOUDAGENTS_TASK_MEMORY_MAX", "4G")
  const systemd: SystemdSettings | null = systemdEnabled
    ? {
        boxSlice: `kestrel-box${port}`,
        provisioning: provisioningEnv(),
        limits: {
          memoryMin: limitEnv("CLOUDAGENTS_TASK_MEMORY_MIN", "1G"),
          cpuWeight: intEnv("CLOUDAGENTS_TASK_CPU_WEIGHT", 100, 1, 10_000),
          memoryMax: taskMemoryMax,
          memoryHigh: limitEnv("CLOUDAGENTS_TASK_MEMORY_HIGH", defaultMemoryHigh(taskMemoryMax)),
          swapMax: limitEnv("CLOUDAGENTS_TASK_SWAP_MAX", "0"),
          cpuQuota: limitEnv("CLOUDAGENTS_TASK_CPU_QUOTA", "200%"),
          tasksMax: limitEnv("CLOUDAGENTS_TASK_TASKS_MAX", "1024"),
        },
        box: {
          memoryMax: limitEnv("CLOUDAGENTS_BOX_MEMORY_MAX", "infinity"),
          swapMax: limitEnv("CLOUDAGENTS_BOX_SWAP_MAX", "0"),
          cpuQuota: limitEnv("CLOUDAGENTS_BOX_CPU_QUOTA", `${cores * 100}%`),
        },
      }
    : null
  const controlUrl = loadControlUrl()
  const direct = loadDirect(controlUrl, dataDir)
  const gitLegacyNoreplyUsers = (process.env.CLOUDAGENTS_GIT_LEGACY_NOREPLY_USERS ?? "")
    .split(",").map((login) => login.trim().toLowerCase()).filter((login) => login !== "")
  if (gitLegacyNoreplyUsers.some((login) => !/^[a-z\d](?:[a-z\d-]{0,37}[a-z\d])?$/.test(login))) {
    throw new Error("CLOUDAGENTS_GIT_LEGACY_NOREPLY_USERS must be comma-separated GitHub logins")
  }
  return {
    port,
    host,
    sandboxPort,
    relay: loadRelay(controlUrl, direct),
    direct,
    nest: loadNest(),
    mcpBaseUrl: `http://127.0.0.1:${sandboxPort}`,
    dataDir,
    mirrorsDir: join(dataDir, "mirrors"),
    threadsDir: join(dataDir, "threads"),
    shadowsDir: join(dataDir, "shadows"),
    runsDir: join(dataDir, "runs"),
    attachmentsDir: join(dataDir, "attachments"),
    stateFile: join(dataDir, "state.json"),
    agentCommands,
    fakeAgent,
    homesDir: join(dataDir, "homes"),
    sandbox,
    sandboxPath,
    sandboxSslCertFile: sandboxSsl,
    toolkitsFlake: process.env.CLOUDAGENTS_TOOLKITS_FLAKE?.trim() || null,
    fakeAgentRoBinds,
    systemd,
    maxConcurrentRuns: intEnv("CLOUDAGENTS_MAX_CONCURRENT_RUNS", 0, 0),
    taskDiskMax: diskMaxEnv(),
    webrtc: webRtcEnv(direct?.managed === true),
    githubApiUrl: loadGitHubApiUrl(),
    gitLegacyNoreplyUsers,
  }
}

/** systemd validates the value itself (the box probes the limits at startup); only shape is checked here. */
const limitEnv = (name: string, fallback: string): string => {
  const value = process.env[name]?.trim() || fallback
  if (!/^[A-Za-z0-9.%]+$/.test(value)) throw new Error(`${name} must be a systemd limit value, got "${value}"`)
  return value
}

/** CLOUDAGENTS_SANDBOX; unset means `strict` when the Nix toolchain is configured, `basic` otherwise. */
const sandboxLevel = (sandboxPath: string | null): SandboxLevel => {
  const raw = process.env.CLOUDAGENTS_SANDBOX?.trim()
  if (raw === undefined || raw === "") return sandboxPath === null ? "basic" : "strict"
  if (raw === "strict" || raw === "basic" || raw === "off") return raw
  const hint = raw === "0" ? " (CLOUDAGENTS_SANDBOX=0 is now CLOUDAGENTS_SANDBOX=off)" : ""
  throw new Error(`CLOUDAGENTS_SANDBOX must be strict, basic or off, got "${raw}"${hint}`)
}

const provisioningEnv = (): Provisioning => {
  const raw = process.env.CLOUDAGENTS_PROVISIONING?.trim() || "per-thread"
  if (raw === "guaranteed" || raw === "pooled" || raw === "per-thread") return raw
  throw new Error(`CLOUDAGENTS_PROVISIONING must be guaranteed, pooled or per-thread, got "${raw}"`)
}

const intEnv = (name: string, fallback: number, min: number, max = Number.MAX_SAFE_INTEGER): number => {
  const raw = process.env[name]?.trim()
  if (raw === undefined || raw === "") return fallback
  const value = Number(raw)
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new Error(`${name} must be an integer from ${min} to ${max}, got "${raw}"`)
  }
  return value
}

const diskMaxEnv = (): number => {
  const raw = process.env.CLOUDAGENTS_TASK_DISK_MAX?.trim() || "50G"
  const bytes = parseSize(raw)
  if (bytes === null || bytes <= 0) throw new Error(`CLOUDAGENTS_TASK_DISK_MAX must be a size such as 50G, got "${raw}"`)
  return bytes
}

/**
 * WebRTC connectivity for desktop media. Always on. ICE servers default to one public STUN server;
 * CLOUDAGENTS_WEBRTC_ICE_SERVERS replaces it (`[]` for none). TURN is used only when the operator configures it.
 * A managed box takes the TURN REST secret instead of static credentials.
 */
export const webRtcEnv = (managed: boolean, env: NodeJS.ProcessEnv = process.env): WebRtcSettings => {
  const servers = env.CLOUDAGENTS_WEBRTC_ICE_SERVERS?.trim() || '[{"urls":["stun:stun.cloudflare.com:3478"]}]'
  let iceServers: ReadonlyArray<DesktopRtcIceServer>
  try {
    iceServers = Schema.decodeUnknownSync(Schema.parseJson(Schema.Array(DesktopRtcIceServer)))(servers)
  } catch {
    throw new Error(`CLOUDAGENTS_WEBRTC_ICE_SERVERS must be a JSON array of {"urls":["stun:host:port"],"username"?,"credential"?}`)
  }
  if (iceServers.some((s) => s.urls.length === 0 || s.urls.some((u) => !/^(stun|stuns|turn|turns):/.test(u)))) {
    throw new Error("CLOUDAGENTS_WEBRTC_ICE_SERVERS urls must start with stun:, stuns:, turn: or turns:")
  }
  if (managed && iceServers.some((s) => s.credential !== undefined)) {
    throw new Error("a managed box must not share static TURN credentials: use CLOUDAGENTS_WEBRTC_TURN_SECRET")
  }
  const turnUrls = (env.CLOUDAGENTS_WEBRTC_TURN_URLS ?? "").split(",").map((u) => u.trim()).filter((u) => u !== "")
  const turnSecret = env.CLOUDAGENTS_WEBRTC_TURN_SECRET?.trim() ?? ""
  if ((turnUrls.length === 0) !== (turnSecret === "")) {
    throw new Error("CLOUDAGENTS_WEBRTC_TURN_URLS and CLOUDAGENTS_WEBRTC_TURN_SECRET must be set together")
  }
  if (turnUrls.some((u) => !/^turns?:/.test(u))) throw new Error("CLOUDAGENTS_WEBRTC_TURN_URLS must start with turn: or turns:")
  const policy = env.CLOUDAGENTS_WEBRTC_ICE_POLICY?.trim() || "all"
  if (policy !== "all" && policy !== "relay") throw new Error(`CLOUDAGENTS_WEBRTC_ICE_POLICY must be all or relay, got "${policy}"`)
  if (policy === "relay" && turnUrls.length === 0 && !iceServers.some((s) => s.urls.some((u) => u.startsWith("turn")))) {
    throw new Error("CLOUDAGENTS_WEBRTC_ICE_POLICY=relay needs a TURN server")
  }
  return {
    iceServers,
    turn: turnUrls.length === 0 ? null : { urls: turnUrls, secret: turnSecret },
    policy,
    portRange: webRtcPortRange(env.CLOUDAGENTS_WEBRTC_PORT_RANGE?.trim() ?? ""),
    hostAddresses: (env.CLOUDAGENTS_WEBRTC_HOST_ADDRESSES ?? "").split(",").map((a) => a.trim()).filter((a) => a !== ""),
    denyPrivate: managed,
  }
}

const webRtcPortRange = (raw: string): readonly [number, number] | null => {
  if (raw === "") return null
  const match = /^(\d+)-(\d+)$/.exec(raw)
  const low = Number(match?.[1])
  const high = Number(match?.[2])
  // werift's own limit: a range of one port does not work.
  if (match === null || low < 1024 || high > 65535 || low >= high) {
    throw new Error(`CLOUDAGENTS_WEBRTC_PORT_RANGE must look like 50000-50100, got "${raw}"`)
  }
  return [low, high]
}

const loadGitHubApiUrl = (): string => {
  const raw = process.env.GITHUB_API_URL?.trim() || "https://api.github.com"
  let protocol: string
  try {
    protocol = new URL(raw).protocol
  } catch {
    throw new Error(`GITHUB_API_URL must be an absolute URL, got "${raw}"`)
  }
  if (!["http:", "https:"].includes(protocol)) throw new Error(`GITHUB_API_URL must use http(s), got "${raw}"`)
  return raw.replace(/\/+$/, "")
}

/** `CLOUDAGENTS_CONTROL_URL`, validated; null when unset. */
const loadControlUrl = (): string | null => {
  const controlUrl = process.env.CLOUDAGENTS_CONTROL_URL?.trim() ?? ""
  if (controlUrl === "") return null
  let protocol: string
  try {
    protocol = new URL(controlUrl).protocol
  } catch {
    throw new Error(`CLOUDAGENTS_CONTROL_URL must be an absolute URL, got "${controlUrl}"`)
  }
  if (!["http:", "https:", "ws:", "wss:"].includes(protocol)) {
    throw new Error(`CLOUDAGENTS_CONTROL_URL must use http(s) or ws(s), got "${controlUrl}"`)
  }
  return controlUrl
}

/**
 * Direct mode needs both `CLOUDAGENTS_BOX_ID` and `CLOUDAGENTS_BOX_SECRET`, and the control plane's URL. A managed box
 * (`CLOUDAGENTS_BOX_MANAGED=1`) must have all three.
 */
const loadDirect = (controlUrl: string | null, dataDir: string): ServerConfig["direct"] => {
  const boxId = process.env.CLOUDAGENTS_BOX_ID?.trim() ?? ""
  const boxSecret = process.env.CLOUDAGENTS_BOX_SECRET?.trim() || readStoredSecret(dataDir) || ""
  const managed = process.env.CLOUDAGENTS_BOX_MANAGED === "1"
  if (managed && (boxId === "" || boxSecret === "" || controlUrl === null)) {
    throw new Error(
      "CLOUDAGENTS_BOX_MANAGED=1 requires CLOUDAGENTS_BOX_ID, CLOUDAGENTS_BOX_SECRET and CLOUDAGENTS_CONTROL_URL",
    )
  }
  if (boxId === "" && boxSecret === "") return null
  if (boxId === "" || boxSecret === "") {
    throw new Error("CLOUDAGENTS_BOX_ID and CLOUDAGENTS_BOX_SECRET must be set together")
  }
  if (controlUrl === null) throw new Error("CLOUDAGENTS_CONTROL_URL is required when CLOUDAGENTS_BOX_ID is set")
  return { controlUrl, boxId, boxSecret, managed }
}

/** The relay runs only with `CLOUDAGENTS_BOX_TOKEN`; CONTROL_URL alone is valid only alongside direct mode. */
const loadRelay = (controlUrl: string | null, direct: ServerConfig["direct"]): ServerConfig["relay"] => {
  const boxToken = process.env.CLOUDAGENTS_BOX_TOKEN?.trim() ?? ""
  if (boxToken === "") {
    if (controlUrl !== null && direct === null) {
      throw new Error("CLOUDAGENTS_BOX_TOKEN is required when CLOUDAGENTS_CONTROL_URL is set without CLOUDAGENTS_BOX_ID")
    }
    return null
  }
  if (controlUrl === null) throw new Error("CLOUDAGENTS_CONTROL_URL is required when CLOUDAGENTS_BOX_TOKEN is set")
  return { controlUrl, boxToken }
}

/** `NEST_BOX_ENV.guestAgentSocket`: present only on a Nest VM. */
const loadNest = (): ServerConfig["nest"] => {
  const guestSocket = process.env[NEST_BOX_ENV.guestAgentSocket]?.trim() ?? ""
  return guestSocket === "" ? null : { guestSocket }
}

export const ConfigLive = Layer.sync(Config, loadConfig)
