import { expect, test } from "bun:test"
import { renderToStaticMarkup } from "react-dom/server"
import type { AgentItem } from "@cloudagents/protocol"
import { RunTranscript } from "./RunTranscript"

const turn = (id: string, inputTokens: number | null = 1234, outputTokens: number | null = 56): AgentItem => ({
  _tag: "turn", id, inputTokens, outputTokens, durationMs: 1000, costUsd: null, isError: false,
})
const usage = (parentToolId: string | null = null): AgentItem => ({
  _tag: "usage", id: "usage", parentToolId, timestamp: "2026-11-06T10:00:00Z",
  inputTokens: 100, outputTokens: 20, cachedTokens: 1000,
})
const render = (items: AgentItem[], from = 0, to: number | null = null) => renderToStaticMarkup(
  <RunTranscript taskId="task" runId="run" items={items} running={false} from={from} to={to} />,
)

test("saved and ACP turn usage stays visible without response-level usage", () => {
  const html = render([turn("old")])
  expect(html).toContain("Turn total")
  expect(html).toContain("1.2K in")
  expect(html).toContain("56 out")
  expect(html).not.toContain("cached</span>")
})

test("response strips replace only their own turn's aggregate", () => {
  const items = [turn("old"), usage(), turn("new", 9999, 8888), turn("acp", 42, 7)]
  const html = render(items)
  expect(html.match(/Turn total/g)?.length).toBe(2)
  expect(html).toContain("100 in")
  expect(html).not.toContain("10K in")
  expect(html).toContain("42 in")
  // Slicing must not mistake a hidden response strip for missing response data.
  expect(render(items, 2, 3)).not.toContain("Turn total")
})

test("child usage does not hide the main turn total, and missing buckets stay unknown", () => {
  const html = render([usage("child-tool"), turn("main", null, 0)])
  expect(html).toContain("Turn total")
  expect(html).toContain("? in")
  expect(html).toContain("0 out")
  expect(render([turn("unknown", null, null)])).not.toContain("Turn total")
  expect(render([{ ...turn("failed"), isError: true } as AgentItem])).toContain("failed")
})
