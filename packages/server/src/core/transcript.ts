import type { AgentItem, Attachment, ContextUsage } from "@cloudagents/protocol"

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
  /**
   * The context change since the previous call: the new use, null after a compaction dropped the old one, or
   * undefined when nothing changed. Consumers that store the context (the harness) read this, so a drop is seen too.
   */
  readonly takeContext: () => ContextUsage | null | undefined
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

/** Stores one base64 image a tool returned; null when it cannot be kept (unknown type, too large). */
export type SaveImage = (base64: string, mimeType: string) => Attachment | null

/**
 * A tool result's content: its text, and the images `save` kept. An image that was not kept stays an `[image]` line,
 * so the text still says one was there. Claude puts an image's bytes in `source`; MCP (Codex) puts them on the block.
 */
const toolResult = (content: unknown, save: SaveImage | null): { output: string; images: Attachment[] } => {
  if (typeof content === "string") return { output: content, images: [] }
  const parts: string[] = []
  const images: Attachment[] = []
  for (const part of asArray(content)) {
    if (typeof part === "string") {
      parts.push(part)
      continue
    }
    if (!isRecord(part)) continue
    const kind = asString(part.type)
    if (kind === "text") parts.push(asString(part.text) ?? "")
    else if (kind === "image") {
      const source = isRecord(part.source) ? part.source : part
      const data = asString(source.data)
      const mimeType = asString(source.media_type) ?? asString(source.mimeType)
      const kept = save !== null && data !== null && mimeType !== null ? save(data, mimeType) : null
      if (kept === null) parts.push("[image]")
      else images.push(kept)
    } else parts.push(`[${kind ?? "unknown"}]`)
  }
  return { output: parts.join("\n"), images }
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
 * reuses its window, so its context updates from the first model call rather than only at the result. `saveImage`
 * keeps the images tool results return; without it they stay `[image]` lines in the output.
 */
export const makeTranscript = (seed: ContextUsage | null = null, saveImage: SaveImage | null = null): Transcript => {
  /**
   * Ids for items the harness does not name. Unique per run: the same id later means
   * "replace that item", so counter ids are never reused.
   */
  let counter = 0
  const nextId = (): string => `c${++counter}`

  let finalTextValue: string | null = null
  /** Last completed main-agent message, for Claude results that omit their optional `result` text. */
  let claudeLastText: { readonly messageId: string | null; readonly text: string } | null = null
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
  /** Last top-level Codex error and its turn, so only that turn's end does not repeat it. */
  let codexLastError: { readonly turnId: string | null; readonly text: string } | null = null
  /** Claude session model (from `init`), its context window, and the main agent's latest prompt + reply size. */
  let model: string | null = null
  let windowTokens: number | null = null
  let usedTokens: number | null = null
  let contextValue: ContextUsage | null = null
  /** Set when `contextValue` changed since `takeContext` last read it, including a drop to null. */
  let contextChanged = false
  /**
   * Claude text and thinking blocks streaming in (`--include-partial-messages`), by API message id, in block order,
   * with the item id each one shows under. The finished block's `assistant` line takes over that id.
   */
  const claudeStreams = new Map<string, Array<{ readonly kind: "text" | "thinking"; readonly index: number; readonly id: string; text: string }>>()
  /** The API message each context is streaming: the main agent (null) or a subagent (its Task call id). */
  const claudeStreaming = new Map<string | null, string>()
  /** Set by Claude Code's "[Request interrupted by user]" note, for the result that closes that turn. */
  let claudeInterrupted = false

  const refreshContext = () => {
    if (usedTokens === null || windowTokens === null) return
    if (contextValue?.model === model && contextValue.usedTokens === usedTokens && contextValue.windowTokens === windowTokens) {
      return
    }
    contextValue = { model, usedTokens, windowTokens }
    contextChanged = true
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
        contextValue = null
        contextChanged = true
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
    // A block that streamed in keeps the id it was shown under; the next streamed block of the same kind is this one.
    const messageId = asString(line.message.id)
    const streamed = messageId === null ? undefined : claudeStreams.get(messageId)
    const idFor = (kind: "text" | "thinking"): string => {
      const at = streamed?.findIndex((block) => block.kind === kind) ?? -1
      if (at === -1 || streamed === undefined) return nextId()
      const [block] = streamed.splice(at, 1)
      if (streamed.length === 0 && messageId !== null) claudeStreams.delete(messageId)
      return block?.id ?? nextId()
    }
    for (const block of asArray(line.message.content)) {
      if (!isRecord(block)) continue
      const kind = asString(block.type)
      if (kind === "text") {
        const id = idFor("text")
        const text = asString(block.text)
        if (text === null || text.trim() === "") continue
        items.push({ _tag: "text", id, parentToolId, text })
        if (parentToolId === null) {
          const previous = messageId !== null && claudeLastText?.messageId === messageId ? claudeLastText.text : null
          claudeLastText = { messageId, text: previous === null ? text : `${previous}\n\n${text}` }
          finalTextValue = claudeLastText.text
        }
      } else if (kind === "thinking") {
        const id = idFor("thinking")
        const text = asString(block.thinking)
        if (text === null || text.trim() === "") continue
        items.push({ _tag: "thinking", id, parentToolId, text })
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
      // Claude Code records an interrupt as a user text; the turn's result that follows is an error only by name.
      if (isRecord(block) && block.type === "text" && asString(block.text)?.startsWith("[Request interrupted by user") === true) {
        claudeInterrupted = true
        continue
      }
      if (!isRecord(block) || block.type !== "tool_result") continue
      const id = asString(block.tool_use_id)
      if (id === null) continue
      const call = tools.get(id)
      const { output, images } = toolResult(block.content, saveImage)
      items.push({
        _tag: "tool",
        id,
        // A result inside a subagent carries the Task call it belongs to.
        parentToolId: call?.parentToolId ?? asString(line.parent_tool_use_id),
        name: call?.name ?? "tool",
        input: call?.input ?? null,
        status: block.is_error === true ? "error" : "ok",
        output,
        ...(images.length > 0 ? { images } : {}),
      })
    }
    return items
  }

  const claudeResult = (line: Record<string, unknown>): ReadonlyArray<AgentItem> => {
    const subtype = asString(line.subtype) ?? "result"
    // A turn stopped on purpose ends without being an error.
    const isError = line.is_error === true && !claudeInterrupted
    claudeInterrupted = false
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

  /** One `stream_event` line: a text or thinking block growing by a delta. Tool input is shown once the call is made. */
  const claudeStream = (line: Record<string, unknown>): ReadonlyArray<AgentItem> => {
    const event = isRecord(line.event) ? line.event : null
    if (event === null) return []
    const parentToolId = asString(line.parent_tool_use_id)
    switch (asString(event.type)) {
      case "message_start": {
        const id = isRecord(event.message) ? asString(event.message.id) : null
        if (id !== null) claudeStreaming.set(parentToolId, id)
        return []
      }
      case "content_block_start": {
        const messageId = claudeStreaming.get(parentToolId)
        const kind = isRecord(event.content_block) ? asString(event.content_block.type) : null
        const index = asNumber(event.index)
        if (messageId === undefined || index === null || (kind !== "text" && kind !== "thinking")) return []
        const blocks = claudeStreams.get(messageId) ?? []
        blocks.push({ kind, index, id: nextId(), text: "" })
        claudeStreams.set(messageId, blocks)
        return []
      }
      case "content_block_delta": {
        const messageId = claudeStreaming.get(parentToolId)
        const delta = isRecord(event.delta) ? event.delta : null
        const block = messageId === undefined ? undefined : claudeStreams.get(messageId)?.find((b) => b.index === event.index)
        if (block === undefined || delta === null) return []
        const piece = block.kind === "text" ? asString(delta.text) : asString(delta.thinking)
        if (piece === null) return []
        block.text += piece
        if (block.text.trim() === "") return []
        return [{ _tag: block.kind, id: block.id, parentToolId, text: block.text }]
      }
      default:
        return []
    }
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
      case "stream_event":
        return claudeStream(line)
      default:
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
        const result = isRecord(raw.result) && !failed ? toolResult(raw.result.content, saveImage) : null
        return {
          _tag: "tool",
          id,
          parentToolId: null,
          name: `${server}.${tool}`,
          input: raw.arguments ?? null,
          status: running ? "running" : failed ? "error" : "ok",
          output: failed ? error : (result?.output ?? null),
          ...(result !== null && result.images.length > 0 ? { images: result.images } : {}),
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
    // The notification that precedes a turn's end is that turn's error; a turn of its own still reports it.
    const last = codexLastError
    const belongsHere = last !== null && (last.turnId === null || last.turnId === turnId)
    const reported = failed && last !== null && belongsHere && (error === null || error === last.text)
    if (belongsHere) codexLastError = null
    if (failed && !reported) items.push({ _tag: "error", id: nextId(), text: error ?? "codex turn failed" })
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
        codexLastError = { turnId: asString(params.turnId), text }
        return [{ _tag: "error", id: nextId(), text }]
      }
      case "turn/completed":
        return codexTurnEnd(params)
      default:
        return []
    }
  }

  /** ACP message and thought text, by item id, built up from chunks. */
  const acpText = new Map<string, string>()
  /** The chunk stream a message without an id belongs to; a tool call or a switch of kind starts the next one. */
  let acpOpen: { readonly kind: "text" | "thinking"; readonly id: string } | null = null
  /** ACP tool calls of the turn, by tool call id: each update merges into what the call reported before. */
  const acpTools = new Map<string, AgentItem & { _tag: "tool" }>()
  /** What each ACP tool call reported about itself: the name it first gave (later titles describe the call), its kind, its input. */
  const acpCalls = new Map<string, { readonly name: string; kind: string | null; input: Record<string, unknown> | null }>()
  /** Turns seen, so each turn's plan has an item of its own. */
  let acpTurn = 0

  /** A tool call's content as output text and the images `saveImage` kept: text blocks, diffs, embedded resources. */
  const acpToolContent = (content: unknown): { output: string | null; images: Attachment[] } => {
    const parts: string[] = []
    const images: Attachment[] = []
    for (const entry of asArray(content)) {
      if (!isRecord(entry)) continue
      if (entry.type === "diff") {
        parts.push(`${asString(entry.path) ?? "file"}: edited`)
        continue
      }
      const block = isRecord(entry.content) ? entry.content : null
      if (block === null) continue
      if (block.type === "text" && typeof block.text === "string") parts.push(block.text)
      else if (block.type === "image" && typeof block.data === "string" && typeof block.mimeType === "string") {
        const kept = saveImage?.(block.data, block.mimeType) ?? null
        if (kept === null) parts.push("[image]")
        else images.push(kept)
      } else if (block.type === "resource" && isRecord(block.resource) && typeof block.resource.text === "string") {
        parts.push(block.resource.text)
      }
    }
    return { output: parts.length === 0 ? null : parts.join("\n"), images }
  }

  /**
   * A shell command, file read or file write under the tool names every harness's calls render with; any other call
   * keeps its own name and input.
   */
  const acpDisplay = (name: string, kind: string | null, input: Record<string, unknown> | null): { name: string; input: unknown } => {
    const command = input === null ? null : asString(input.command)
    const path = input === null ? null : (asString(input.path) ?? asString(input.filePath))
    if (kind === "execute" && command !== null) return { name: "command_execution", input: { command } }
    if (kind === "read" && path !== null) return { name: "Read", input: { file_path: path } }
    if (kind === "edit" && name === "write" && path !== null && typeof input?.content === "string") {
      return { name: "Write", input: { file_path: path, content: input.content } }
    }
    return { name, input }
  }

  const acpChunk = (kind: "text" | "thinking", update: Record<string, unknown>): ReadonlyArray<AgentItem> => {
    const content = isRecord(update.content) ? update.content : null
    const delta = content !== null && content.type === "text" ? asString(content.text) : null
    if (delta === null) return []
    const messageId = asString(update.messageId)
    let id = `${kind}-${messageId}`
    if (messageId === null) {
      if (acpOpen?.kind !== kind) acpOpen = { kind, id: nextId() }
      id = acpOpen.id
    }
    const text = (acpText.get(id) ?? "") + delta
    acpText.set(id, text)
    if (text.trim() === "") return []
    if (kind === "text") finalTextValue = text
    return [{ _tag: kind, id, parentToolId: null, text }]
  }

  const acpTool = (update: Record<string, unknown>): ReadonlyArray<AgentItem> => {
    const id = asString(update.toolCallId)
    if (id === null) return []
    acpOpen = null
    const known = acpTools.get(id)
    const rawInput = isRecord(update.rawInput) && Object.keys(update.rawInput).length > 0 ? update.rawInput : null
    const call = acpCalls.get(id) ?? {
      name: asString(update.title) ?? asString(update.kind) ?? "tool",
      kind: asString(update.kind),
      input: null,
    }
    if (rawInput !== null) call.input = rawInput
    call.kind = asString(update.kind) ?? call.kind
    acpCalls.set(id, call)
    const status = asString(update.status)
    const content = update.content === undefined ? null : acpToolContent(update.content)
    const item: AgentItem & { _tag: "tool" } = {
      _tag: "tool",
      id,
      parentToolId: null,
      ...acpDisplay(call.name, call.kind, call.input),
      status: status === "completed" ? "ok" : status === "failed" ? "error" : status === null ? (known?.status ?? "running") : "running",
      output: content?.output ?? known?.output ?? null,
      ...(content !== null && content.images.length > 0 ? { images: content.images } : known?.images ? { images: known.images } : {}),
    }
    acpTools.set(id, item)
    return [item]
  }

  /** One `session/update` notification. */
  const acpUpdate = (params: Record<string, unknown>): ReadonlyArray<AgentItem> => {
    const update = isRecord(params.update) ? params.update : null
    if (update === null) return []
    switch (asString(update.sessionUpdate)) {
      case "agent_message_chunk":
        return acpChunk("text", update)
      case "agent_thought_chunk":
        return acpChunk("thinking", update)
      case "tool_call":
      case "tool_call_update":
        return acpTool(update)
      case "plan": {
        const entries = asArray(update.entries).filter(isRecord)
        return [{
          _tag: "tool",
          id: `plan-acp-${acpTurn}`,
          parentToolId: null,
          name: "todo_list",
          input: { items: entries.map((e) => ({ text: asString(e.content) ?? "", completed: e.status === "completed" })) },
          status: entries.length > 0 && entries.every((e) => e.status === "completed") ? "ok" : "running",
          output: null,
        }]
      }
      case "usage_update":
        // The session's size against its model's window, as the composer's context bar shows it.
        usedTokens = asNumber(update.used)
        windowTokens = asNumber(update.size)
        refreshContext()
        return []
      default:
        // The user's own message, commands on offer, session titles and the rest add nothing.
        return []
    }
  }

  /** A response from the agent: the session's model from its config options, and the end of a turn (`session/prompt`). */
  const acpResult = (result: Record<string, unknown>): ReadonlyArray<AgentItem> => {
    const modelOption = asArray(result.configOptions).find((o) => isRecord(o) && o.id === "model")
    if (isRecord(modelOption) && typeof modelOption.currentValue === "string") {
      model = modelOption.currentValue
      refreshContext()
    }
    const stopReason = asString(result.stopReason)
    if (stopReason === null) return []
    acpTurn++
    acpOpen = null
    // What the turn left running ends with it, unfinished.
    const items: AgentItem[] = [...acpTools.values()].filter((t) => t.status === "running").map((t) => ({ ...t, status: "error" as const }))
    acpTools.clear()
    acpCalls.clear()
    const usage = isRecord(result.usage) ? result.usage : null
    items.push({
      _tag: "turn",
      id: nextId(),
      durationMs: null,
      inputTokens: usage === null ? null : sumTokens([asNumber(usage.inputTokens), asNumber(usage.cachedReadTokens), asNumber(usage.cachedWriteTokens)]),
      outputTokens: usage === null ? null : asNumber(usage.outputTokens),
      costUsd: null,
      isError: stopReason === "refusal",
    })
    return items
  }

  return {
    push: (line) => {
      if (!isRecord(line)) return []
      const type = asString(line.type)
      if (type !== null && CLAUDE_LINE_TYPES[type] === true) return claude(line)
      // ACP speaks JSON-RPC 2.0 with its `jsonrpc` field: the agent's work in `session/update`, a turn's end in the
      // `session/prompt` response.
      if (line.jsonrpc === "2.0") {
        if (line.method === "session/update" && isRecord(line.params)) return acpUpdate(line.params)
        return isRecord(line.result) ? acpResult(line.result) : []
      }
      // Codex app-server speaks JSON-RPC 2.0 without the `jsonrpc` field: `method` and/or `id`.
      if (typeof line.method === "string" || line.id !== undefined) return codex(line)
      return []
    },
    finalText: () => finalTextValue,
    context: () => contextValue,
    takeContext: () => {
      if (!contextChanged) return undefined
      contextChanged = false
      return contextValue
    },
  }
}
