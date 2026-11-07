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

/** A response's token buckets: fresh prompt input (cache writes included), completion, and cache reads. */
interface ResponseUsage {
  readonly id: string
  readonly parentToolId: string | null
  inputTokens: number | null
  outputTokens: number | null
  cachedTokens: number | null
  timestamp: string | null
  /** Epoch milliseconds the response began (its `message_start`), once observed. */
  startMs: number | null
  /** That start came from a provider event time, not the box's clock. */
  startFromEvent: boolean
  /** Epoch milliseconds of its latest completion report while the stream is open; frozen after its stop. */
  endMs: number | null
  /** That end came from a provider event time, not the box's clock: an untimed report cannot move it. */
  endFromEvent: boolean
  /** Elapsed milliseconds from that start to that end; null while either is unknown. */
  durationMs: number | null
  emitted: boolean
  /** A stream for this response is open (`message_start` without its `message_stop` yet). */
  active: boolean
  /** The stream's stop arrived: duplicate completions after it cannot move the response's end. */
  stopped: boolean
}

/** Epoch milliseconds of a provider event: its `emittedAtMs` or `timestamp`, when valid. */
const eventMillis = (...events: ReadonlyArray<unknown>): number | null => {
  for (const event of events) {
    if (!isRecord(event)) continue
    const milliseconds = asNumber(event.emittedAtMs)
    if (milliseconds !== null && milliseconds > 0 && Math.abs(milliseconds) <= 8.64e15) {
      if (!Number.isNaN(new Date(milliseconds).getTime())) return milliseconds
    }
    const text = asString(event.timestamp)
    if (text !== null) {
      const parsed = new Date(text).getTime()
      if (!Number.isNaN(parsed)) return parsed
    }
  }
  return null
}

/** ISO time of a provider event, when valid. */
const eventTime = (...events: ReadonlyArray<unknown>): string | null => {
  const milliseconds = eventMillis(...events)
  return milliseconds === null ? null : new Date(milliseconds).toISOString()
}

/** The usage item for a response, using the time it was first seen finished when the provider gave none. */
const usageItem = (state: ResponseUsage): AgentItem => ({
  _tag: "usage",
  id: state.id,
  parentToolId: state.parentToolId,
  timestamp: state.timestamp ?? new Date().toISOString(),
  durationMs: state.durationMs,
  inputTokens: state.inputTokens,
  outputTokens: state.outputTokens,
  cachedTokens: state.cachedTokens,
})

/** How assistant prose reaches the app: at the end of a turn, or once each paragraph or code block is complete. */
export type ResponseStreamingMode = "turn" | "paragraph"

/**
 * The part of `text` whose paragraphs and fenced code blocks have ended. A blank line ends a paragraph only outside a
 * fence; a fence ends at its closing marker's newline. Nothing is complete until the text says so, which keeps an
 * unfinished code block from showing half-written.
 */
export const completedProsePrefix = (text: string): string => {
  let inFence = false
  let fence = ""
  let complete = 0
  let hasContent = false
  let pos = 0
  while (pos < text.length) {
    const newline = text.indexOf("\n", pos)
    const end = newline === -1 ? text.length : newline
    const line = text.slice(pos, end)
    const trimmed = line.trimStart()
    const marker = trimmed.startsWith("```") ? "```" : trimmed.startsWith("~~~") ? "~~~" : null
    if (marker !== null) {
      if (!inFence) {
        inFence = true
        fence = marker
        hasContent = true
      } else if (marker === fence && newline !== -1) {
        inFence = false
        fence = ""
        complete = newline + 1
        hasContent = false
      }
    } else if (inFence) {
      // A blank line inside a fence is code, not the end of prose.
    } else if (line.trim() === "") {
      if (hasContent && newline !== -1) {
        complete = newline + 1
        hasContent = false
      }
    } else {
      hasContent = true
    }
    if (newline === -1) break
    pos = newline + 1
  }
  return text.slice(0, complete)
}

/**
 * `seed` is the context the thread's session last reported; a run that resumes the same session on the same model
 * reuses its window, so its context updates from the first model call rather than only at the result. `saveImage`
 * keeps the images tool results return; without it they stay `[image]` lines in the output. `streaming` changes only
 * when main-agent prose becomes visible; tool, thinking and subagent items are untouched.
 */
export const makeTranscript = (
  seed: ContextUsage | null = null,
  saveImage: SaveImage | null = null,
  streaming: ResponseStreamingMode | null = null,
): Transcript => {
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
  /**
   * Per-response usage already reported, by thread and turn. The thread's cumulative `total` identifies a new model
   * call; `last` alone does not, because two calls can have identical usage. A repeated total is the same response.
   */
  const codexResponseUsage = new Map<string, { readonly seen: Set<string>; count: number }>()
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

  /**
   * Per-response usage by Claude message id. Every printed block of one API message repeats its usage, and a
   * stream's `message_delta` reports the final output after the assistant snapshot, so an item is updated under
   * the first id it showed under rather than added again.
   */
  const claudeResponseUsage = new Map<string, ResponseUsage>()

  /** A message id is unique per context; the context keeps a subagent's response apart from the main agent's. */
  const claudeUsageKey = (messageId: string, parentToolId: string | null): string => `${parentToolId ?? ""}\u0000${messageId}`

  const claudeUsageState = (messageId: string | null, parentToolId: string | null): ResponseUsage => {
    const key = messageId === null ? null : claudeUsageKey(messageId, parentToolId)
    const known = key === null ? undefined : claudeResponseUsage.get(key)
    if (known !== undefined) return known
    const state: ResponseUsage = {
      id: messageId === null ? `usage-${nextId()}` : `usage-${messageId}`,
      parentToolId,
      inputTokens: null,
      outputTokens: null,
      cachedTokens: null,
      timestamp: null,
      startMs: null,
      startFromEvent: false,
      endMs: null,
      endFromEvent: false,
      durationMs: null,
      emitted: false,
      active: false,
      stopped: false,
    }
    claudeResponseUsage.set(key ?? state.id, state)
    return state
  }

  /**
   * Records a completion report: its time (the event's time, or now when it gave none) and, once both boundaries
   * are known, the response's elapsed time. A response reports completion more than once — its assistant snapshot,
   * then `message_delta` with the final output — so the end follows the latest report. After `message_stop` the
   * response is closed and repeated reports cannot move it.
   */
  const completeClaudeResponse = (state: ResponseUsage, atMs: number | null) => {
    if (state.stopped) return
    if (atMs !== null) {
      // A provider event time is authoritative; a later event always advances the end.
      state.endMs = state.endMs === null ? atMs : Math.max(state.endMs, atMs)
      state.endFromEvent = true
    } else if (state.endMs === null || !state.endFromEvent) {
      // Otherwise the box's own clock; it advances only a turn of observed times, never a provider's.
      state.endMs = state.endMs === null ? Date.now() : Math.max(state.endMs, Date.now())
    }
    state.timestamp = new Date(state.endMs).toISOString()
    // Only one clock can measure an interval: a provider time and the box's own clock are not comparable.
    if (state.startMs !== null && state.startFromEvent === state.endFromEvent) {
      state.durationMs = Math.max(0, Math.round(state.endMs - state.startMs))
    }
  }

  /** Merge the buckets a Claude event reports; a missing bucket leaves the value already known. */
  const recordClaudeUsage = (state: ResponseUsage, usage: Record<string, unknown>, completedAtMs?: number | null) => {
    // Cache writes were read by the model too, so they are prompt input; cache reads stay their own bucket.
    const inputTokens = sumTokens([asNumber(usage.input_tokens), asNumber(usage.cache_creation_input_tokens)])
    const outputTokens = asNumber(usage.output_tokens)
    const cachedTokens = asNumber(usage.cache_read_input_tokens)
    if (inputTokens !== null) state.inputTokens = inputTokens
    // Output only grows within a response; a delayed snapshot must not replace message_delta's final count.
    if (outputTokens !== null) {
      state.outputTokens = state.emitted && state.outputTokens !== null ? Math.max(state.outputTokens, outputTokens) : outputTokens
    }
    if (cachedTokens !== null) state.cachedTokens = cachedTokens
    if (completedAtMs !== undefined) completeClaudeResponse(state, completedAtMs)
  }

  /** The response's item once anything is known. It keeps its id, so a later report replaces it in place. */
  const emitClaudeUsage = (state: ResponseUsage): AgentItem | null => {
    if (state.inputTokens === null && state.outputTokens === null && state.cachedTokens === null) return null
    state.emitted = true
    if (state.timestamp === null) state.timestamp = new Date().toISOString()
    return usageItem(state)
  }

  /**
   * Responses whose usage was held until their content finished. An open stream is left alone: its own
   * `message_delta`/`message_stop` completes it, which keeps concurrent subagent streams from surfacing early.
   */
  const flushClaudeUsage = (keepKey?: string, force = false): AgentItem[] => {
    const items: AgentItem[] = []
    for (const [key, state] of claudeResponseUsage) {
      if (key === keepKey || state.emitted || (!force && state.active)) continue
      const item = emitClaudeUsage(state)
      if (item !== null) items.push(item)
    }
    return items
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
    const messageUsage = isRecord(line.message.usage) ? line.message.usage : null
    // Subagents run in contexts of their own; only the main agent's calls fill the session.
    const usage = parentToolId === null ? messageUsage : null
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
    // A block that streamed in keeps the id it was shown under; the next streamed block of the same kind is this one.
    const messageId = asString(line.message.id)
    const items: AgentItem[] = flushClaudeUsage(messageId === null ? undefined : claudeUsageKey(messageId, parentToolId))
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
    if (messageUsage !== null) {
      const state = claudeUsageState(messageId, parentToolId)
      // This line finished a message (or is one of its blocks), so a provider event time means completion.
      recordClaudeUsage(state, messageUsage, eventMillis(line))
      // A stream already showed the response; its snapshot takes the same item, updating output (or vice versa).
      // Without an id there is nothing to deduplicate against, so the usage shows at once.
      if (state.emitted || messageId === null) {
        const item = emitClaudeUsage(state)
        if (item !== null) items.push(item)
      }
    }
    return items
  }

  const claudeUser = (line: Record<string, unknown>): ReadonlyArray<AgentItem> => {
    if (!isRecord(line.message)) return []
    // A tool result answers a response that has finished, so its held usage shows before the result.
    const items: AgentItem[] = flushClaudeUsage()
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
    // The run's result closes every response still held, including a stream whose stop line was lost.
    const items: AgentItem[] = [
      ...flushClaudeUsage(undefined, true),
      {
        _tag: "turn",
        id: nextId(),
        timestamp: eventTime(line) ?? new Date().toISOString(),
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
        // A new response beginning says nothing about another stream still open; only finished held usage shows.
        const items = flushClaudeUsage(id === null ? undefined : claudeUsageKey(id, parentToolId))
        if (id !== null) {
          claudeStreaming.set(parentToolId, id)
          const state = claudeUsageState(id, parentToolId)
          state.active = true
          // The response begins here: its elapsed time runs from this boundary to its latest completion report.
          // A replayed start does not move it.
          if (state.startMs === null) {
            const eventStart = eventMillis(line, event)
            state.startMs = eventStart ?? Date.now()
            state.startFromEvent = eventStart !== null
          }
          // Its input and cache reads are known now; output is not final until message_delta.
          if (isRecord(event.message) && isRecord(event.message.usage)) recordClaudeUsage(state, event.message.usage)
        }
        return items
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
      case "message_delta": {
        const id = claudeStreaming.get(parentToolId) ?? asString(line.api_message_id)
        if (id === null) return []
        const state = claudeUsageState(id, parentToolId)
        // The final output arrives after the assistant snapshot; the same item is updated, not added again.
        if (isRecord(event.usage)) recordClaudeUsage(state, event.usage, eventMillis(line, event))
        else completeClaudeResponse(state, eventMillis(line, event))
        const item = emitClaudeUsage(state)
        return item === null ? [] : [item]
      }
      case "message_stop": {
        const id = claudeStreaming.get(parentToolId) ?? asString(line.api_message_id)
        const state = id === null ? undefined : claudeResponseUsage.get(claudeUsageKey(id, parentToolId))
        if (state !== undefined) {
          state.active = false
          // The stop closes the response. It supplies an end only when no completion report did.
          if (state.endMs === null) completeClaudeResponse(state, eventMillis(line, event))
          state.stopped = true
        }
        const item = state === undefined || state.emitted ? null : emitClaudeUsage(state)
        if (id !== null) claudeStreaming.delete(parentToolId)
        return item === null ? [] : [item]
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

  const codexTurnEnd = (line: Record<string, unknown>, params: Record<string, unknown>): ReadonlyArray<AgentItem> => {
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
      timestamp: eventTime(line) ?? new Date().toISOString(),
      durationMs: asNumber(turn.durationMs),
      // Codex's inputTokens already includes cachedInputTokens; adding them again would double-count the prompt.
      inputTokens: tokens === undefined ? null : tokens.input - tokens.baseInput,
      outputTokens: tokens === undefined ? null : tokens.output - tokens.baseOutput,
      costUsd: null,
      isError: failed,
    })
    return items
  }

  /** One model call's usage from Codex's `last`: input already includes cache reads, so they are subtracted. */
  const codexUsageItem = (
    threadId: string | null,
    turnId: string | null,
    count: number,
    last: Record<string, unknown>,
    line: Record<string, unknown>,
  ): AgentItem | null => {
    const lastInput = asNumber(last.inputTokens)
    const cachedTokens = asNumber(last.cachedInputTokens)
    // Without both, the fresh prompt count is unknown; reporting the cached-inclusive input would overstate it.
    const inputTokens = lastInput === null || cachedTokens === null ? null : Math.max(0, lastInput - cachedTokens)
    const outputTokens = asNumber(last.outputTokens)
    if (inputTokens === null && outputTokens === null && cachedTokens === null) return null
    return {
      _tag: "usage",
      id: `usage-codex-${threadId ?? "thread"}-${turnId ?? "turn"}-${count}`,
      parentToolId: null,
      timestamp: eventTime(line) ?? new Date().toISOString(),
      // Codex reports token totals, not where a model call began or ended, so its elapsed time stays unknown.
      durationMs: null,
      inputTokens,
      outputTokens,
      cachedTokens,
    }
  }

  const codexTokenUsage = (line: Record<string, unknown>, params: Record<string, unknown>): ReadonlyArray<AgentItem> => {
    const usage = isRecord(params.tokenUsage) ? params.tokenUsage : null
    const total = usage !== null && isRecord(usage.total) ? usage.total : null
    const last = usage !== null && isRecord(usage.last) ? usage.last : null
    const turnId = asString(params.turnId)
    if (total === null || last === null) return []
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

    const threadId = asString(params.threadId)
    const totalKey = [asNumber(total.inputTokens), asNumber(total.cachedInputTokens), asNumber(total.outputTokens)]
      .map((count) => (count === null ? "?" : String(count)))
      .join(":")
    const responseKey = `${threadId ?? ""}\u0000${turnId ?? ""}`
    const known = codexResponseUsage.get(responseKey) ?? { seen: new Set<string>(), count: 0 }
    codexResponseUsage.set(responseKey, known)
    // A repeated cumulative total is the same model call, even when another call had the same `last` counts.
    if (known.seen.has(totalKey)) return []
    known.seen.add(totalKey)
    known.count += 1
    const item = codexUsageItem(threadId, turnId, known.count, last, line)
    return item === null ? [] : [item]
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
        return codexTokenUsage(line, params)
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
        return codexTurnEnd(line, params)
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
  const acpResult = (line: Record<string, unknown>, result: Record<string, unknown>): ReadonlyArray<AgentItem> => {
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
      timestamp: eventTime(line) ?? new Date().toISOString(),
      durationMs: null,
      inputTokens: usage === null ? null : sumTokens([asNumber(usage.inputTokens), asNumber(usage.cachedReadTokens), asNumber(usage.cachedWriteTokens)]),
      outputTokens: usage === null ? null : asNumber(usage.outputTokens),
      costUsd: null,
      isError: stopReason === "refusal",
    })
    return items
  }

  const parse = (line: unknown): ReadonlyArray<AgentItem> => {
    if (!isRecord(line)) return []
    const type = asString(line.type)
    if (type !== null && CLAUDE_LINE_TYPES[type] === true) return claude(line)
    // ACP speaks JSON-RPC 2.0 with its `jsonrpc` field: the agent's work in `session/update`, a turn's end in the
    // `session/prompt` response.
    if (line.jsonrpc === "2.0") {
      if (line.method === "session/update" && isRecord(line.params)) return acpUpdate(line.params)
      return isRecord(line.result) ? acpResult(line, line.result) : []
    }
    // Codex app-server speaks JSON-RPC 2.0 without the `jsonrpc` field: `method` and/or `id`.
    if (typeof line.method === "string" || line.id !== undefined) return codex(line)
    return []
  }

  if (streaming === null) {
    return {
      push: parse,
      finalText: () => finalTextValue,
      context: () => contextValue,
      takeContext: () => {
        if (!contextChanged) return undefined
        contextChanged = false
        return contextValue
      },
    }
  }

  /**
   * Main-agent prose waiting for its moment. In `turn` mode one text item is held for the whole turn; in `paragraph`
   * mode each text item is shown up to its last completed paragraph or fence. A `turn` or `usage` item flushes what
   * precedes it, so usage never shows above the response it belongs to.
   */
  const turnProse = new Map<string, string>()
  const turnOrder: string[] = []
  const paragraphs = new Map<string, { text: string; shown: number }>()
  const paragraphOrder: string[] = []
  const flushProse = (): AgentItem[] => {
    const items: AgentItem[] = []
    if (streaming === "turn") {
      // A final assistant line replaces the deltas of the same message, so the last text for an id wins.
      const parts = turnOrder
        .map((id) => turnProse.get(id)?.trim() ?? "")
        .filter((text) => text !== "")
      const text = parts.join("\n\n")
      const id = turnOrder.at(-1)
      if (text !== "" && id !== undefined) items.push({ _tag: "text", id, parentToolId: null, text })
      turnProse.clear()
      turnOrder.length = 0
      return items
    }
    for (const id of paragraphOrder) {
      const prose = paragraphs.get(id)
      if (prose === undefined) continue
      const text = prose.text.trim()
      if (text !== "" && prose.shown < prose.text.length) items.push({ _tag: "text", id, parentToolId: null, text: prose.text })
    }
    paragraphs.clear()
    paragraphOrder.length = 0
    return items
  }
  const visible = (line: unknown): ReadonlyArray<AgentItem> => {
    // A finished assistant message is a complete paragraph even without a blank line after it. Only streamed deltas
    // wait for a paragraph or fence boundary.
    const finishedMessage =
      isRecord(line) &&
      (line.type === "assistant" ||
        (line.method === "item/completed" &&
          isRecord(line.params) &&
          isRecord(line.params.item) &&
          line.params.item.type === "agentMessage"))
    const items: AgentItem[] = []
    for (const item of parse(line)) {
      if (item._tag === "text" && item.parentToolId === null) {
        if (streaming === "turn") {
          if (!turnProse.has(item.id)) turnOrder.push(item.id)
          turnProse.set(item.id, item.text)
          continue
        }
        const prose = paragraphs.get(item.id) ?? { text: "", shown: 0 }
        if (!paragraphs.has(item.id)) paragraphOrder.push(item.id)
        prose.text = item.text
        paragraphs.set(item.id, prose)
        const complete = finishedMessage ? item.text : completedProsePrefix(item.text)
        if (complete.length > prose.shown) {
          prose.shown = complete.length
          const text = complete.trimEnd()
          if (text !== "") items.push({ ...item, text })
        }
        continue
      }
      // Usage follows the response's prose: held main-agent text shows first, without the turn itself ending.
      // A subagent's usage does not release prose the main agent is still holding.
      if (item._tag === "turn" || (item._tag === "usage" && item.parentToolId === null)) items.push(...flushProse())
      items.push(item)
    }
    return items
  }

  return {
    push: visible,
    finalText: () => finalTextValue,
    context: () => contextValue,
    takeContext: () => {
      if (!contextChanged) return undefined
      contextChanged = false
      return contextValue
    },
  }
}
