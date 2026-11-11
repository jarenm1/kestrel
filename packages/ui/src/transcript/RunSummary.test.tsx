import { expect, test } from "bun:test"
import { renderToStaticMarkup } from "react-dom/server"
import type { AgentItem, Run } from "@cloudagents/protocol"
import { Transcript } from "./Transcript"
import { RunSummary, RunUsage } from "./RunSummary"

const start = "2026-11-06T10:00:00Z"
const end = "2026-11-06T10:01:00Z"
const run: Run = { id: "run", taskId: "task", prompt: "Go", status: "succeeded", startedAt: start, endedAt: end, exitCode: 0 }

test("a saved reply without items precedes its only completion footer", () => {
  const html = renderToStaticMarkup(<Transcript taskId="task" runs={[run]} runItems={{}} pendingAskId={undefined} messages={[
    { id: "prompt", taskId: "task", role: "user", text: "Go", runId: "run", createdAt: start },
    { id: "reply", taskId: "task", role: "agent", text: "Saved answer", runId: "run", createdAt: end },
  ]} />)
  expect(html.indexOf("Worked for")).toBeGreaterThan(html.indexOf("Saved answer"))
  expect(html.match(/<time /g)?.length).toBe(1)
})

test("unfinished trailing work cannot report a completed prefix as invocation usage", () => {
  const items: AgentItem[] = [
    { _tag: "turn", id: "one", durationMs: 1000, inputTokens: 100, outputTokens: 60, costUsd: null, isError: false },
    { _tag: "text", id: "next", parentToolId: null, text: "Still working" },
  ]
  for (const status of ["failed", "cancelled", "succeeded"] as const) {
    const html = renderToStaticMarkup(<RunUsage run={{ ...run, status }} items={items} />)
    expect(html).not.toContain("tok/s")
    expect(html).toContain("Not reported")
  }
})

test("restart reconciliation does not count downtime as work", () => {
  const restarted: Run = { ...run, status: "failed", interruptedByRestart: true, endedAt: "2026-11-07T10:00:00Z" }
  expect(renderToStaticMarkup(<RunSummary run={restarted} items={[]} />)).not.toContain("24h")
  const html = renderToStaticMarkup(<RunUsage run={restarted} items={[]} />)
  expect(html).not.toContain("tok/s")
  expect(html).toContain("Not reported")
})
