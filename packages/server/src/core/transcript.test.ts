import { describe, expect, test } from "bun:test"
import { Schema } from "effect"
import { AgentItem } from "@cloudagents/protocol"
import { makeTranscript } from "./transcript"

/** Every item a parser reports must be a valid AgentItem (it crosses the WebSocket boundary). */
const valid = (items: ReadonlyArray<AgentItem>): ReadonlyArray<AgentItem> => {
  for (const item of items) Schema.decodeUnknownSync(AgentItem)(item)
  return items
}

const assistant = (content: ReadonlyArray<unknown>, parentToolUseId: string | null = null) => ({
  type: "assistant",
  message: { id: "msg_1", role: "assistant", content },
  parent_tool_use_id: parentToolUseId,
  uuid: "uuid-1",
})

const toolResult = (toolUseId: string, content: unknown, isError = false, parentToolUseId: string | null = null) => ({
  type: "user",
  message: { role: "user", content: [{ type: "tool_result", tool_use_id: toolUseId, content, is_error: isError }] },
  parent_tool_use_id: parentToolUseId,
  uuid: "uuid-2",
})

describe("claude stream-json", () => {
  test("tool_use starts a tool and tool_result completes the same item", () => {
    const transcript = makeTranscript()
    const started = valid(
      transcript.push({
        type: "assistant",
        message: {
          id: "msg_1",
          content: [{ type: "tool_use", id: "toolu_1", name: "Bash", input: { command: "ls" } }],
        },
        parent_tool_use_id: null,
        uuid: "uuid-1",
      }),
    )
    expect(started).toEqual([
      {
        _tag: "tool",
        id: "toolu_1",
        parentToolId: null,
        name: "Bash",
        input: { command: "ls" },
        status: "running",
        output: null,
      },
    ])

    const completed = valid(
      transcript.push(toolResult("toolu_1", [{ type: "text", text: "a.txt" }, { type: "image", source: {} }])),
    )
    expect(completed).toEqual([
      {
        _tag: "tool",
        id: "toolu_1",
        parentToolId: null,
        name: "Bash",
        input: { command: "ls" },
        status: "ok",
        output: "a.txt\n[image]",
      },
    ])

    const failed = valid(transcript.push(toolResult("toolu_1", "command failed", true)))
    expect(failed[0]).toMatchObject({ _tag: "tool", id: "toolu_1", status: "error", output: "command failed" })
  })

  test("content blocks printed on separate lines get distinct ids", () => {
    const transcript = makeTranscript()
    const first = valid(transcript.push(assistant([{ type: "text", text: "one" }])))
    const second = valid(
      transcript.push(assistant([{ type: "text", text: "two" }, { type: "thinking", thinking: "hmm" }])),
    )
    const ids = [...first, ...second].map((item) => item.id)
    expect(ids).toHaveLength(3)
    expect(new Set(ids).size).toBe(3)
    expect(second.map((item) => item._tag)).toEqual(["text", "thinking"])
  })

  test("result emits a turn item and the final text", () => {
    const transcript = makeTranscript()
    expect(
      valid(
        transcript.push({
          type: "result",
          subtype: "success",
          is_error: false,
          duration_ms: 1234,
          duration_api_ms: 1000,
          num_turns: 1,
          result: "all done",
          total_cost_usd: 0.25,
          usage: {
            input_tokens: 10,
            cache_creation_input_tokens: 5,
            cache_read_input_tokens: 20,
            output_tokens: 7,
          },
        }),
      ),
    ).toEqual([
      {
        _tag: "turn",
        id: expect.any(String),
        durationMs: 1234,
        inputTokens: 35,
        outputTokens: 7,
        costUsd: 0.25,
        isError: false,
      },
    ])
    expect(transcript.finalText()).toBe("all done")
  })

  test("an error result without text becomes an error item", () => {
    const transcript = makeTranscript()
    const items = valid(
      transcript.push({
        type: "result",
        subtype: "error_max_turns",
        is_error: true,
        duration_ms: 10,
        duration_api_ms: 5,
        num_turns: 3,
        total_cost_usd: 0.01,
        usage: { input_tokens: 1, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 0 },
      }),
    )
    expect(items).toHaveLength(2)
    expect(items[0]).toMatchObject({ _tag: "turn", isError: true })
    expect(items[1]).toEqual({ _tag: "error", id: expect.any(String), text: "claude result: error_max_turns" })
    expect(transcript.finalText()).toBeNull()
  })

  test("a turn stopped by an interrupt ends without an error, and the next failed turn is an error again", () => {
    const transcript = makeTranscript()
    transcript.push({ type: "user", message: { role: "user", content: [{ type: "text", text: "[Request interrupted by user]" }] } })
    expect(valid(transcript.push({ type: "result", subtype: "error_during_execution", is_error: true }))).toEqual([
      { _tag: "turn", id: expect.any(String), durationMs: null, inputTokens: null, outputTokens: null, costUsd: null, isError: false },
    ])
    const next = valid(transcript.push({ type: "result", subtype: "error_during_execution", is_error: true }))
    expect(next[0]).toMatchObject({ _tag: "turn", isError: true })
    expect(next[1]).toMatchObject({ _tag: "error", text: "claude result: error_during_execution" })
  })

  test("subagent blocks carry the parent tool id", () => {
    const transcript = makeTranscript()
    valid(
      transcript.push(
        assistant([{ type: "tool_use", id: "toolu_task", name: "Task", input: { description: "look" } }]),
      ),
    )
    const subTool = valid(
      transcript.push(assistant([{ type: "tool_use", id: "toolu_sub", name: "Read", input: { file_path: "a" } }], "toolu_task")),
    )
    expect(subTool[0]).toMatchObject({ _tag: "tool", id: "toolu_sub", parentToolId: "toolu_task" })

    const subResult = valid(transcript.push(toolResult("toolu_sub", "contents", false, "toolu_task")))
    expect(subResult[0]).toMatchObject({ id: "toolu_sub", parentToolId: "toolu_task", status: "ok" })
  })

  test("system lines, stray stream events and unknown lines produce nothing", () => {
    const transcript = makeTranscript()
    expect(transcript.push({ type: "system", subtype: "init", session_id: "s", tools: [] })).toEqual([])
    // A delta for a block that never started (no message_start / content_block_start) is not shown.
    expect(transcript.push({ type: "stream_event", event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "x" } } })).toEqual([])
    expect(transcript.push({ type: "mystery" })).toEqual([])
    expect(transcript.push("not an object")).toEqual([])
    expect(transcript.finalText()).toBeNull()
  })
})

/** A `stream_event` line as `--include-partial-messages` prints it. */
const streamEvent = (event: Record<string, unknown>, parentToolUseId: string | null = null) => ({
  type: "stream_event",
  event,
  parent_tool_use_id: parentToolUseId,
  session_id: "s",
  uuid: "u",
})
const messageStart = (id: string, parent: string | null = null) => streamEvent({ type: "message_start", message: { id } }, parent)
const blockStart = (index: number, type: string, parent: string | null = null) =>
  streamEvent({ type: "content_block_start", index, content_block: { type } }, parent)
const delta = (index: number, delta: Record<string, unknown>, parent: string | null = null) =>
  streamEvent({ type: "content_block_delta", index, delta }, parent)
const assistantMessage = (id: string, content: ReadonlyArray<unknown>, parent: string | null = null) => ({
  type: "assistant",
  message: { id, role: "assistant", content },
  parent_tool_use_id: parent,
  uuid: "u",
})

describe("claude partial messages", () => {
  test("a text block grows under one id, and its finished line replaces it in place", () => {
    const transcript = makeTranscript()
    transcript.push(messageStart("msg_1"))
    transcript.push(blockStart(0, "text"))
    const first = valid(transcript.push(delta(0, { type: "text_delta", text: "The command" })))
    expect(first).toEqual([{ _tag: "text", id: expect.any(String), parentToolId: null, text: "The command" }])
    const id = first[0]!.id
    expect(transcript.push(delta(0, { type: "text_delta", text: " printed hello." }))).toEqual([
      { _tag: "text", id, parentToolId: null, text: "The command printed hello." },
    ])
    expect(valid(transcript.push(assistantMessage("msg_1", [{ type: "text", text: "The command printed hello." }])))).toEqual([
      { _tag: "text", id, parentToolId: null, text: "The command printed hello." },
    ])
    // The next message's text is a new item.
    transcript.push(messageStart("msg_2"))
    transcript.push(blockStart(0, "text"))
    expect(transcript.push(delta(0, { type: "text_delta", text: "Done." }))[0]?.id).not.toBe(id)
  })

  test("thinking and text blocks of one message keep their own ids; tool input does not stream", () => {
    const transcript = makeTranscript()
    transcript.push(messageStart("msg_1"))
    transcript.push(blockStart(0, "thinking"))
    const [thinking] = transcript.push(delta(0, { type: "thinking_delta", thinking: "Check the file first." }))
    expect(transcript.push(delta(0, { type: "signature_delta", signature: "sig" }))).toEqual([])
    transcript.push(blockStart(1, "text"))
    const [text] = transcript.push(delta(1, { type: "text_delta", text: "Reading it." }))
    transcript.push(blockStart(2, "tool_use"))
    expect(transcript.push(delta(2, { type: "input_json_delta", partial_json: "{\"file\"" }))).toEqual([])
    expect(thinking).toMatchObject({ _tag: "thinking", text: "Check the file first." })
    expect(text).toMatchObject({ _tag: "text", text: "Reading it." })
    expect(thinking?.id).not.toBe(text?.id)

    // Claude Code prints each finished block as its own line; each takes over its streamed item.
    expect(transcript.push(assistantMessage("msg_1", [{ type: "thinking", thinking: "Check the file first." }]))[0]?.id).toBe(thinking?.id)
    expect(transcript.push(assistantMessage("msg_1", [{ type: "text", text: "Reading it." }]))[0]?.id).toBe(text?.id)
    expect(valid(transcript.push(assistantMessage("msg_1", [{ type: "tool_use", id: "toolu_1", name: "Read", input: { file: "a" } }])))).toEqual([
      { _tag: "tool", id: "toolu_1", parentToolId: null, name: "Read", input: { file: "a" }, status: "running", output: null },
    ])
  })

  test("a subagent streams in its own context, under its Task call", () => {
    const transcript = makeTranscript()
    transcript.push(messageStart("msg_main"))
    transcript.push(blockStart(0, "text"))
    transcript.push(messageStart("msg_sub", "toolu_task"))
    transcript.push(blockStart(0, "text", "toolu_task"))
    const [sub] = valid(transcript.push(delta(0, { type: "text_delta", text: "Searching." }, "toolu_task")))
    const [main] = valid(transcript.push(delta(0, { type: "text_delta", text: "Waiting on the search." })))
    expect(sub).toMatchObject({ parentToolId: "toolu_task", text: "Searching." })
    expect(main).toMatchObject({ parentToolId: null, text: "Waiting on the search." })
    expect(sub?.id).not.toBe(main?.id)
  })
})

/** An app-server notification as Codex prints it. */
const note = (method: string, params: Record<string, unknown>) => ({ method, params })
const T = { threadId: "th1", turnId: "tu1" }
const item = (phase: "started" | "completed", raw: Record<string, unknown>) => note(`item/${phase}`, { ...T, item: raw })
const usage = (total: [number, number], last: [number, number], window = 272_000, turnId = "tu1") =>
  note("thread/tokenUsage/updated", {
    threadId: "th1",
    turnId,
    tokenUsage: {
      total: { totalTokens: total[0] + total[1], inputTokens: total[0], cachedInputTokens: 0, outputTokens: total[1] },
      last: { totalTokens: last[0] + last[1], inputTokens: last[0], cachedInputTokens: 0, outputTokens: last[1] },
      modelContextWindow: window,
    },
  })
const turnCompleted = (status: string, extra: Record<string, unknown> = {}) =>
  note("turn/completed", { threadId: "th1", turn: { id: "tu1", items: [], status, error: null, durationMs: 1200, ...extra } })

describe("codex app-server", () => {
  test("an agent message streams from its deltas, and the completed message is the final text", () => {
    const transcript = makeTranscript()
    const msg = { type: "agentMessage", id: "m1", text: "", phase: "final_answer" }
    expect(transcript.push(item("started", msg))).toEqual([])
    expect(valid(transcript.push(note("item/agentMessage/delta", { ...T, itemId: "m1", delta: "Hello" })))).toEqual([
      { _tag: "text", id: "m1", parentToolId: null, text: "Hello" },
    ])
    expect(transcript.push(note("item/agentMessage/delta", { ...T, itemId: "m1", delta: " world" }))).toEqual([
      { _tag: "text", id: "m1", parentToolId: null, text: "Hello world" },
    ])
    expect(transcript.finalText()).toBeNull()
    transcript.push(item("completed", { ...msg, text: "Hello world." }))
    expect(transcript.finalText()).toBe("Hello world.")
  })

  test("a command's output grows from deltas while it runs; a non-zero exit completes it as an error", () => {
    const transcript = makeTranscript()
    const cmd = { type: "commandExecution", id: "c1", command: "bash -lc 'cat missing.txt'", status: "inProgress", aggregatedOutput: null, exitCode: null }
    expect(valid(transcript.push(item("started", cmd)))).toEqual([
      { _tag: "tool", id: "c1", parentToolId: null, name: "command_execution", input: { command: cmd.command }, status: "running", output: null },
    ])
    expect(transcript.push(note("item/commandExecution/outputDelta", { ...T, itemId: "c1", delta: "cat: " }))[0]).toMatchObject({
      status: "running",
      output: "cat: ",
    })
    expect(transcript.push(note("item/commandExecution/outputDelta", { ...T, itemId: "c1", delta: "missing.txt" }))[0]).toMatchObject({
      output: "cat: missing.txt",
    })
    expect(
      valid(transcript.push(item("completed", { ...cmd, status: "failed", aggregatedOutput: "cat: missing.txt: No such file\n", exitCode: 1 }))),
    ).toEqual([
      {
        _tag: "tool",
        id: "c1",
        parentToolId: null,
        name: "command_execution",
        input: { command: cmd.command },
        status: "error",
        output: "cat: missing.txt: No such file\n",
      },
    ])
    // A late delta for a finished command changes nothing.
    expect(transcript.push(note("item/commandExecution/outputDelta", { ...T, itemId: "c1", delta: "late" }))).toEqual([])
  })

  test("reasoning, file changes, MCP calls and web searches become display items; review markers and user messages do not", () => {
    const transcript = makeTranscript()
    expect(transcript.push(item("started", { type: "reasoning", id: "r1", summary: [], content: [] }))).toEqual([])
    transcript.push(note("item/reasoning/summaryTextDelta", { ...T, itemId: "r1", delta: "First", summaryIndex: 0 }))
    expect(valid(transcript.push(note("item/reasoning/summaryTextDelta", { ...T, itemId: "r1", delta: "Second", summaryIndex: 1 })))).toEqual([
      { _tag: "thinking", id: "r1", parentToolId: null, text: "First\n\nSecond" },
    ])
    expect(
      valid(
        transcript.push(
          item("completed", {
            type: "fileChange",
            id: "f1",
            changes: [{ path: "/home/agent/work/hello.ts", kind: { type: "add" }, diff: "+hi" }],
            status: "completed",
          }),
        ),
      ),
    ).toEqual([
      {
        _tag: "tool",
        id: "f1",
        parentToolId: null,
        name: "file_change",
        input: { changes: [{ path: "/home/agent/work/hello.ts", kind: "add" }] },
        status: "ok",
        output: null,
      },
    ])
    const call = { type: "mcpToolCall", id: "p1", server: "cloudagents", tool: "desktop_screenshot", arguments: {}, status: "completed", error: null }
    expect(
      valid(transcript.push(item("completed", { ...call, result: { content: [{ type: "text", text: "1280x720" }, { type: "image", data: "AAAA" }] } }))),
    ).toEqual([
      { _tag: "tool", id: "p1", parentToolId: null, name: "cloudagents.desktop_screenshot", input: {}, status: "ok", output: "1280x720\n[image]" },
    ])
    expect(transcript.push(item("completed", { ...call, id: "p2", status: "failed", result: null, error: { message: "desktop is stopped" } }))).toEqual([
      { _tag: "tool", id: "p2", parentToolId: null, name: "cloudagents.desktop_screenshot", input: {}, status: "error", output: "desktop is stopped" },
    ])
    expect(valid(transcript.push(item("completed", { type: "webSearch", id: "w1", query: "bun test", action: null, results: null })))).toEqual([
      { _tag: "tool", id: "w1", parentToolId: null, name: "web_search", input: { query: "bun test" }, status: "ok", output: null },
    ])
    expect(transcript.push(item("completed", { type: "exitedReviewMode", id: "x1", review: "Looks fine." }))).toEqual([])
    expect(transcript.push(item("completed", { type: "userMessage", id: "u1", content: [] }))).toEqual([])
  })

  test("a turn's tokens are its own calls, not the thread's totals; context use is the last call against the window", () => {
    // A resumed thread: 10k in / 1k out before this turn.
    const transcript = makeTranscript()
    transcript.push({ id: 2, result: { thread: { id: "th1" }, model: "gpt-6-luna" } })
    transcript.push(usage([14_000, 1_200], [4_000, 200]))
    expect(transcript.context()).toEqual({ model: "gpt-6-luna", usedTokens: 4_200, windowTokens: 272_000 })
    transcript.push(usage([19_000, 1_500], [5_000, 300]))
    const [turn] = valid(transcript.push(turnCompleted("completed")))
    expect(turn).toEqual({ _tag: "turn", id: expect.any(String), durationMs: 1200, inputTokens: 9_000, outputTokens: 500, costUsd: null, isError: false })
    // After a compaction the next call reports the smaller size.
    transcript.push(usage([19_000, 1_500], [800, 100], 272_000, "tu2"))
    expect(transcript.context()).toEqual({ model: "gpt-6-luna", usedTokens: 900, windowTokens: 272_000 })
  })

  test("a failed turn reports its error once; a retried error is not reported", () => {
    const transcript = makeTranscript()
    expect(transcript.push(note("error", { ...T, error: { message: "Reconnecting... 2/5" }, willRetry: true }))).toEqual([])
    expect(valid(transcript.push(note("error", { ...T, error: { message: "usage limit reached" }, willRetry: false })))).toEqual([
      { _tag: "error", id: expect.any(String), text: "usage limit reached" },
    ])
    expect(valid(transcript.push(turnCompleted("failed", { error: { message: "usage limit reached" } })))).toEqual([
      { _tag: "turn", id: expect.any(String), durationMs: 1200, inputTokens: null, outputTokens: null, costUsd: null, isError: true },
    ])
    expect(valid(makeTranscript().push(turnCompleted("failed", { error: { message: "model refused" } })))).toEqual([
      { _tag: "error", id: expect.any(String), text: "model refused" },
      { _tag: "turn", id: expect.any(String), durationMs: 1200, inputTokens: null, outputTokens: null, costUsd: null, isError: true },
    ])
  })

  test("the turn's plan is a todo list that stops running when the turn ends", () => {
    const transcript = makeTranscript()
    const plan = (second: string) =>
      note("turn/plan/updated", { ...T, explanation: null, plan: [{ step: "Read", status: "completed" }, { step: "Write", status: second }] })
    expect(valid(transcript.push(plan("inProgress")))).toEqual([
      {
        _tag: "tool",
        id: "plan-tu1",
        parentToolId: null,
        name: "todo_list",
        input: { items: [{ text: "Read", completed: true }, { text: "Write", completed: false }] },
        status: "running",
        output: null,
      },
    ])
    const ended = valid(transcript.push(turnCompleted("interrupted")))
    expect(ended[0]).toMatchObject({ id: "plan-tu1", status: "ok" })
    expect(ended[1]).toMatchObject({ _tag: "turn", isError: false })
  })

  test("a command an interrupt or a steer cut off ends as an error with its turn, keeping its output", () => {
    const transcript = makeTranscript()
    const cmd = { type: "commandExecution", id: "c1", command: "sleep 60", status: "inProgress", aggregatedOutput: null, exitCode: null }
    transcript.push(item("started", cmd))
    transcript.push(note("item/commandExecution/outputDelta", { ...T, itemId: "c1", delta: "tick 2\n" }))
    const ended = valid(transcript.push(turnCompleted("interrupted")))
    expect(ended[0]).toEqual({
      _tag: "tool",
      id: "c1",
      parentToolId: null,
      name: "command_execution",
      input: { command: "sleep 60" },
      status: "error",
      output: "tick 2\n",
    })
    expect(ended[1]).toMatchObject({ _tag: "turn" })
  })
})

describe("claude context use", () => {
  const init = (model: string) => ({ type: "system", subtype: "init", session_id: "s1", model })
  const call = (input: number, cacheRead: number, output: number, parentToolUseId: string | null = null) => ({
    type: "assistant",
    message: {
      id: "msg_1",
      content: [{ type: "text", text: "working" }],
      usage: { input_tokens: input, cache_creation_input_tokens: 0, cache_read_input_tokens: cacheRead, output_tokens: output },
    },
    parent_tool_use_id: parentToolUseId,
  })
  const result = (modelUsage: Record<string, unknown>) => ({
    type: "result",
    subtype: "success",
    is_error: false,
    // Run totals: the sum of every call, not the context size.
    usage: { input_tokens: 999_999, output_tokens: 999_999 },
    modelUsage,
    result: "done",
  })

  test("the main agent's last call against the session model's window, ignoring subagents and side models", () => {
    const transcript = makeTranscript()
    transcript.push(init("claude-opus-5-5"))
    transcript.push(call(10, 40_000, 500))
    // No window yet on a first session: nothing to report before the result.
    expect(transcript.context()).toBeNull()
    transcript.push(call(5, 60_000, 1_000))
    transcript.push(call(3, 150_000, 200, "toolu_task"))
    transcript.push(
      result({
        "claude-haiku-5-5": { contextWindow: 200_000 },
        "claude-opus-5-5": { contextWindow: 1_000_000 },
      }),
    )
    expect(transcript.context()).toEqual({ model: "claude-opus-5-5", usedTokens: 61_005, windowTokens: 1_000_000 })
  })

  test("a resumed session on the same model updates from its first call; after a compaction, from the next call", () => {
    const transcript = makeTranscript({ model: "claude-opus-5-5", usedTokens: 900_000, windowTokens: 1_000_000 })
    transcript.push(init("claude-opus-5-5"))
    transcript.push(call(10, 920_000, 100))
    expect(transcript.context()).toEqual({ model: "claude-opus-5-5", usedTokens: 920_110, windowTokens: 1_000_000 })
    transcript.push({ type: "system", subtype: "compact_boundary", compact_metadata: { trigger: "auto", pre_tokens: 920_110 } })
    transcript.push(call(10, 30_000, 100))
    expect(transcript.context()).toEqual({ model: "claude-opus-5-5", usedTokens: 30_110, windowTokens: 1_000_000 })
  })

  test("a compaction with no call after it reports no size rather than the stale one", () => {
    const transcript = makeTranscript()
    transcript.push(init("claude-opus-5-5"))
    transcript.push(call(10, 180_000, 100))
    transcript.push({ type: "system", subtype: "compact_boundary", compact_metadata: { trigger: "manual", pre_tokens: 180_110 } })
    transcript.push(result({ "claude-opus-5-5": { contextWindow: 200_000 } }))
    expect(transcript.context()).toBeNull()
  })

  test("a session resumed on another model waits for that model's window", () => {
    const transcript = makeTranscript({ model: "claude-opus-5-5", usedTokens: 50_000, windowTokens: 1_000_000 })
    transcript.push(init("claude-sonnet-5-5"))
    transcript.push(call(10, 50_000, 100))
    expect(transcript.context()).toBeNull()
    transcript.push(result({ "claude-sonnet-5-5": { contextWindow: 200_000 } }))
    expect(transcript.context()).toEqual({ model: "claude-sonnet-5-5", usedTokens: 50_110, windowTokens: 200_000 })
  })
})
