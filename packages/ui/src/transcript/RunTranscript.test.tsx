import { expect, test } from "bun:test"
import { renderToStaticMarkup } from "react-dom/server"
import type { AgentItem, Message, Run } from "@cloudagents/protocol"
import { RunTranscript } from "./RunTranscript"
import { RunSummary } from "./RunSummary"
import { Transcript } from "./Transcript"

const timestamp = "2026-11-06T10:00:00Z"
const run: Run = { id: "run", taskId: "task", prompt: "Go", status: "succeeded", startedAt: timestamp, endedAt: "2026-11-06T10:01:00Z", exitCode: 0 }
const turn = (id: string, outputTokens: number | null = 60): AgentItem => ({
  _tag: "turn", id, inputTokens: 1234, outputTokens, durationMs: 2000, costUsd: null, isError: false,
})
const usage: AgentItem = { _tag: "usage", id: "usage", parentToolId: null, timestamp, durationMs: 400, inputTokens: 100, outputTokens: 20, cachedTokens: 1000 }
const summary = (items: AgentItem[], overrides: Partial<Run> = {}) => renderToStaticMarkup(<RunSummary run={{ ...run, ...overrides }} items={items} />)

test("elapsed and rate use the lifecycle clock rather than response or provider timing", () => {
  const html = summary([usage, turn("end")])
  expect(html).toContain("Worked for 1m")
  expect(html).toContain("1 tok/s")
  expect(html).not.toContain("30 tok/s")
  expect(html).not.toContain("50 tok/s")
})

test("metadata no longer creates rows or splits consecutive tools", () => {
  const tool = (id: string): AgentItem => ({ _tag: "tool", id, parentToolId: null, name: "Bash", input: { command: "echo hello" }, status: "ok", output: null })
  const html = renderToStaticMarkup(<RunTranscript taskId="task" runId="run" items={[tool("a"), usage, tool("b"), turn("end")]} running={false} from={0} to={null} />)
  expect(html).toContain("Ran 2 commands")
  expect(html).not.toContain("tok/s")
  expect(html).not.toContain("<time")
})

test("a collapsed tool group counts the calls that failed", () => {
  const tool = (id: string, status: "ok" | "error"): AgentItem => ({
    _tag: "tool", id, parentToolId: null, name: "Bash", input: { command: "echo hello" }, status, output: null,
  })
  const render = (items: AgentItem[]) => renderToStaticMarkup(<RunTranscript taskId="task" runId="run" items={items} running={false} from={0} to={null} />)
  const html = render([tool("a", "error"), tool("b", "error"), tool("c", "error"), tool("d", "ok")])
  expect(html).toContain("Ran 4 commands")
  expect(html).toContain("3 failed")
  expect(html).not.toContain("4 failed")
  expect(render([tool("a", "ok"), tool("b", "ok")])).not.toContain("failed")
  expect(render([tool("a", "error"), tool("b", "ok")])).toContain("1 failed")
})

test("steering splits content but leaves exactly one final run summary", () => {
  const messages: Message[] = [
    { id: "prompt", taskId: "task", role: "user", text: "Go", runId: "run", createdAt: timestamp },
    { id: "steer", taskId: "task", role: "user", text: "Also this", runId: "run", afterItems: 2, createdAt: "2026-11-06T10:00:30Z" },
    { id: "reply", taskId: "task", role: "agent", text: "Done", runId: "run", createdAt: run.endedAt! },
  ]
  const html = renderToStaticMarkup(<Transcript taskId="task" messages={messages} runs={[run]} runItems={{ run: [usage, turn("one"), { _tag: "text", id: "text", parentToolId: null, text: "Done" }, turn("two")] }} pendingAskId={undefined} />)
  expect(html.match(/<summary/g)?.length).toBe(1)
  expect(html.indexOf("Worked for")).toBeGreaterThan(html.indexOf("Done"))
  expect(html.match(/<time /g)?.length).toBe(1)
  expect(html).toContain("2 tok/s")
})

test("missing tokens never turn partial totals into a misleading rate", () => {
  expect(summary([turn("one"), turn("two", null)])).not.toContain("tok/s")
  expect(summary([])).toContain("Not reported")
  expect(summary([turn("zero", 0)])).toContain("0 tok/s")
  expect(summary([turn("end")], { endedAt: timestamp })).not.toContain("tok/s")
  expect(summary([turn("end")], { endedAt: null })).not.toContain("tok/s")
  expect(summary([turn("end")], { endedAt: "invalid" })).not.toContain("tok/s")
})

test("running runs have no completion footer; stops and failures retain duration", () => {
  expect(summary([], { status: "running", endedAt: null })).toBe("")
  expect(summary([], { status: "cancelled" })).toContain("Stopped for 1m")
  expect(summary([], { status: "failed" })).toContain("Failed for 1m")
})
