import { Context, Layer } from "effect"
import { join, resolve } from "node:path"
import type { ModelProvider } from "@cloudagents/protocol"
import pkg from "../package.json"
import type { SystemdSettings } from "./sandbox/systemd"

export const VERSION: string = pkg.version

const DEFAULT_ANTHROPIC_COMMAND =
  'claude -p "$CLOUDAGENTS_PROMPT" ${CLOUDAGENTS_RESUME_SESSION:+--resume "$CLOUDAGENTS_RESUME_SESSION"} --mcp-config "$CLOUDAGENTS_MCP_CONFIG" --dangerously-skip-permissions --output-format stream-json --verbose ${CLOUDAGENTS_MODEL:+--model "$CLOUDAGENTS_MODEL"} ${CLOUDAGENTS_EFFORT:+--effort "$CLOUDAGENTS_EFFORT"}'

/**
 * Codex reads `openai_base_url` from config, not from `OPENAI_BASE_URL`, so the broker URL is passed through
 * explicitly; its base includes `/v1` because codex appends `/responses`. Kestrel's bwrap sandbox replaces codex's
 * own, and `tool_timeout_sec` is ~2^31 ms in seconds, so a `task_ask` waits as long as the user takes.
 */
const DEFAULT_OPENAI_COMMAND =
  'codex exec ${CLOUDAGENTS_RESUME_SESSION:+resume "$CLOUDAGENTS_RESUME_SESSION"} --json --skip-git-repo-check --dangerously-bypass-approvals-and-sandbox ${OPENAI_BASE_URL:+-c openai_base_url="$OPENAI_BASE_URL"} ${CLOUDAGENTS_MODEL:+-m "$CLOUDAGENTS_MODEL"} ${CLOUDAGENTS_EFFORT:+-c model_reasoning_effort="\\"$CLOUDAGENTS_EFFORT\\""} -c mcp_servers.cloudagents.url="$CLOUDAGENTS_MCP_URL" -c mcp_servers.cloudagents.bearer_token_env_var="CLOUDAGENTS_MCP_TOKEN" -c mcp_servers.cloudagents.tool_timeout_sec=2147483.647 -- "$CLOUDAGENTS_PROMPT"'

export interface ServerConfig {
  readonly port: number
  readonly host: string
  /** Base URL the agent harness uses to reach this server's MCP endpoint. */
  readonly mcpBaseUrl: string
  readonly dataDir: string
  /** Bare mirrors of repositories, one per user per repository; host-only writes, read-only in sandboxes. */
  readonly mirrorsDir: string
  /** Per-thread workspaces: the agent's working directory, with one checkout directory per repository. */
  readonly threadsDir: string
  /** Host-only shadow git dirs, one per checkout; all host-side git on a checkout runs against these. */
  readonly shadowsDir: string
  readonly runsDir: string
  readonly attachmentsDir: string
  readonly stateFile: string
  /**
   * Shell commands run (via `sh -c`) for each agent run, one per model provider as picked by the message's model,
   * cwd = task worktree (`CLOUDAGENTS_ANTHROPIC_COMMAND` / `CLOUDAGENTS_OPENAI_COMMAND` override the defaults).
   * They read the prompt from `CLOUDAGENTS_PROMPT`, and `CLOUDAGENTS_MODEL` / `CLOUDAGENTS_EFFORT` when the
   * message chose them; the defaults turn the latter two into Claude Code's `--model` / `--effort` or codex's
   * `-m` / `model_reasoning_effort`. Every run after a task's first gets `CLOUDAGENTS_RESUME_SESSION`, the session
   * the task's previous run printed (Claude's stream-json `init` event, or codex's `thread.started`); the command
   * must resume it (`claude --resume`, `codex exec resume`) for the agent to keep the thread's context. An
   * OpenAI run reaches the model through the broker: `OPENAI_BASE_URL` is passed to codex's `openai_base_url`.
   */
  readonly agentCommands: Record<ModelProvider, string>
  readonly fakeAgent: boolean
  /** Control plane relay (outbound box connection). Null when `CLOUDAGENTS_CONTROL_URL` is unset. */
  readonly relay: { readonly controlUrl: string; readonly boxToken: string } | null
  /** Per-task persisted homes; each is bound at /home/agent inside the sandbox. */
  readonly homesDir: string
  /** False when CLOUDAGENTS_SANDBOX=0: agent runs and MCP exec then run unsandboxed via `sh -c`. */
  readonly sandboxEnabled: boolean
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
  /** GitHub REST API base URL (no trailing slash). Defaults to api.github.com; set for GitHub Enterprise or tests. */
  readonly githubApiUrl: string
}

export class Config extends Context.Tag("cloudagents/Config")<Config, ServerConfig>() {}

const repoRoot = resolve(import.meta.dir, "../../..")

export const loadConfig = (): ServerConfig => {
  const portRaw = process.env.CLOUDAGENTS_PORT ?? "8787"
  const port = Number(portRaw)
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    throw new Error(`CLOUDAGENTS_PORT must be a valid port, got "${portRaw}"`)
  }
  const host = process.env.CLOUDAGENTS_HOST ?? "127.0.0.1"
  const mcpHost = host === "0.0.0.0" || host === "::" ? "127.0.0.1" : host
  const dataDir = resolve(process.env.CLOUDAGENTS_DATA_DIR ?? join(repoRoot, ".data"))
  const fakeAgent = process.env.CLOUDAGENTS_FAKE_AGENT === "1"
  const fakeCommand = `${shellQuote(process.execPath)} ${shellQuote(join(repoRoot, "packages/server/scripts/fake-agent.ts"))}`
  const agentCommands: Record<ModelProvider, string> = fakeAgent
    ? { anthropic: fakeCommand, openai: fakeCommand }
    : {
        anthropic: process.env.CLOUDAGENTS_ANTHROPIC_COMMAND ?? DEFAULT_ANTHROPIC_COMMAND,
        openai: process.env.CLOUDAGENTS_OPENAI_COMMAND ?? DEFAULT_OPENAI_COMMAND,
      }
  const sandboxEnabled = process.env.CLOUDAGENTS_SANDBOX !== "0"
  if (!sandboxEnabled) console.warn("CLOUDAGENTS_SANDBOX=0: agent runs are NOT sandboxed")
  const sandboxPath = process.env.CLOUDAGENTS_SANDBOX_PATH?.trim() || null
  const sandboxSsl = process.env.CLOUDAGENTS_SANDBOX_SSL?.trim() || null
  const fakeAgentRoBinds = fakeAgent ? [process.execPath, join(repoRoot, "packages/server"), join(repoRoot, "node_modules")] : []
  const systemdEnabled = process.env.CLOUDAGENTS_SYSTEMD !== "0"
  if (!systemdEnabled) console.warn("CLOUDAGENTS_SYSTEMD=0: agent runs have NO resource limits")
  // One slice per box (ports are unique per box on a machine); task slices nest under it.
  const systemd: SystemdSettings | null = systemdEnabled
    ? {
        boxSlice: `kestrel-box${port}`,
        limits: {
          memoryMax: limitEnv("CLOUDAGENTS_TASK_MEMORY_MAX", "4G"),
          cpuQuota: limitEnv("CLOUDAGENTS_TASK_CPU_QUOTA", "200%"),
          tasksMax: limitEnv("CLOUDAGENTS_TASK_TASKS_MAX", "1024"),
        },
      }
    : null
  return {
    port,
    host,
    relay: loadRelay(),
    mcpBaseUrl: `http://${mcpHost.includes(":") ? `[${mcpHost}]` : mcpHost}:${port}`,
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
    sandboxEnabled,
    sandboxPath,
    sandboxSslCertFile: sandboxSsl,
    toolkitsFlake: process.env.CLOUDAGENTS_TOOLKITS_FLAKE?.trim() || null,
    fakeAgentRoBinds,
    systemd,
    githubApiUrl: loadGitHubApiUrl(),
  }
}

/** systemd validates the value itself (the box probes the limits at startup); only shape is checked here. */
const limitEnv = (name: string, fallback: string): string => {
  const value = process.env[name]?.trim() || fallback
  if (!/^[A-Za-z0-9.%]+$/.test(value)) throw new Error(`${name} must be a systemd limit value, got "${value}"`)
  return value
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

const loadRelay = (): ServerConfig["relay"] => {
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
  const boxToken = process.env.CLOUDAGENTS_BOX_TOKEN?.trim() ?? ""
  if (boxToken === "") throw new Error("CLOUDAGENTS_BOX_TOKEN is required when CLOUDAGENTS_CONTROL_URL is set")
  return { controlUrl, boxToken }
}

export const ConfigLive = Layer.sync(Config, loadConfig)

const shellQuote = (s: string): string => `'${s.replace(/'/g, `'\\''`)}'`
