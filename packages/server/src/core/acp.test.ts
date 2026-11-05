import { describe, expect, test } from "bun:test"
import { makeAcpDriver, type AcpDriverIo, type AcpRunInput } from "./acp"
import type { RunOutcome } from "./run-driver"
import { makeTranscript } from "./transcript"

interface Sent {
  readonly jsonrpc?: string
  readonly id?: number
  readonly method?: string
  readonly params?: Record<string, unknown>
  readonly result?: unknown
  readonly error?: unknown
}

/** A thinking-level option in ACP's `thought_level` category, under the id the agent gives it. */
const thoughtOption = (id: string, values: readonly string[]) => ({
  id,
  category: "thought_level",
  type: "select",
  currentValue: values[0],
  options: values.map((value) => ({ value, name: value })),
})

/** A driver wired to a recording ACP agent: `sent` is what the driver wrote, `reply` answers its last request. */
const harness = (overrides: Partial<AcpRunInput> = {}, io: Pick<AcpDriverIo, "permission"> = {}) => {
  const sent: Sent[] = []
  const sessions: string[] = []
  const outcomes: RunOutcome[] = []
  const driver = makeAcpDriver(
    {
      prompt: "user context\n\nfix the test",
      cwd: "/threads/t1/kestrel",
      resumeSession: null,
      mcpServers: [{ type: "http", name: "cloudagents", url: "http://box/mcp/t1", headers: [{ name: "Authorization", value: "Bearer tok" }] }],
      ...overrides,
    },
    { send: (m) => sent.push(m as Sent), onSession: (id) => sessions.push(id), onDone: (o) => outcomes.push(o), ...io },
  )
  const last = () => sent.at(-1) as Sent
  const reply = (result: unknown) => driver.receive({ jsonrpc: "2.0", id: last().id, result })
  return { driver, sent, sessions, outcomes, last, reply }
}

describe("ACP driver", () => {
  test("a fresh run opens a session with the thread's MCP server, sets the model, and the prompt's response ends the turn", () => {
    const h = harness({ model: "opencode/big-pickle" })
    h.driver.start()
    expect(h.last()).toMatchObject({ method: "initialize", params: { protocolVersion: 1 } })
    h.reply({ protocolVersion: 1 })
    expect(h.last()).toMatchObject({
      method: "session/new",
      params: { cwd: "/threads/t1/kestrel", mcpServers: [{ type: "http", url: "http://box/mcp/t1", headers: [{ name: "Authorization", value: "Bearer tok" }] }] },
    })
    h.reply({ sessionId: "s1", configOptions: [] })
    expect(h.sessions).toEqual(["s1"])
    expect(h.last()).toMatchObject({ method: "session/set_config_option", params: { sessionId: "s1", configId: "model", value: "opencode/big-pickle" } })
    h.reply({ configOptions: [] })
    expect(h.last()).toMatchObject({
      method: "session/prompt",
      params: { sessionId: "s1", prompt: [{ type: "text", text: "user context\n\nfix the test" }] },
    })
    expect(h.outcomes).toEqual([])
    h.reply({ stopReason: "end_turn" })
    expect(h.outcomes).toEqual([{ status: "completed" }])
  })

  test("a resumed run resumes its session without replay; a refused resume fails the run", () => {
    const h = harness({ resumeSession: "s-old" })
    h.driver.start()
    h.reply({})
    expect(h.last()).toMatchObject({ method: "session/resume", params: { sessionId: "s-old", cwd: "/threads/t1/kestrel" } })
    h.reply({ configOptions: [] })
    expect(h.sessions).toEqual(["s-old"])
    expect(h.last().method).toBe("session/prompt")

    const refused = harness({ resumeSession: "s-gone" })
    refused.driver.start()
    refused.reply({})
    refused.driver.receive({ jsonrpc: "2.0", id: refused.last().id, error: { code: -32602, message: "session not found" } })
    expect(refused.outcomes).toEqual([{ status: "failed", error: "session/resume: session not found" }])
  })

  test("the thinking level is set through whatever option the model's thought_level category names, only when offered", () => {
    const opencode = harness({ model: "opencode/glm-5.3-flash-free", effort: "high" })
    opencode.driver.start()
    opencode.reply({})
    opencode.reply({ sessionId: "s1" })
    opencode.reply({ configOptions: [thoughtOption("effort", ["low", "high", "max", "default"])] })
    expect(opencode.last()).toMatchObject({ method: "session/set_config_option", params: { configId: "effort", value: "high" } })
    opencode.reply({ configOptions: [] })
    expect(opencode.last().method).toBe("session/prompt")

    // Antigravity CLI names its option `thought_level`.
    const agy = harness({ model: "gemini-3.8-flash", effort: "low" })
    agy.driver.start()
    agy.reply({})
    agy.reply({ sessionId: "s1" })
    agy.reply({ configOptions: [{ id: "model", category: "model", options: [] }, thoughtOption("thought_level", ["low", "medium", "high"])] })
    expect(agy.last()).toMatchObject({ method: "session/set_config_option", params: { configId: "thought_level", value: "low" } })

    const absent = harness({ model: "opencode/big-pickle", effort: "high" })
    absent.driver.start()
    absent.reply({})
    absent.reply({ sessionId: "s1" })
    absent.reply({ configOptions: [] })
    expect(absent.last().method).toBe("session/prompt")
  })

  test("a resumed run's message that starts with a slash still carries the context and conversation around it", () => {
    const prompt = "user context\n\nYour session last ran before the following happened in this thread:\n…\n\n/review branch"
    const h = harness({ resumeSession: "s-old", prompt })
    h.driver.start()
    h.reply({})
    h.reply({ configOptions: [] })
    expect(h.last()).toMatchObject({ method: "session/prompt", params: { sessionId: "s-old", prompt: [{ type: "text", text: prompt }] } })
  })

  test("permission requests are approved, other agent requests refused, and Stop cancels the prompt", async () => {
    const h = harness()
    h.driver.start()
    h.reply({})
    h.reply({ sessionId: "s1" })
    h.driver.receive({
      jsonrpc: "2.0",
      id: 7,
      method: "session/request_permission",
      params: { sessionId: "s1", options: [{ optionId: "no", kind: "reject_once" }, { optionId: "yes", kind: "allow_once" }, { optionId: "always", kind: "allow_always" }] },
    })
    expect(h.last()).toEqual({ jsonrpc: "2.0", id: 7, result: { outcome: { outcome: "selected", optionId: "always" } } })
    h.driver.receive({ jsonrpc: "2.0", id: 8, method: "fs/read_text_file", params: { path: "/etc/passwd" } })
    expect(h.last()).toMatchObject({ id: 8, error: { code: -32601 } })
    expect(await h.driver.steer("more")).toBe(false)
    const prompt = h.sent.find((m) => m.method === "session/prompt") as Sent
    expect(h.driver.interrupt()).toBe(true)
    expect(h.last()).toEqual({ jsonrpc: "2.0", method: "session/cancel", params: { sessionId: "s1" } })
    h.driver.receive({ jsonrpc: "2.0", id: prompt.id, result: { stopReason: "cancelled" } })
    expect(h.outcomes).toEqual([{ status: "interrupted" }])
    expect(h.driver.interrupt()).toBe(false)
  })

  test("text generation's deny policy refuses a tool request with the agent's reject option", () => {
    const h = harness({}, { permission: "deny" })
    h.driver.start()
    h.reply({})
    h.reply({ sessionId: "s1" })
    h.driver.receive({
      jsonrpc: "2.0",
      id: 11,
      method: "session/request_permission",
      params: {
        sessionId: "s1",
        toolCall: { toolCallId: "c1", title: "Run the test suite", kind: "execute", status: "pending", rawInput: { command: "bun test" } },
        options: [{ optionId: "no", kind: "reject_once" }, { optionId: "yes", kind: "allow_once" }, { optionId: "always", kind: "allow_always" }],
      },
    })
    expect(h.last()).toEqual({ jsonrpc: "2.0", id: 11, result: { outcome: { outcome: "selected", optionId: "no" } } })
    // Without a reject option the request is cancelled rather than approved.
    h.driver.receive({
      jsonrpc: "2.0",
      id: 12,
      method: "session/request_permission",
      params: { sessionId: "s1", toolCall: { toolCallId: "c2", title: "Write a file", kind: "edit", status: "pending" }, options: [{ optionId: "yes", kind: "allow_once" }] },
    })
    expect(h.last()).toEqual({ jsonrpc: "2.0", id: 12, result: { outcome: { outcome: "cancelled" } } })
  })

  test("an agent that exits mid-turn fails the run", () => {
    const h = harness()
    h.driver.start()
    h.reply({})
    h.reply({ sessionId: "s1" })
    h.driver.close()
    expect(h.outcomes).toEqual([{ status: "failed", error: "session/prompt: the agent exited" }])
  })
})

const update = (u: Record<string, unknown>) => ({ jsonrpc: "2.0", method: "session/update", params: { sessionId: "s1", update: u } })

describe("ACP transcript", () => {
  test("chunks build messages, tool updates merge into one call, and the prompt's response closes the turn", () => {
    const t = makeTranscript()
    t.push({ jsonrpc: "2.0", id: 2, result: { sessionId: "s1", configOptions: [{ id: "model", currentValue: "opencode/big-pickle" }] } })
    t.push(update({ sessionUpdate: "agent_thought_chunk", messageId: "m1:reasoning:0", content: { type: "text", text: "Let me " } }))
    expect(t.push(update({ sessionUpdate: "agent_thought_chunk", messageId: "m1:reasoning:0", content: { type: "text", text: "look." } }))).toEqual([
      { _tag: "thinking", id: "thinking-m1:reasoning:0", parentToolId: null, text: "Let me look." },
    ])
    t.push(update({ sessionUpdate: "tool_call", toolCallId: "c1", title: "shell", kind: "execute", status: "pending", rawInput: {} }))
    t.push(update({ sessionUpdate: "tool_call_update", toolCallId: "c1", status: "in_progress", title: "echo hi", rawInput: { command: "echo hi" } }))
    expect(
      t.push(update({ sessionUpdate: "tool_call_update", toolCallId: "c1", status: "completed", content: [{ type: "content", content: { type: "text", text: "hi\n" } }] })),
    ).toEqual([{ _tag: "tool", id: "c1", parentToolId: null, name: "command_execution", input: { command: "echo hi" }, status: "ok", output: "hi\n" }])
    t.push(update({ sessionUpdate: "tool_call", toolCallId: "c2", title: "write", kind: "edit", status: "pending", rawInput: { path: "a.txt" } }))
    t.push(update({ sessionUpdate: "agent_message_chunk", messageId: "m2", content: { type: "text", text: "Done" } }))
    t.push(update({ sessionUpdate: "usage_update", used: 9000, size: 200000 }))
    expect(t.takeContext()).toEqual({ model: "opencode/big-pickle", usedTokens: 9000, windowTokens: 200000 })
    const end = t.push({ jsonrpc: "2.0", id: 5, result: { stopReason: "end_turn", usage: { inputTokens: 100, outputTokens: 7, cachedReadTokens: 9000 } } })
    expect(end).toEqual([
      { _tag: "tool", id: "c2", parentToolId: null, name: "write", input: { path: "a.txt" }, status: "error", output: null },
      { _tag: "turn", id: expect.any(String), durationMs: null, inputTokens: 9100, outputTokens: 7, costUsd: null, isError: false },
    ])
    expect(t.finalText()).toBe("Done")
  })
})
