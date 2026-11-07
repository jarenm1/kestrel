import { expect, test } from "bun:test"
import { renderToStaticMarkup } from "react-dom/server"
import type { AgentItem } from "@cloudagents/protocol"
import { RunTranscript } from "./RunTranscript"
import { Transcript } from "./Transcript"
import { formatMessageTime } from "./time"

const timestamp = "2026-11-06T10:00:00Z"
const turn = (id: string, inputTokens: number | null = 1234, outputTokens: number | null = 56): AgentItem => ({
  _tag: "turn", id, inputTokens, outputTokens, durationMs: 2000, costUsd: null, isError: false,
})
const usage = (parentToolId: string | null = null): AgentItem => ({
  _tag: "usage", id: "usage", parentToolId, timestamp, durationMs: 400,
  inputTokens: 100, outputTokens: 20, cachedTokens: 1000,
})
const render = (items: AgentItem[], from = 0, to: number | null = null) => renderToStaticMarkup(
  <RunTranscript taskId="task" runId="run" items={items} running={false} from={from} to={to} fallbackTimestamp={timestamp} />,
)

test("saved turns retain their completion time and throughput without response usage", () => {
  const html = render([turn("old")])
  expect(html).toContain(`dateTime="${timestamp}"`)
  expect(html).toContain("1.2K in")
  expect(html).toContain("56 out")
  expect(html).toContain("turn 28 tok/s")
})

test("response usage replaces only its own turn aggregate, including across message slices", () => {
  const items = [turn("old"), usage(), turn("new", 9999, 8888), turn("acp", 42, 7)]
  const html = render(items)
  expect(html).toContain("100 in")
  expect(html).toContain("50 tok/s")
  expect(html).not.toContain("turn 50 tok/s")
  expect(html).not.toContain("10K in")
  expect(html).toContain("42 in")
  expect(html).toContain("turn 3.5 tok/s")
  expect(render(items, 2, 3)).not.toContain("<time")
})

test("child usage does not hide main completion time, including unknown token counts", () => {
  const html = render([usage("child-tool"), turn("main", null, 0)])
  expect(html.match(/<time /g)?.length).toBe(2)
  expect(html).toContain("? in")
  expect(html).toContain("turn 0 tok/s")
  expect(render([turn("unknown", null, null)])).toContain("<time")
  expect(render([turn("unknown", null, null)])).not.toContain("? in")
  expect(render([{ ...turn("failed"), isError: true } as AgentItem])).toContain("failed")
})

test("unknown and zero elapsed times do not fabricate throughput", () => {
  for (const durationMs of [undefined, null, 0, -1]) {
    expect(render([{ ...usage(), durationMs } as AgentItem])).toContain("? tok/s")
  }
})

test("message clocks use AM/PM even when the environment prefers 24-hour time", () => {
  expect(formatMessageTime(new Date(2026, 10, 6, 0, 5).toISOString())).toBe("12:05 AM")
  expect(formatMessageTime(new Date(2026, 10, 6, 13, 9).toISOString())).toBe("01:09 PM")
})

test("saved text-only transcripts still show the agent message timestamp", () => {
  const html = renderToStaticMarkup(<Transcript
    taskId="task"
    messages={[{ id: "reply", taskId: "task", role: "agent", text: "Saved reply", runId: "run", createdAt: timestamp }]}
    runs={[]}
    runItems={{ run: [{ _tag: "text", id: "text", parentToolId: null, text: "Saved reply" }] }}
    pendingAskId={undefined}
  />)
  expect(html).toContain(`dateTime="${timestamp}"`)
})

test("a reply the run transcript dates does not also show its message clock", () => {
  const html = renderToStaticMarkup(<Transcript
    taskId="task"
    messages={[
      { id: "prompt", taskId: "task", role: "user", text: "Go", runId: "run", createdAt: timestamp },
      { id: "reply", taskId: "task", role: "agent", text: "Done", runId: "run", createdAt: timestamp },
    ]}
    runs={[]}
    runItems={{ run: [
      { _tag: "text", id: "text", parentToolId: null, text: "Done" },
      usage(),
    ] }}
    pendingAskId={undefined}
  />)
  expect(html.match(/<time /g)?.length).toBe(1)
  expect(html).toContain("50 tok/s")
})
