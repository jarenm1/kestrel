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
  readonly model?: string
  readonly effort?: string
  readonly mcpServers: ReadonlyArray<AcpMcpServer>
}

export interface AcpDriverIo {
  /** Writes one JSON-RPC message to the CLI's stdin. */
  readonly send: (message: unknown) => void
  /** The run's session, once the agent has opened or resumed it. */
  readonly onSession: (sessionId: string) => void
  /** The run's turn is over (or never started); the process can be let go. Called once. */
  readonly onDone: (outcome: RunOutcome) => void
}

const errorText = (error: unknown): string =>
  isRecord(error) && typeof error.message === "string" ? error.message : "the agent refused the request"

/** The values a select config option offers, by option id; empty when the session does not have the option. */
const optionValues = (configOptions: unknown, id: string): ReadonlyArray<string> => {
  if (!Array.isArray(configOptions)) return []
  const option = configOptions.find((o) => isRecord(o) && o.id === id)
  if (!isRecord(option) || !Array.isArray(option.options)) return []
  return option.options.flatMap((o) => (isRecord(o) && typeof o.value === "string" ? [o.value] : []))
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
    if (input.effort === undefined || !optionValues(configOptions, "effort").includes(input.effort)) {
      prompt()
      return
    }
    request(
      "session/set_config_option",
      { sessionId, configId: "effort", value: input.effort },
      orFail("session/set_config_option effort", prompt),
    )
  }

  const configure = (opened: Record<string, unknown>) => {
    if (input.model === undefined) {
      setEffort(opened.configOptions)
      return
    }
    request(
      "session/set_config_option",
      { sessionId, configId: "model", value: input.model },
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
      const optionId = allowOption(params.options)
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
