import { Context, Layer } from "effect"
import { join, resolve } from "node:path"
import pkg from "../package.json"
import type { SystemdSettings } from "./sandbox/systemd"

export const VERSION: string = pkg.version

const DEFAULT_AGENT_COMMAND =
  'claude -p "$CLOUDAGENTS_PROMPT" --mcp-config "$CLOUDAGENTS_MCP_CONFIG" --dangerously-skip-permissions --output-format stream-json --verbose'

export interface ServerConfig {
  readonly port: number
  readonly host: string
  /** Base URL the agent harness uses to reach this server's MCP endpoint. */
  readonly mcpBaseUrl: string
  readonly dataDir: string
  readonly reposDir: string
  readonly worktreesDir: string
  readonly runsDir: string
  readonly stateFile: string
  /** Shell command run (via `sh -c`) for each agent run, cwd = task worktree. */
  readonly agentCommand: string
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
  const agentCommand = fakeAgent
    ? `${shellQuote(process.execPath)} ${shellQuote(join(repoRoot, "packages/server/scripts/fake-agent.ts"))}`
    : (process.env.CLOUDAGENTS_AGENT_COMMAND ?? DEFAULT_AGENT_COMMAND)
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
    reposDir: join(dataDir, "repos"),
    worktreesDir: join(dataDir, "worktrees"),
    runsDir: join(dataDir, "runs"),
    stateFile: join(dataDir, "state.json"),
    agentCommand,
    fakeAgent,
    homesDir: join(dataDir, "homes"),
    sandboxEnabled,
    sandboxPath,
    sandboxSslCertFile: sandboxSsl,
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
