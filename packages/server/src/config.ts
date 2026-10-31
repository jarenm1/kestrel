import { Context, Layer } from "effect"
import { join, resolve } from "node:path"
import { availableParallelism } from "node:os"
import type { ModelProvider } from "@cloudagents/protocol"
import pkg from "../package.json"
import type { SandboxLevel } from "./sandbox"
import type { Provisioning, SystemdSettings } from "./sandbox/systemd"
import { parseSize } from "./size"

export const VERSION: string = pkg.version

/**
 * The prompt goes in on stdin (`--input-format stream-json`), so the harness can add messages to a running turn and
 * interrupt it (`core/claude-stream.ts`). `--include-partial-messages` streams text and thinking as `stream_event`
 * deltas next to the finished blocks.
 */
const DEFAULT_ANTHROPIC_COMMAND =
  'claude -p --input-format stream-json ${CLOUDAGENTS_RESUME_SESSION:+--resume "$CLOUDAGENTS_RESUME_SESSION"} --mcp-config "$CLOUDAGENTS_MCP_CONFIG" --dangerously-skip-permissions --output-format stream-json --verbose --include-partial-messages ${CLOUDAGENTS_MODEL:+--model "$CLOUDAGENTS_MODEL"} ${CLOUDAGENTS_EFFORT:+--effort "$CLOUDAGENTS_EFFORT"}'

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
 * Direct box auth (`direct/auth.ts`). `user` is a bring-your-own box: HS256 grants with the box secret, owner lookups
 * on `/box/self`. `managed` is the managed box: ES256 grants checked with `publicKey`, owner lookups on
 * `/box/credentials` with the service `boxToken`.
 */
export type DirectSettings =
  | { readonly mode: "user"; readonly controlUrl: string; readonly boxId: string; readonly boxSecret: string }
  | { readonly mode: "managed"; readonly controlUrl: string; readonly boxToken: string; readonly publicKey: JsonWebKey }

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
   * The Anthropic command must read Claude Code's stream-json input on stdin: the harness writes the prompt there as
   * the first user message, adds mid-run messages and sends `interrupt`, and closes stdin after the first `result`.
   * It reads `CLOUDAGENTS_MODEL` / `CLOUDAGENTS_EFFORT` when the message chose them (Claude Code's `--model` /
   * `--effort`), and `CLOUDAGENTS_RESUME_SESSION` on every run after a task's first: the session the previous run
   * printed in its stream-json `init`, which it must resume (`claude --resume`) for the agent to keep the thread's
   * context. `CLOUDAGENTS_PROMPT` still holds the prompt. The OpenAI command must start Codex app-server on stdio:
   * the harness sends it the prompt, model, effort and the thread to resume. An OpenAI run reaches the model through
   * the broker: `OPENAI_BASE_URL` is passed to codex's `openai_base_url`.
   */
  readonly agentCommands: Record<ModelProvider, string>
  readonly fakeAgent: boolean
  /** Direct box auth; null unless `CLOUDAGENTS_BOX_ID`+`CLOUDAGENTS_BOX_SECRET` (user) or `CLOUDAGENTS_BOX_PUBLIC_KEY` (managed) is set. */
  readonly direct: DirectSettings | null
  /** Control-plane client for the box's automations (MCP tools). Null unless `CLOUDAGENTS_BOX_TOKEN` is set alongside the control plane URL. */
  readonly managed: { readonly controlUrl: string; readonly boxToken: string } | null
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
  /**
   * Desktop frame bundling window in ms (CLOUDAGENTS_DESKTOP_BUNDLE_MS, default 0 = off). When set, the box sends at
   * most one WebSocket message per window per viewer: the first fragment after a quiet window goes out at once, later ones
   * are held and sent together. Fewer messages to the viewer, at up to the window of added latency during continuous
   * motion. See docs/box.md.
   */
  readonly desktopBundleMs: number
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
  const systemd: SystemdSettings | null = systemdEnabled
    ? {
        boxSlice: `kestrel-box${port}`,
        provisioning: provisioningEnv(),
        limits: {
          memoryMin: limitEnv("CLOUDAGENTS_TASK_MEMORY_MIN", "1G"),
          cpuWeight: intEnv("CLOUDAGENTS_TASK_CPU_WEIGHT", 100, 1, 10_000),
          memoryMax: limitEnv("CLOUDAGENTS_TASK_MEMORY_MAX", "4G"),
          cpuQuota: limitEnv("CLOUDAGENTS_TASK_CPU_QUOTA", "200%"),
          tasksMax: limitEnv("CLOUDAGENTS_TASK_TASKS_MAX", "1024"),
        },
        box: {
          memoryMax: limitEnv("CLOUDAGENTS_BOX_MEMORY_MAX", "infinity"),
          cpuQuota: limitEnv("CLOUDAGENTS_BOX_CPU_QUOTA", `${cores * 100}%`),
        },
      }
    : null
  const controlUrl = loadControlUrl()
  const direct = loadDirect(controlUrl)
  return {
    port,
    host,
    managed: loadManaged(direct),
    direct,
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
    sandbox,
    sandboxPath,
    sandboxSslCertFile: sandboxSsl,
    toolkitsFlake: process.env.CLOUDAGENTS_TOOLKITS_FLAKE?.trim() || null,
    fakeAgentRoBinds,
    systemd,
    maxConcurrentRuns: intEnv("CLOUDAGENTS_MAX_CONCURRENT_RUNS", 0, 0),
    taskDiskMax: diskMaxEnv(),
    desktopBundleMs: bundleMsEnv(),
    githubApiUrl: loadGitHubApiUrl(),
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

const bundleMsEnv = (): number => {
  const raw = process.env.CLOUDAGENTS_DESKTOP_BUNDLE_MS?.trim() || "0"
  const ms = Number(raw)
  if (!/^\d+$/.test(raw) || ms > 1000) {
    throw new Error(`CLOUDAGENTS_DESKTOP_BUNDLE_MS must be a whole number of milliseconds from 0 to 1000, got "${raw}"`)
  }
  return ms
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
 * Direct box auth. `CLOUDAGENTS_BOX_ID`+`CLOUDAGENTS_BOX_SECRET` select the user mode; `CLOUDAGENTS_BOX_PUBLIC_KEY`
 * selects the managed mode (which also needs `CLOUDAGENTS_BOX_TOKEN`). The two modes never mix.
 */
const loadDirect = (controlUrl: string | null): DirectSettings | null => {
  const boxId = process.env.CLOUDAGENTS_BOX_ID?.trim() ?? ""
  const boxSecret = process.env.CLOUDAGENTS_BOX_SECRET?.trim() ?? ""
  const publicKey = process.env.CLOUDAGENTS_BOX_PUBLIC_KEY?.trim() ?? ""
  const serviceToken = process.env.CLOUDAGENTS_BOX_TOKEN?.trim() ?? ""
  if (publicKey === "") {
    if (serviceToken !== "") throw new Error("CLOUDAGENTS_BOX_TOKEN is the managed box's service token; it needs CLOUDAGENTS_BOX_PUBLIC_KEY and cannot be set for a user box")
    if (boxId === "" && boxSecret === "") return null
    if (boxId === "" || boxSecret === "") {
      throw new Error("CLOUDAGENTS_BOX_ID and CLOUDAGENTS_BOX_SECRET must be set together")
    }
    if (controlUrl === null) throw new Error("CLOUDAGENTS_CONTROL_URL is required when CLOUDAGENTS_BOX_ID is set")
    return { mode: "user", controlUrl, boxId, boxSecret }
  }
  if (boxId !== "" || boxSecret !== "") {
    throw new Error("CLOUDAGENTS_BOX_PUBLIC_KEY (managed box) cannot be set with CLOUDAGENTS_BOX_ID or CLOUDAGENTS_BOX_SECRET")
  }
  if (controlUrl === null) throw new Error("CLOUDAGENTS_CONTROL_URL is required when CLOUDAGENTS_BOX_PUBLIC_KEY is set")
  if (serviceToken === "") throw new Error("CLOUDAGENTS_BOX_TOKEN is required when CLOUDAGENTS_BOX_PUBLIC_KEY is set")
  return { mode: "managed", controlUrl, boxToken: serviceToken, publicKey: publicKeyOf(publicKey) }
}

/** `CLOUDAGENTS_BOX_PUBLIC_KEY`: a public P-256 (ES256) JSON web key. Only its public members are kept; the value is never echoed. */
const publicKeyOf = (raw: string): JsonWebKey => {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    throw new Error("CLOUDAGENTS_BOX_PUBLIC_KEY must be a JSON web key")
  }
  const jwk = parsed as Record<string, unknown> | null
  if (typeof jwk !== "object" || jwk === null || jwk.kty !== "EC" || jwk.crv !== "P-256" || typeof jwk.x !== "string" || typeof jwk.y !== "string") {
    throw new Error("CLOUDAGENTS_BOX_PUBLIC_KEY must be a public P-256 (ES256) JSON web key")
  }
  if (jwk.d !== undefined) throw new Error("CLOUDAGENTS_BOX_PUBLIC_KEY must hold the public key only, not private key material")
  if (jwk.alg !== undefined && jwk.alg !== "ES256") throw new Error("CLOUDAGENTS_BOX_PUBLIC_KEY alg must be ES256")
  return { kty: "EC", crv: "P-256", x: jwk.x, y: jwk.y }
}

/** The control-plane client for automations: the managed box's service token and the control plane's URL. */
const loadManaged = (direct: DirectSettings | null): ServerConfig["managed"] =>
  direct?.mode === "managed" ? { controlUrl: direct.controlUrl, boxToken: direct.boxToken } : null

export const ConfigLive = Layer.sync(Config, loadConfig)

const shellQuote = (s: string): string => `'${s.replace(/'/g, `'\\''`)}'`
