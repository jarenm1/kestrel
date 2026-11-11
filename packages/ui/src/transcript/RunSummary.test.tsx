import { expect, test } from "bun:test"
import { renderToStaticMarkup } from "react-dom/server"
import type { AgentItem, Run } from "@cloudagents/protocol"
import { Transcript } from "./Transcript"
import { RunSummary, RunUsage } from "./RunSummary"
import { TranscriptHostProvider } from "./host"

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

test("a run with saved clips shows the poster, the video and its caption", () => {
  const host = {
    useFileLink: (_taskId: string, path: string) => ({
      url: `https://box.test${path}`,
      onError: () => {},
      onOpen: () => {},
    }),
    openExternal: undefined,
    openThread: () => {},
    forkThread: undefined,
  }
  const withClip: Run = {
    ...run,
    evidence: {
      clips: [{ id: "a".repeat(32) + ".mp4", caption: "Spawn demo", createdAt: end, durationMs: 2100, poster: "a".repeat(32) + ".png" }],
    },
  }
  const html = renderToStaticMarkup(
    <TranscriptHostProvider value={host}>
      <RunSummary run={withClip} items={[]} />
    </TranscriptHostProvider>,
  )
  expect(html).toContain("Saved evidence")
  expect(html).toContain("<video")
  expect(html).toContain("controls")
  expect(html).toContain(`src="https://box.test/api/tasks/task/runs/run/clips/${"a".repeat(32)}.mp4"`)
  expect(html).toContain(`poster="https://box.test/api/tasks/task/runs/run/clips/${"a".repeat(32)}.png"`)
  expect(html).toContain("Spawn demo")
  expect(html).toContain("2.1s")
})

test("a run without clips has no evidence section", () => {
  const html = renderToStaticMarkup(<RunSummary run={run} items={[]} />)
  expect(html).not.toContain("Saved evidence")
  expect(html).not.toContain("<video")
})

test("a clip whose URL is still being minted shows a skeleton, not a failure", () => {
  const host = {
    useFileLink: () => ({ url: undefined, onError: () => {}, onOpen: () => {} }),
    openExternal: undefined,
    openThread: () => {},
    forkThread: undefined,
  }
  const withClip: Run = {
    ...run,
    evidence: {
      clips: [{ id: "a".repeat(32) + ".mp4", caption: "Spawn demo", createdAt: end, durationMs: 2100, poster: null }],
    },
  }
  const html = renderToStaticMarkup(
    <TranscriptHostProvider value={host}>
      <RunSummary run={withClip} items={[]} />
    </TranscriptHostProvider>,
  )
  expect(html).toContain("Saved evidence")
  expect(html).toContain(`aria-label="Loading clip"`)
  expect(html).not.toContain("Video unavailable")
  expect(html).not.toContain("<video")
})
