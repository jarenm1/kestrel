import {
  discoveredModel,
  type CliProvider,
  type ModelDiscoverySource,
  type ModelInfo,
  type ModelProvider,
} from "@cloudagents/protocol"
import { VERSION } from "./config"
import {
  CLAUDE_DISCOVERY_ARGS,
  CODEX_DISCOVERY_ARGS,
  discover,
  runDiscoveryCommand,
  type DiscoveryLaunch,
} from "./harness-commands"
import { isRecord } from "./core/transcript"

/*
 * Native model discovery from the authenticated agent CLIs, in a box-owned empty workspace.
 *
 * Each CLI exposes the models its own login can run, and only that: Claude Code lists them in the initialize control
 * response, Codex app-server pages them from `model/list`, OpenCode prints its available `provider/model` rows, and
 * the ACP agents report a session's `configOptions` once a session is opened.
 * Discovery stops there: no prompt is sent, no turn starts, no Kestrel thread is written. A CLI without a genuine
 * enumeration reports `unsupported` rather than a guessed list.
 */

/** What native discovery answered for a user: the models its logins offer, and one status per source. */
export interface HarnessModelDiscovery {
  readonly models: ReadonlyArray<ModelInfo>
  readonly sources: ReadonlyArray<ModelDiscoverySource>
}

/** The model provider a native CLI login runs models for. */
export const NATIVE_MODEL_PROVIDER: Readonly<Record<CliProvider, ModelProvider>> = {
  "claude-cli": "anthropic",
  "codex-cli": "openai",
  opencode: "opencode",
  "opencode-go": "opencode-go",
  "antigravity-cli": "google",
  "devin-cli": "devin",
}

/** What one native source answered: its models, or why it could not name any. */
export interface NativeModelDiscovery {
  readonly models: ReadonlyArray<ModelInfo>
  readonly status: "ok" | "unsupported"
  readonly message?: string
}

const TIMEOUT_MS = 15_000
/** A catalog larger than this is not a picker; the bound also bounds a runaway CLI. */
const MAX_MODELS = 500
const CODEX_PAGE_LIMIT = 100
const MAX_CODEX_PAGES = 20
const UPSTREAM_MAX = 200
/** The Claude Code 1m-context decoration is not part of the model id a native run receives. */
const CONTEXT_DECORATION = /\[1m\]$/i

/** Args that make `provider`'s CLI answer a model list without starting a turn. */
export const nativeDiscoveryArgs = (provider: CliProvider, loginDir: string): ReadonlyArray<string> => {
  switch (provider) {
    case "claude-cli":
      return CLAUDE_DISCOVERY_ARGS
    case "codex-cli":
      return CODEX_DISCOVERY_ARGS
    // OpenCode prints its available models; Antigravity and Devin speak ACP on stdio.
    case "opencode":
    case "opencode-go":
      return ["models"]
    case "antigravity-cli":
      return ["acp", "--gemini-dir", loginDir, "--dangerously-skip-permissions", "--disable-telemetry"]
    case "devin-cli":
      return ["acp"]
  }
}

const firstString = (...values: readonly unknown[]): string => {
  for (const value of values) {
    if (typeof value === "string" && value.trim() !== "") return value.trim()
  }
  return ""
}

/**
 * The upstream ids a Claude Code initialize payload offers. `resolvedModel` is the concrete id an alias (`opus`,
 * `default`) resolves to, so it identifies the model stably; `value` covers CLIs that do not resolve aliases.
 */
export const parseClaudeModels = (value: unknown): ReadonlyArray<string> => {
  if (!Array.isArray(value)) return []
  const upstreams: string[] = []
  for (const row of value) {
    if (!isRecord(row)) continue
    const upstream = firstString(row.resolvedModel, row.value)
    if (upstream !== "") upstreams.push(upstream)
  }
  return upstreams
}

/** One app-server `model/list` page: the visible model ids in order and the cursor for the next page. */
export interface CodexModelPage {
  readonly upstreams: ReadonlyArray<string>
  readonly nextCursor: string | null
}

/** Parses one Codex app-server `model/list` result. Hidden models are not part of the picker. */
export const parseCodexModelPage = (value: unknown): CodexModelPage => {
  if (!isRecord(value)) return { upstreams: [], nextCursor: null }
  const upstreams: string[] = []
  for (const row of Array.isArray(value.data) ? value.data : []) {
    if (!isRecord(row) || row.hidden === true) continue
    // `model` is the native model `thread/start` takes; `id` is only a fallback for older protocol shapes.
    const upstream = firstString(row.model, row.id)
    if (upstream !== "") upstreams.push(upstream)
  }
  const nextCursor = typeof value.nextCursor === "string" && value.nextCursor !== "" ? value.nextCursor : null
  return { upstreams, nextCursor }
}

/**
 * OpenCode's model list is one `provider/model` row per line. Decoration, blank lines and any heading are dropped;
 * the provider prefix decides which login's models they are.
 */
export const parseOpenCodeModels = (value: string): ReadonlyArray<string> => {
  const rows: string[] = []
  for (const line of value.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, "").split(/\r?\n/)) {
    const token = line.trim().split(/\s+/)[0] ?? ""
    if (token.includes("/")) rows.push(token)
  }
  return rows
}

/** The values of an ACP select option, flat or grouped. */
const selectValues = (options: unknown): ReadonlyArray<string> => {
  if (!Array.isArray(options)) return []
  const values: string[] = []
  for (const option of options) {
    if (!isRecord(option)) continue
    const value = firstString(option.value)
    if (value !== "") {
      values.push(value)
      continue
    }
    // A grouped selector nests the same option records under `options`.
    for (const nested of selectValues(option.options)) values.push(nested)
  }
  return values
}

/**
 * The model values an ACP `session/new` result offers through the select API used by Kestrel's driver.
 * Other config options (thought level, mode), and legacy-only model APIs the driver cannot select, are not models.
 */
export const parseAcpModels = (value: unknown): ReadonlyArray<string> => {
  if (!isRecord(value)) return []
  const values: string[] = []
  if (Array.isArray(value.configOptions)) {
    for (const option of value.configOptions) {
      if (!isRecord(option)) continue
      const modelOption = option.category === "model" || option.id === "model"
      if (!modelOption || (option.type !== undefined && option.type !== "select")) continue
      for (const selected of selectValues(option.options)) values.push(selected)
    }
  }
  return values
}

/**
 * A safe upstream id for `provider`, or null when the CLI named something that is not one: model ids travel into
 * prompts and restarts, so they stay one bounded token with no shell or account decoration.
 */
const safeUpstream = (provider: ModelProvider, value: string): string | null => {
  if (typeof value !== "string") return null
  const upstream = value.trim().replace(CONTEXT_DECORATION, "")
  if (upstream === "" || upstream.length > UPSTREAM_MAX) return null
  const prefix = `${provider}/`
  if (provider === "opencode" || provider === "opencode-go") {
    // OpenCode's ACP model ids are `provider/model`; another provider's models are not this login's models.
    if (!upstream.startsWith(prefix)) return null
    const leaf = upstream.slice(prefix.length)
    // The free Console login only runs free models (`big-pickle` and the `-free` rotation), never its paid list.
    if (provider === "opencode" && leaf !== "big-pickle" && !/-free$/.test(leaf)) return null
    // Preserve Go's curated coverage: free/contributor variants and models served by the vendor logins stay there.
    if (provider === "opencode-go" && (
      /-free$/.test(leaf) || /contributor/i.test(leaf) ||
      /^(?:(?:claude|gpt|gemini)(?:[-/.]|$)|o[1-9]\d*(?:-|$)|(?:anthropic|openai|google)\/)/i.test(leaf)
    )) return null
  }
  return upstream
}

/** Curated metadata where the id is known, a bounded native live model otherwise; deduped by catalog id. */
export const toModelInfos = (provider: ModelProvider, upstreams: ReadonlyArray<string>): ReadonlyArray<ModelInfo> => {
  const models = new Map<string, ModelInfo>()
  for (const value of upstreams) {
    const upstream = safeUpstream(provider, value)
    if (upstream === null) continue
    const info = discoveredModel(provider, upstream)
    if (info === undefined || models.has(info.id)) continue
    models.set(info.id, info)
    if (models.size >= MAX_MODELS) break
  }
  return [...models.values()]
}

const result = (provider: ModelProvider, upstreams: ReadonlyArray<string>): NativeModelDiscovery => {
  const models = toModelInfos(provider, upstreams)
  return models.length === 0
    ? { models, status: "unsupported", message: "the CLI reported no available models" }
    : { models, status: "ok" }
}

/** Claude Code: the initialize control response's `models`; no prompt and no model turn. */
export const discoverClaudeModels = (
  launch: DiscoveryLaunch,
  timeoutMs = TIMEOUT_MS,
): Promise<NativeModelDiscovery> => {
  const requestId = `kestrel-models-${process.pid}-${Date.now()}`
  return discover<NativeModelDiscovery>(launch, "claude model discovery", timeoutMs, (send) => {
    send({ type: "control_request", request_id: requestId, request: { subtype: "initialize" } })
    return (message) => {
      if (!isRecord(message) || message.type !== "control_response" || !isRecord(message.response)) return undefined
      const response = message.response
      if (response.request_id !== requestId) return undefined
      if (response.subtype !== "success") throw new Error("claude model discovery was refused")
      if (!isRecord(response.response)) throw new Error("claude model discovery returned no payload")
      return result("anthropic", parseClaudeModels(response.response.models))
    }
  })
}

/** Codex app-server: every `model/list` page, following `nextCursor` until it is null or the page bound. */
export const discoverCodexModels = (
  launch: DiscoveryLaunch,
  timeoutMs = TIMEOUT_MS,
): Promise<NativeModelDiscovery> =>
  discover<NativeModelDiscovery>(launch, "codex model discovery", timeoutMs, (send) => {
    const initializeId = 1
    let nextId = 2
    let currentId = initializeId
    let pages = 0
    let lastCursor: string | null = null
    const upstreams: string[] = []
    const requestPage = (cursor: string | null) => {
      currentId = nextId++
      lastCursor = cursor
      send({ method: "model/list", id: currentId, params: { limit: CODEX_PAGE_LIMIT, cursor, includeHidden: false } })
    }
    send({
      method: "initialize",
      id: initializeId,
      params: {
        clientInfo: { name: "kestrel", title: "Kestrel", version: VERSION },
        capabilities: { experimentalApi: true },
      },
    })
    return (message) => {
      if (!isRecord(message)) return undefined
      if (message.id === initializeId) {
        if (message.error !== undefined) throw new Error("codex model discovery could not initialize")
        send({ method: "initialized", params: {} })
        requestPage(null)
        return undefined
      }
      if (message.id !== currentId) return undefined
      if (message.error !== undefined) {
        const code = isRecord(message.error) ? message.error.code : undefined
        if (code === -32601) {
          return { models: [], status: "unsupported", message: "this Codex version does not list models" }
        }
        throw new Error("codex model discovery could not list models")
      }
      const page = parseCodexModelPage(message.result)
      for (const upstream of page.upstreams) upstreams.push(upstream)
      pages++
      // A repeated cursor is a loop, and the page bound keeps a broken server from extending the timeout forever.
      if (page.nextCursor === null || page.nextCursor === lastCursor || pages >= MAX_CODEX_PAGES) {
        return result("openai", upstreams)
      }
      requestPage(page.nextCursor)
      return undefined
    }
  })

/** OpenCode: its own `models` command in this login's data home, filtered to that provider's rows. */
export const discoverOpenCodeModels = (
  provider: "opencode" | "opencode-go",
  launch: DiscoveryLaunch,
  timeoutMs = TIMEOUT_MS,
): Promise<NativeModelDiscovery> =>
  runDiscoveryCommand(launch, `${provider} model discovery`, timeoutMs).then((output) =>
    result(provider, parseOpenCodeModels(output)),
  )

/** An ACP agent: initialize, then a session's model option; never a prompt and never a resumed thread. */
export const discoverAcpModels = (
  provider: ModelProvider,
  launch: DiscoveryLaunch,
  timeoutMs = TIMEOUT_MS,
): Promise<NativeModelDiscovery> =>
  discover<NativeModelDiscovery>(launch, `${provider} model discovery`, timeoutMs, (send) => {
    const initializeId = 1
    const sessionId = 2
    send({
      jsonrpc: "2.0",
      id: initializeId,
      method: "initialize",
      params: {
        protocolVersion: 1,
        clientCapabilities: {
          fs: { readTextFile: false, writeTextFile: false },
          terminal: false,
        },
      },
    })
    return (message) => {
      if (!isRecord(message)) return undefined
      // Agent-to-client requests (fs, terminal, permission) are refused: discovery offers no capabilities.
      if (typeof message.method === "string") {
        if (message.id !== undefined) {
          send({ jsonrpc: "2.0", id: message.id, error: { code: -32601, message: "not supported by model discovery" } })
        }
        return undefined
      }
      if (message.id === initializeId) {
        if (message.error !== undefined) throw new Error(`${provider} model discovery could not initialize`)
        send({ jsonrpc: "2.0", id: sessionId, method: "session/new", params: { cwd: launch.cwd, mcpServers: [] } })
        return undefined
      }
      if (message.id !== sessionId) return undefined
      if (message.error !== undefined) {
        // ACP's `auth_required` (-32000) means this login needs a fresh sign-in, not that discovery broke.
        if (isRecord(message.error) && message.error.code === -32000) {
          return { models: [], status: "unsupported", message: "sign-in required" }
        }
        throw new Error(`${provider} model discovery could not open a session`)
      }
      return result(provider, parseAcpModels(message.result))
    }
  })

/** Asks `provider`'s CLI for its models in `launch`'s isolated workspace. */
export const discoverNativeModels = (
  provider: CliProvider,
  launch: DiscoveryLaunch,
  timeoutMs = TIMEOUT_MS,
): Promise<NativeModelDiscovery> => {
  const modelProvider = NATIVE_MODEL_PROVIDER[provider]
  switch (provider) {
    case "claude-cli":
      return discoverClaudeModels(launch, timeoutMs)
    case "codex-cli":
      return discoverCodexModels(launch, timeoutMs)
    case "opencode":
    case "opencode-go":
      return discoverOpenCodeModels(provider, launch, timeoutMs)
    case "antigravity-cli":
    case "devin-cli":
      return discoverAcpModels(modelProvider, launch, timeoutMs)
  }
}
