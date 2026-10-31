import type { AgentItem, ContextUsage } from "@cloudagents/protocol"

/**
 * Turns one harness's stdout lines into the normalized `AgentItem`s the app renders.
 * One parser per run: it remembers tool calls (so a result can complete them) and the
 * final assistant text. Both harnesses are detected per line by shape, so a fixture or a
 * recording can be fed without saying which CLI produced it.
 */
export interface Transcript {
  /** Items added or replaced by one parsed stdout line. Unknown lines yield none. */
  readonly push: (line: unknown) => ReadonlyArray<AgentItem>
  /** Final assistant text of the run, once the harness has reported it. */
  readonly finalText: () => string | null
  /**
   * The session's context use once both its size and its model's window are known. Claude reports it at its
   * results; Codex in `thread/tokenUsage/updated`. Each change is a new object.
   */
  readonly context: () => ContextUsage | null
}

/** Claude `stream-json` line types. */
const CLAUDE_LINE_TYPES: Readonly<Record<string, true>> = {
  system: true,
  assistant: true,
  user: true,
  result: true,
  stream_event: true,
}

export const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

const asString = (value: unknown): string | null => (typeof value === "string" ? value : null)

export const asNumber = (value: unknown): number | null =>
  typeof value === "number" && Number.isFinite(value) ? value : null

const asArray = (value: unknown): ReadonlyArray<unknown> => (Array.isArray(value) ? value : [])

/** Token counts reported as separate buckets: null only when none of them is present. */
const sumTokens = (values: ReadonlyArray<number | null>): number | null => {
  const present = values.filter((n): n is number => n !== null)
  return present.length === 0 ? null : present.reduce((a, b) => a + b, 0)
}

/** A tool result's content as plain text; images have no text of their own. */
const toolResultText = (content: unknown): string => {
  if (typeof content === "string") return content
  const parts: string[] = []
  for (const part of asArray(content)) {
    if (typeof part === "string") {
      parts.push(part)
      continue
    }
    if (!isRecord(part)) continue
    const kind = asString(part.type)
    if (kind === "text") parts.push(asString(part.text) ?? "")
    else if (kind === "image") parts.push("[image]")
    else parts.push(`[${kind ?? "unknown"}]`)
  }
  return parts.join("\n")
}

/** One Claude `tool_use` block, remembered until its `tool_result` arrives. */
interface ToolCall {
  readonly name: string
  readonly parentToolId: string | null
  readonly input: unknown
}

/**
 * Claude Code's context window for `model` from a result's `modelUsage`, keyed by model id. Side calls (e.g. a
 * small model titling the session) have entries of their own, so only the session's model counts.
 */
const claudeWindow = (modelUsage: unknown, model: string | null): number | null => {
  if (!isRecord(modelUsage) || model === null) return null
  const key = Object.keys(modelUsage).find((k) => k === model) ?? Object.keys(modelUsage).find((k) => k.startsWith(model))
  const entry = key === undefined ? null : modelUsage[key]
  const window = isRecord(entry) ? asNumber(entry.contextWindow) : null
  return window !== null && window > 0 ? window : null
}

/**
 * `seed` is the context the thread's session last reported; a run that resumes the same session on the same model
 * reuses its window, so its context updates from the first model call rather than only at the result.
 */
export const makeTranscript = (seed: ContextUsage | null = null): Transcript => {
  /**
   * Ids for items the harness does not name. Unique per run: the same id later means
   * "replace that item", so counter ids are never reused.
   */
  let counter = 0
  const nextId = (): string => `c${++counter}`

  let finalTextValue: string | null = null
  const tools = new Map<string, ToolCall>()
  /** Codex text built up from deltas, by item id: agent messages, reasoning parts, command output. */
  const codexText = new Map<string, string>()
  const codexParts = new Map<string, { summary: string[]; content: string[] }>()
  /**
   * Codex tool items still running, so an output delta can re-emit a command and a turn's end can close what it
   * left unfinished (a steer or an interrupt stops a command without completing its item).
   */
  const codexRunning = new Map<string, AgentItem & { _tag: "tool" }>()
  /** Each Codex turn's token totals: before its first model call, and the latest. */
  const codexTurnTokens = new Map<string, { readonly baseInput: number; readonly baseOutput: number; input: number; output: number }>()
  /** The turn's plan (`turn/plan/updated`), shown as a todo list until the turn ends. */
  const codexPlans = new Map<string, AgentItem & { _tag: "tool" }>()
  /** Text of the last top-level Codex error, so the failed turn that follows does not repeat it. */
  let codexLastError: string | null = null
  /** Claude session model (from `init`), its context window, and the main agent's latest prompt + reply size. */
  let model: string | null = null
  let windowTokens: number | null = null
  let usedTokens: number | null = null
  let contextValue: ContextUsage | null = null

  const refreshContext = () => {
    if (usedTokens === null || windowTokens === null) return
    if (contextValue?.model === model && contextValue.usedTokens === usedTokens && contextValue.windowTokens === windowTokens) {
      return
    }
    contextValue = { model, usedTokens, windowTokens }
  }

  const claudeSystem = (line: Record<string, unknown>) => {
    switch (asString(line.subtype)) {
      case "init":
        model = asString(line.model)
        windowTokens = seed !== null && seed.model === model ? seed.windowTokens : null
        return
      case "compact_boundary":
        // The pre-compaction size no longer holds; the next model call reports the compacted one.
        usedTokens = null
        return
    }
  }

  const claudeAssistant = (line: Record<string, unknown>): ReadonlyArray<AgentItem> => {
    if (!isRecord(line.message)) return []
    // Claude Code prints every content block of one API message as its own line with the same
    // message id, so ids must come from a counter, not the message id.
    const parentToolId = asString(line.parent_tool_use_id)
    // Subagents run in contexts of their own; only the main agent's calls fill the session.
    const usage = parentToolId === null && isRecord(line.message.usage) ? line.message.usage : null
    const used =
      usage === null
        ? null
        : sumTokens([
            asNumber(usage.input_tokens),
            asNumber(usage.cache_creation_input_tokens),
            asNumber(usage.cache_read_input_tokens),
            asNumber(usage.output_tokens),
          ])
    if (used !== null) {
      usedTokens = used
      refreshContext()
    }
    const items: AgentItem[] = []
    for (const block of asArray(line.message.content)) {
      if (!isRecord(block)) continue
      const kind = asString(block.type)
      if (kind === "text") {
        const text = asString(block.text)
        if (text === null || text.trim() === "") continue
        items.push({ _tag: "text", id: nextId(), parentToolId, text })
      } else if (kind === "thinking") {
        const text = asString(block.thinking)
        if (text === null || text.trim() === "") continue
        items.push({ _tag: "thinking", id: nextId(), parentToolId, text })
      } else if (kind === "tool_use") {
        const id = asString(block.id)
        const name = asString(block.name)
        if (id === null || name === null) continue
        const input = block.input ?? null
        tools.set(id, { name, parentToolId, input })
        items.push({ _tag: "tool", id, parentToolId, name, input, status: "running", output: null })
      }
    }
    return items
  }

  const claudeUser = (line: Record<string, unknown>): ReadonlyArray<AgentItem> => {
    if (!isRecord(line.message)) return []
    const items: AgentItem[] = []
    for (const block of asArray(line.message.content)) {
      if (!isRecord(block) || block.type !== "tool_result") continue
      const id = asString(block.tool_use_id)
      if (id === null) continue
      const call = tools.get(id)
      items.push({
        _tag: "tool",
        id,
        // A result inside a subagent carries the Task call it belongs to.
        parentToolId: call?.parentToolId ?? asString(line.parent_tool_use_id),
        name: call?.name ?? "tool",
        input: call?.input ?? null,
        status: block.is_error === true ? "error" : "ok",
        output: toolResultText(block.content),
      })
    }
    return items
  }

  const claudeResult = (line: Record<string, unknown>): ReadonlyArray<AgentItem> => {
    const subtype = asString(line.subtype) ?? "result"
    const isError = line.is_error === true
    const usage = isRecord(line.usage) ? line.usage : null
    windowTokens = claudeWindow(line.modelUsage, model) ?? windowTokens
    refreshContext()
    const items: AgentItem[] = [
      {
        _tag: "turn",
        id: nextId(),
        durationMs: asNumber(line.duration_ms),
        // Claude splits prompt cost into fresh, cache-write and cache-read tokens; the model
        // read all three, so the reported input is their sum.
        inputTokens:
          usage === null
            ? null
            : sumTokens([
                asNumber(usage.input_tokens),
                asNumber(usage.cache_creation_input_tokens),
                asNumber(usage.cache_read_input_tokens),
              ]),
        outputTokens: usage === null ? null : asNumber(usage.output_tokens),
        costUsd: asNumber(line.total_cost_usd),
        isError,
      },
    ]
    const text = asString(line.result)
    if (text !== null && text.trim() !== "") {
      finalTextValue = text
    } else if (isError) {
      // Failed runs sometimes carry no text at all; surface why they stopped.
      items.push({ _tag: "error", id: nextId(), text: `claude result: ${subtype}` })
    }
    return items
  }

  const claude = (line: Record<string, unknown>): ReadonlyArray<AgentItem> => {
    switch (asString(line.type)) {
      case "assistant":
        return claudeAssistant(line)
      case "user":
        return claudeUser(line)
      case "result":
        return claudeResult(line)
      case "system":
        claudeSystem(line)
        return []
      default:
        // stream_event (partial messages) adds no display items.
        return []
    }
  }

  const codexThinking = (id: string): AgentItem | null => {
    const parts = codexParts.get(id)
    if (parts === undefined) return null
    const text = (parts.summary.some((p) => p.trim() !== "") ? parts.summary : parts.content)
      .filter((p) => p.trim() !== "")
      .join("\n\n")
    return text === "" ? null : { _tag: "thinking", id, parentToolId: null, text }
  }

  /** One app-server `ThreadItem` (from `item/started` or `item/completed`) as a display item, or null. */
  const codexItem = (raw: unknown, completed: boolean): AgentItem | null => {
    if (!isRecord(raw)) return null
    const id = asString(raw.id)
    if (id === null) return null
    const status = asString(raw.status)
    const running = !completed || status === "inProgress"

    switch (asString(raw.type)) {
      case "agentMessage": {
        const text = asString(raw.text) ?? ""
        // A message starts empty and fills from deltas; the completed item carries the whole text.
        const full = text === "" ? (codexText.get(id) ?? "") : text
        codexText.set(id, full)
        if (full.trim() === "") return null
        if (completed) finalTextValue = full
        return { _tag: "text", id, parentToolId: null, text: full }
      }
      case "reasoning": {
        const summary = asArray(raw.summary).filter((p): p is string => typeof p === "string")
        const content = asArray(raw.content).filter((p): p is string => typeof p === "string")
        if (summary.length > 0 || content.length > 0 || !codexParts.has(id)) codexParts.set(id, { summary, content })
        return codexThinking(id)
      }
      case "commandExecution": {
        const exitCode = asNumber(raw.exitCode)
        const failed = status === "failed" || status === "declined" || (exitCode !== null && exitCode !== 0)
        return {
          _tag: "tool",
          id,
          parentToolId: null,
          name: "command_execution",
          input: { command: asString(raw.command) ?? "" },
          status: running ? "running" : failed ? "error" : "ok",
          output: asString(raw.aggregatedOutput) ?? codexText.get(id) ?? null,
        }
      }
      case "fileChange":
        return {
          _tag: "tool",
          id,
          parentToolId: null,
          name: "file_change",
          input: {
            changes: asArray(raw.changes).map((change) =>
              isRecord(change) ? { path: asString(change.path), kind: isRecord(change.kind) ? asString(change.kind.type) : null } : null,
            ),
          },
          status: running ? "running" : status === "failed" || status === "declined" ? "error" : "ok",
          output: null,
        }
      case "mcpToolCall": {
        const server = asString(raw.server)
        const tool = asString(raw.tool)
        if (server === null || tool === null) return null
        const error = isRecord(raw.error) ? asString(raw.error.message) : null
        const failed = error !== null || status === "failed"
        const result = isRecord(raw.result) ? toolResultText(raw.result.content) : null
        return {
          _tag: "tool",
          id,
          parentToolId: null,
          name: `${server}.${tool}`,
          input: raw.arguments ?? null,
          status: running ? "running" : failed ? "error" : "ok",
          output: failed ? error : result,
        }
      }
      case "webSearch":
        return {
          _tag: "tool",
          id,
          parentToolId: null,
          name: "web_search",
          input: { query: asString(raw.query) ?? "" },
          status: running ? "running" : "ok",
          output: null,
        }
      case "contextCompaction":
        if (completed) finalTextValue ??= "Compacted the conversation."
        return {
          _tag: "tool",
          id,
          parentToolId: null,
          name: "context_compaction",
          input: null,
          status: running ? "running" : "ok",
          output: null,
        }
      default:
        // User messages, review markers (the review arrives as an agent message), hooks and the rest add nothing.
        return null
    }
  }

  const codexTurnEnd = (params: Record<string, unknown>): ReadonlyArray<AgentItem> => {
    const turn = isRecord(params.turn) ? params.turn : null
    if (turn === null) return []
    const turnId = asString(turn.id)
    const tokens = turnId === null ? undefined : codexTurnTokens.get(turnId)
    const items: AgentItem[] = []
    // What the turn left running ends with it: an unfinished plan is over, an unfinished tool did not complete.
    const plan = turnId === null ? undefined : codexPlans.get(turnId)
    if (plan !== undefined) items.push({ ...plan, status: "ok" })
    for (const tool of codexRunning.values()) items.push({ ...tool, status: "error" })
    codexRunning.clear()
    const failed = turn.status === "failed"
    const error = isRecord(turn.error) ? asString(turn.error.message) : null
    if (failed && error !== codexLastError) items.push({ _tag: "error", id: nextId(), text: error ?? "codex turn failed" })
    items.push({
      _tag: "turn",
      id: nextId(),
      durationMs: asNumber(turn.durationMs),
      // Codex's inputTokens already includes cachedInputTokens; adding them again would double-count the prompt.
      inputTokens: tokens === undefined ? null : tokens.input - tokens.baseInput,
      outputTokens: tokens === undefined ? null : tokens.output - tokens.baseOutput,
      costUsd: null,
      isError: failed,
    })
    return items
  }

  const codexTokenUsage = (params: Record<string, unknown>) => {
    const usage = isRecord(params.tokenUsage) ? params.tokenUsage : null
    const total = usage !== null && isRecord(usage.total) ? usage.total : null
    const last = usage !== null && isRecord(usage.last) ? usage.last : null
    const turnId = asString(params.turnId)
    if (total === null || last === null) return
    const input = asNumber(total.inputTokens)
    const output = asNumber(total.outputTokens)
    if (turnId !== null && input !== null && output !== null) {
      const known = codexTurnTokens.get(turnId)
      if (known === undefined) {
        codexTurnTokens.set(turnId, {
          baseInput: input - (asNumber(last.inputTokens) ?? 0),
          baseOutput: output - (asNumber(last.outputTokens) ?? 0),
          input,
          output,
        })
      } else {
        known.input = input
        known.output = output
      }
    }
    // The last model call's size against the model's window, as the composer's context bar shows it.
    usedTokens = asNumber(last.totalTokens)
    windowTokens = asNumber(usage?.modelContextWindow)
    refreshContext()
  }

  /** A Codex JSON-RPC message: notifications carry the run; a thread's model comes from its start/resume response. */
  const codex = (line: Record<string, unknown>): ReadonlyArray<AgentItem> => {
    if (isRecord(line.result) && typeof line.result.model === "string") {
      model = line.result.model
      return []
    }
    const method = asString(line.method)
    const params = isRecord(line.params) ? line.params : null
    if (method === null || params === null || line.id !== undefined) return []
    switch (method) {
      case "thread/settings/updated":
        if (isRecord(params.threadSettings) && typeof params.threadSettings.model === "string") model = params.threadSettings.model
        return []
      case "thread/tokenUsage/updated":
        codexTokenUsage(params)
        return []
      case "item/started":
      case "item/completed": {
        const item = codexItem(params.item, method === "item/completed")
        if (item?._tag === "tool") {
          if (item.status === "running") codexRunning.set(item.id, item)
          else codexRunning.delete(item.id)
        }
        return item === null ? [] : [item]
      }
      case "item/agentMessage/delta": {
        const id = asString(params.itemId)
        const delta = asString(params.delta)
        if (id === null || delta === null) return []
        const text = (codexText.get(id) ?? "") + delta
        codexText.set(id, text)
        return text.trim() === "" ? [] : [{ _tag: "text", id, parentToolId: null, text }]
      }
      case "item/reasoning/summaryTextDelta":
      case "item/reasoning/textDelta": {
        const id = asString(params.itemId)
        const delta = asString(params.delta)
        if (id === null || delta === null) return []
        const parts = codexParts.get(id) ?? { summary: [], content: [] }
        codexParts.set(id, parts)
        const list = method === "item/reasoning/textDelta" ? parts.content : parts.summary
        const index = asNumber(method === "item/reasoning/textDelta" ? params.contentIndex : params.summaryIndex) ?? 0
        list[index] = (list[index] ?? "") + delta
        const item = codexThinking(id)
        return item === null ? [] : [item]
      }
      case "item/commandExecution/outputDelta": {
        const id = asString(params.itemId)
        const delta = asString(params.delta)
        if (id === null || delta === null) return []
        const output = (codexText.get(id) ?? "") + delta
        codexText.set(id, output)
        const command = codexRunning.get(id)
        if (command === undefined) return []
        const item = { ...command, output }
        codexRunning.set(id, item)
        return [item]
      }
      case "turn/plan/updated": {
        const turnId = asString(params.turnId)
        if (turnId === null) return []
        const steps = asArray(params.plan).filter(isRecord)
        const item: AgentItem & { _tag: "tool" } = {
          _tag: "tool",
          id: `plan-${turnId}`,
          parentToolId: null,
          name: "todo_list",
          input: { items: steps.map((s) => ({ text: asString(s.step) ?? "", completed: s.status === "completed" })) },
          status: steps.length > 0 && steps.every((s) => s.status === "completed") ? "ok" : "running",
          output: null,
        }
        codexPlans.set(turnId, item)
        return [item]
      }
      case "error": {
        // A retried error is not the turn's outcome.
        if (params.willRetry === true) return []
        const text = isRecord(params.error) ? (asString(params.error.message) ?? "codex error") : "codex error"
        codexLastError = text
        return [{ _tag: "error", id: nextId(), text }]
      }
      case "turn/completed":
        return codexTurnEnd(params)
      default:
        return []
    }
  }

  return {
    push: (line) => {
      if (!isRecord(line)) return []
      const type = asString(line.type)
      if (type !== null && CLAUDE_LINE_TYPES[type] === true) return claude(line)
      // Codex app-server speaks JSON-RPC 2.0 without the `jsonrpc` field: `method` and/or `id`.
      if (typeof line.method === "string" || line.id !== undefined) return codex(line)
      return []
    },
    finalText: () => finalTextValue,
    context: () => contextValue,
  }
}
