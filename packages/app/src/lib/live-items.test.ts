import { describe, expect, test } from "bun:test"
import type { AgentItem } from "@cloudagents/protocol"
import { liveItemIds } from "./live-items"

const thinking = (id: string, parentToolId: string | null = null): AgentItem => ({ _tag: "thinking", id, parentToolId, text: id })
const text = (id: string, parentToolId: string | null = null): AgentItem => ({ _tag: "text", id, parentToolId, text: id })
const task = (id: string, status: "running" | "ok" | "error" = "running"): AgentItem => ({
  _tag: "tool",
  id,
  parentToolId: null,
  name: "Task",
  input: {},
  status,
  output: null,
})

describe("liveItemIds", () => {
  test("two subagents thinking at once both stay live, whichever started last", () => {
    // Subagent A started thinking first; B's item arrived after it, and A's later deltas update A in place.
    const items = [task("t1"), task("t2"), thinking("a", "t1"), thinking("b", "t2")]
    expect([...liveItemIds(items, true)].sort()).toEqual(["a", "b", "t2"])
  })

  test("a stream's earlier thinking settles once that stream moves on, independent of the others", () => {
    const items = [task("t1"), task("t2"), thinking("a", "t1"), thinking("b", "t2"), text("a2", "t1")]
    const live = liveItemIds(items, true)
    expect(live.has("a")).toBe(false)
    expect(live.has("b")).toBe(true)
  })

  test("a subagent's stream ends with its tool call", () => {
    const items = [task("t1", "ok"), task("t2"), thinking("a", "t1"), thinking("b", "t2")]
    const live = liveItemIds(items, true)
    expect(live.has("a")).toBe(false)
    expect(live.has("b")).toBe(true)
  })

  test("the main agent's thinking settles when its next item arrives, even if a subagent is mid-thought", () => {
    const items = [thinking("main"), task("t1"), thinking("a", "t1")]
    const live = liveItemIds(items, true)
    expect(live.has("main")).toBe(false)
    expect(live.has("a")).toBe(true)
  })

  test("nothing is live once the run is over", () => {
    expect(liveItemIds([task("t1"), thinking("a", "t1"), thinking("main")], false).size).toBe(0)
  })
})
