import type { RunDriver, RunOutcome } from "./run-driver"
import { isRecord } from "./transcript"

/*
 * A run whose CLI speaks the Agent Client Protocol (ACP) over its stdin/stdout, as `opencode acp` does: JSON-RPC 2.0,
 * `initialize`, then `session/new` (or `session/resume`, which continues a session without replaying it), the model
 * and thinking level as session config options, and one `session/prompt` whose response ends the turn. The agent's
 * work arrives as `session/update` notifications, which the run's transcript turns into items.
 */

/** An MCP server the agent connects to over streamable HTTP, as `session/new` takes it. */
export interface AcpMcpServer {
  readonly type: "http"
  readonly name: string
  readonly url: string
  readonly headers: ReadonlyArray<{ readonly name: string; readonly value: string }>
}

export interface AcpRunInput {
  /** What the turn sends: the message with the box's user context and any carried conversation around it. */
  readonly prompt: string
  /** Where the thread works: its first checkout, or the workspace root (`agentCwd` in `harness.ts`). */
  readonly cwd: string
  /** The thread's previous session of this agent, or null for a fresh one. */
  readonly resumeSession: string | null
  readonly provider?: string
  readonly model?: string
  readonly effort?: string
  readonly mcpServers: ReadonlyArray<AcpMcpServer>
}

/** What the driver does with an agent's permission request: run tools (the sandbox is the boundary) or refuse them. */
export type AcpPermissionPolicy = "allow" | "deny"

export interface AcpDriverIo {
  /** Writes one JSON-RPC message to the CLI's stdin. */
  readonly send: (message: unknown) => void
  /** The run's session, once the agent has opened or resumed it. */
  readonly onSession: (sessionId: string) => void
  /** The run's turn is over (or never started); the process can be let go. Called once. */
  readonly onDone: (outcome: RunOutcome) => void
  /** Permission requests are approved for real runs; isolated text generation refuses them. Defaults to allow. */
  readonly permission?: AcpPermissionPolicy
}

const errorText = (error: unknown): string =>
  isRecord(error) && typeof error.message === "string" ? error.message : "the agent refused the request"

/**
 * The session's thinking-level option: the select option in ACP's `thought_level` category, whatever the agent calls
 * it (OpenCode `effort`, Antigravity CLI `thought_level`), with the values it offers; null when the model has none.
 */
const thoughtLevel = (configOptions: unknown): { readonly id: string; readonly values: ReadonlyArray<string> } | null => {
  if (!Array.isArray(configOptions)) return null
  const option = configOptions.find((o) => isRecord(o) && o.category === "thought_level")
  if (!isRecord(option) || typeof option.id !== "string" || !Array.isArray(option.options)) return null
  return { id: option.id, values: option.options.flatMap((o) => (isRecord(o) && typeof o.value === "string" ? [o.value] : [])) }
}

/**
 * The permission option that lets the agent go ahead. Kestrel's sandbox is the boundary and nobody is there to ask, so
 * every request is approved; "always" spares the agent asking again for the same kind of action.
 */
const allowOption = (options: unknown): string | null => {
  if (!Array.isArray(options)) return null
  const ids = (kind: string) =>
    options.flatMap((o) => (isRecord(o) && o.kind === kind && typeof o.optionId === "string" ? [o.optionId] : []))
  return ids("allow_always")[0] ?? ids("allow_once")[0] ?? null
}

/** The permission option that refuses a request, when the agent offers one. */
const denyOption = (options: unknown): string | null => {
  if (!Array.isArray(options)) return null
  const ids = (kind: string) =>
    options.flatMap((o) => (isRecord(o) && o.kind === kind && typeof o.optionId === "string" ? [o.optionId] : []))
  return ids("reject_always")[0] ?? ids("reject_once")[0] ?? null
}

type DevinCandidate = { readonly value: string; readonly level: string; readonly paid: boolean }

const selectValues = (node: unknown): string[] => {
  const values: string[] = []
  const visit = (item: unknown): void => {
    if (Array.isArray(item)) {
      for (const child of item) visit(child)
      return
    }
    if (!isRecord(item)) return
    if (typeof item.value === "string") values.push(item.value)
    visit(item.options)
  }
  visit(node)
  return values
}

const findConfigOption = (configOptions: unknown, category: string): { readonly currentValue: string | null; readonly values: string[] } | null => {
  if (!Array.isArray(configOptions)) return null
  const option = configOptions.find((item) => isRecord(item) && (item.category === category || item.id === category))
  if (!isRecord(option)) return null
  return {
    currentValue: typeof option.currentValue === "string" ? option.currentValue : null,
    values: selectValues(option.options),
  }
}

const DEVIN_LEVELS = ["none", "low", "medium", "high", "xhigh", "max"] as const
const DEVIN_TIER_SUFFIXES = ["ultrafast", "priority", "lightning", "fast", "flex", "usa", "1m"] as const

/** The thinking level a Devin variant uid encodes, ignoring paid tier and region suffixes; null for anchors and non-effort ids. */
const devinThinkingLevel = (value: string, family: string): string | null => {
  for (const prefix of new Set([family, family.replaceAll(".", "-")])) {
    if (!value.startsWith(`${prefix}-`)) continue
    let rest = value.slice(prefix.length + 1)
    for (;;) {
      const tier = DEVIN_TIER_SUFFIXES.find((suffix) => rest.endsWith(`-${suffix}`))
      if (tier === undefined) break
      rest = rest.slice(0, -(tier.length + 1))
    }
    if (rest === "no-thinking" || rest === "off") return "none"
    if ((DEVIN_LEVELS as readonly string[]).includes(rest)) return rest
    return null
  }
  return null
}

const devinPaidTier = (value: string): boolean => /-(?:ultrafast|priority|lightning|fast|flex|usa|1m)$/.test(value)

/**
 * Devin's ACP `model` option is account-scoped and has shipped both family anchors and concrete variant uids. Pick the
 * advertised value for the requested family: the anchor when offered, else the variant for the chosen effort, else the
 * session's current variant for that family. Thinking itself stays on the separate `thought_level` option.
 */
const resolveDevinModel = (configOptions: unknown, model: string, effort: string | undefined): string => {
  const option = findConfigOption(configOptions, "model")
  if (option === null || option.values.length === 0 || option.values.includes(model)) return model
  const candidates: DevinCandidate[] = option.values.flatMap((value) => {
    const level = devinThinkingLevel(value, model)
    return level === null ? [] : [{ value, level, paid: devinPaidTier(value) }]
  })
  if (candidates.length === 0) return model
  const first = (list: ReadonlyArray<DevinCandidate>): string | undefined => {
    const plain = list.filter((candidate) => !candidate.paid)
    return (plain.length > 0 ? plain : list)[0]?.value
  }
  if (effort !== undefined) {
    const exact = first(candidates.filter((candidate) => candidate.level === effort))
    if (exact !== undefined) return exact
  }
  if (option.currentValue !== null && candidates.some((candidate) => candidate.value === option.currentValue)) return option.currentValue
  for (const level of ["high", "medium", "max", "xhigh", "low", "none"]) {
    const value = first(candidates.filter((candidate) => candidate.level === level))
    if (value !== undefined) return value
  }
  return first(candidates) ?? model
}

export const makeAcpDriver = (input: AcpRunInput, io: AcpDriverIo): RunDriver => {
  let nextId = 1
  const pending = new Map<number, (message: Record<string, unknown>) => void>()
  let sessionId: string | null = null
  let prompting = false
  let outcome: RunOutcome | null = null

  const request = (method: string, params: unknown, onResult: (message: Record<string, unknown>) => void) => {
    const id = nextId++
    pending.set(id, onResult)
    io.send({ jsonrpc: "2.0", id, method, params })
  }

  const finish = (result: RunOutcome) => {
    if (outcome !== null) return
    outcome = result
    io.onDone(result)
  }

  /** A failed request ends the run; its error is the run's error. */
  const orFail = (method: string, then: (result: Record<string, unknown>) => void) => (message: Record<string, unknown>) => {
    if (message.error !== undefined || !isRecord(message.result)) {
      finish({ status: "failed", error: `${method}: ${errorText(message.error)}` })
      return
    }
    then(message.result)
  }

  const prompt = () => {
    prompting = true
    request(
      "session/prompt",
      { sessionId, prompt: [{ type: "text", text: input.prompt }] },
      orFail("session/prompt", (result) => {
        prompting = false
        switch (result.stopReason) {
          case "cancelled":
            finish({ status: "interrupted" })
            return
          case "refusal":
            finish({ status: "failed", error: "The model refused to continue." })
            return
          default:
            // end_turn, and the agent's own limits (max_tokens, max_turn_requests), end the turn normally.
            finish({ status: "completed" })
        }
      }),
    )
  }

  /** The thinking level, when the session's model offers it; the catalog only offers levels the model has. */
  const setEffort = (configOptions: unknown) => {
    const option = thoughtLevel(configOptions)
    if (input.effort === undefined || option === null || !option.values.includes(input.effort)) {
      prompt()
      return
    }
    request(
      "session/set_config_option",
      { sessionId, configId: option.id, value: input.effort },
      orFail(`session/set_config_option ${option.id}`, prompt),
    )
  }

  const configure = (opened: Record<string, unknown>) => {
    const model = input.provider === "devin" && input.model !== undefined
      ? resolveDevinModel(opened.configOptions, input.model, input.effort)
      : input.model
    if (model === undefined) {
      setEffort(opened.configOptions)
      return
    }
    request(
      "session/set_config_option",
      { sessionId, configId: "model", value: model },
      orFail("session/set_config_option model", (result) => setEffort(result.configOptions)),
    )
  }

  const openSession = () => {
    const session = { cwd: input.cwd, mcpServers: input.mcpServers }
    if (input.resumeSession === null) {
      request(
        "session/new",
        session,
        orFail("session/new", (result) => {
          if (typeof result.sessionId !== "string") {
            finish({ status: "failed", error: "session/new: no session in the response" })
            return
          }
          sessionId = result.sessionId
          io.onSession(sessionId)
          configure(result)
        }),
      )
      return
    }
    sessionId = input.resumeSession
    request(
      "session/resume",
      { sessionId, ...session },
      orFail("session/resume", (result) => {
        io.onSession(sessionId as string)
        configure(result)
      }),
    )
  }

  const answerAgentRequest = (message: Record<string, unknown>) => {
    if (message.method === "session/request_permission") {
      const params = isRecord(message.params) ? message.params : {}
      const optionId = (io.permission === "deny" ? denyOption : allowOption)(params.options)
      io.send(
        optionId === null
          ? { jsonrpc: "2.0", id: message.id, result: { outcome: { outcome: "cancelled" } } }
          : { jsonrpc: "2.0", id: message.id, result: { outcome: { outcome: "selected", optionId } } },
      )
      return
    }
    // File and terminal access go through the agent's own tools: Kestrel offers no client capabilities.
    io.send({ jsonrpc: "2.0", id: message.id, error: { code: -32601, message: `${String(message.method)} is not supported by Kestrel` } })
  }

  return {
    start: () => {
      request(
        "initialize",
        { protocolVersion: 1, clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false } },
        orFail("initialize", openSession),
      )
    },
    receive: (message) => {
      if (!isRecord(message)) return
      if (typeof message.method === "string") {
        if (message.id !== undefined) answerAgentRequest(message)
        return
      }
      if (typeof message.id !== "number") return
      const onResult = pending.get(message.id)
      pending.delete(message.id)
      onResult?.(message)
    },
    // ACP has no way into a running turn: the message waits in the run's inbox for task_inbox.
    steer: () => Promise.resolve(false),
    interrupt: () => {
      if (sessionId === null || !prompting || outcome !== null) return false
      io.send({ jsonrpc: "2.0", method: "session/cancel", params: { sessionId } })
      return true
    },
    close: () => {
      const unanswered = [...pending.values()]
      pending.clear()
      for (const onResult of unanswered) onResult({ error: { message: "the agent exited" } })
      finish({ status: "failed", error: "The agent exited before its turn finished." })
    },
    outcome: () => outcome,
  }
}
