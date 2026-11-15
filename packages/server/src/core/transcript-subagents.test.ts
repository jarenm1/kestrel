import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { Schema } from "effect"
import { AgentItem, scopeRunItems, type SubagentItem } from "@cloudagents/protocol"
import { makeTranscript } from "./transcript"

const FIXTURES = join(import.meta.dir, "..", "..", "fixtures", "agent")

/** Feeds a recorded fixture through one parser, as the harness does: the latest item per id, in first-seen order. */
function replay(name: string) {
  const transcript = makeTranscript(null, null, "paragraph", "task")
  const items = new Map<string, AgentItem>()
  const history: AgentItem[][] = []
  for (const line of readFileSync(join(FIXTURES, `${name}.jsonl`), "utf8").split("\n")) {
    if (line.trim() === "") continue
    const pushed = transcript.push(JSON.parse(line))
    for (const item of pushed) items.set(item.id, Schema.decodeUnknownSync(AgentItem)(item))
    history.push([...items.values()])
  }
  return { items: [...items.values()], history, finalText: transcript.finalText() }
}

const subagentsOf = (items: readonly AgentItem[]) => items.filter((item): item is SubagentItem => item._tag === "subagent")

describe("Claude Code background subagents (recorded, 2.1.319)", () => {
  const { items, history } = replay("claude/recorded-subagents")
  const [listing, counting] = subagentsOf(items)

  test("each Agent call is a subagent item, not a tool call", () => {
    expect(subagentsOf(items).map((s) => s.title)).toEqual(["List directory files", "Count README lines"])
    expect(items.some((item) => item._tag === "tool" && item.name === "Agent")).toBe(false)
    expect(listing).toMatchObject({ agentType: "Explore", parentToolId: null, calls: 1, failedCalls: 0 })
  })

  test("the call's launch notice does not end it: it runs until its task_notification, which carries its report", () => {
    const launched = history.find((snapshot) => subagentsOf(snapshot).length === 2)!
    expect(subagentsOf(launched).map((s) => s.status)).toEqual(["running", "running"])
    expect(listing!.status).toBe("completed")
    expect(listing!.result).toContain("README.md")
    expect(counting!.result).toContain("4 lines")
  })

  test("its calls hang under it and its newest step is its activity", () => {
    const bash = items.filter((item) => item._tag === "tool" && item.name === "Bash")
    expect(bash.map((item) => item._tag === "tool" && item.parentToolId).sort()).toEqual([counting!.id, listing!.id].sort())
    expect(counting!.activity).toContain("4 lines")
  })

  test("the main scope keeps the subagents and none of their items", () => {
    const main = scopeRunItems(items, "main", "task", false)
    expect(main.filter((item) => item._tag !== "turn" && item._tag !== "error" && item.parentToolId !== null)).toEqual([])
    expect(subagentsOf(main)).toEqual([listing!, counting!])
    expect(scopeRunItems(items, "subagents", "task", false).some((item) => item._tag === "tool" && item.name === "Bash")).toBe(true)
  })
})

describe("Codex multi-agent subagents (recorded, codex-cli 0.167)", () => {
  const { items, finalText } = replay("codex/recorded-subagents")
  const [listing, counting] = subagentsOf(items)

  test("each subAgentActivity start is a subagent, ended by its completion with its last answer", () => {
    expect(subagentsOf(items).map((s) => [s.title, s.status, s.calls])).toEqual([["list dir", "completed", 1], ["readme lines", "completed", 1]])
    expect(listing!.model).toBe("gpt-6-luna")
    expect(counting!.result).toBe("README.md has 4 lines.")
  })

  test("a subagent thread's items are its own, and its turn's end is not the run's", () => {
    const commands = items.filter((item) => item._tag === "tool" && item.name === "command_execution")
    expect(commands.map((item) => item._tag === "tool" && item.parentToolId)).toEqual([listing!.id, counting!.id])
    expect(commands.every((item) => item._tag === "tool" && item.status === "ok")).toBe(true)
    expect(items.filter((item) => item._tag === "turn")).toHaveLength(1)
    expect(finalText).toContain("README.md` has 4 lines")
  })
})
