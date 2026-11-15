import type { AgentItem, RunItemsScope, SubagentItem } from "./index"
import { describeTool, type ToolItem } from "./tool-display"
import { isMainItem } from "./transcript-segments"

/** The subagent (or, on runs recorded before subagent items, the tool call) an item belongs to; null: the main agent's. */
export const itemParent = (item: AgentItem): string | null => (item._tag === "turn" || item._tag === "error" ? null : item.parentToolId)

/** One line of what an item shows: a tool's label (a report's message), the last line of prose, a subagent's task. */
export function activityLine(item: AgentItem, taskId: string): string | undefined {
  switch (item._tag) {
    case "tool": {
      const view = describeTool(item, taskId)
      return view.icon === "message" ? view.note ?? view.label : view.label
    }
    case "subagent":
      return `Subagent: ${item.title}`
    case "text":
      return item.text
        .split("\n")
        .map((line) => line.replace(/^[\s#>*-]+/, "").replaceAll("**", "").replaceAll("`", "").trim())
        .filter((line) => line !== "")
        .at(-1)
    default:
      return undefined
  }
}

/**
 * Keeps subagent items' tallies current as a run's items arrive in order: each tool call under a subagent (at any
 * depth) counts toward it and every subagent above it, and its newest step becomes their activity. `observe` returns
 * the subagent items that changed, to be sent after the item that changed them.
 */
export function makeSubagentTally(taskId: string) {
  const subagents = new Map<string, SubagentItem>()
  /** Each subagent's tool calls by id, with whether the call failed: a call is sent again as it progresses. */
  const calls = new Map<string, Map<string, boolean>>()

  const observe = (item: AgentItem): SubagentItem[] => {
    if (item._tag === "subagent") {
      const known = subagents.get(item.id)
      // The harness reports what it knows; the tally is this side's.
      subagents.set(item.id, known === undefined ? item : { ...item, calls: known.calls, failedCalls: known.failedCalls, activity: known.activity })
      return known === undefined ? [] : [subagents.get(item.id)!]
    }
    const changed: SubagentItem[] = []
    const activity = activityLine(item, taskId) ?? null
    for (let owner = itemParent(item); owner !== null; ) {
      const subagent = subagents.get(owner)
      if (subagent === undefined) break
      let next = activity === null ? subagent : { ...subagent, activity }
      if (item._tag === "tool") {
        const own = calls.get(owner) ?? new Map<string, boolean>()
        calls.set(owner, own)
        own.set(item.id, item.status === "error")
        next = { ...next, calls: own.size, failedCalls: [...own.values()].filter(Boolean).length }
      }
      if (next !== subagent) {
        subagents.set(owner, next)
        changed.push(next)
      }
      owner = subagent.parentToolId
    }
    return changed
  }
  return { observe }
}

/** A run recorded before subagent items: Claude's `Agent`/`Task` tool call, whose subagent's items hang under it. */
const isLegacySubagentCall = (item: AgentItem, taskId: string): item is ToolItem =>
  item._tag === "tool" && describeTool(item, taskId).kind === "agent"

/** How Claude Code's `Agent` call answers when it starts the subagent in the background instead of waiting for it. */
export const ASYNC_LAUNCH = "Async agent launched"

/**
 * A run's items with every subagent as a `subagent` item, tallied: runs recorded before subagent items have only the
 * call that started each one. A call that is still running in a run that ended was stopped with it.
 */
export function withSubagentItems(items: readonly AgentItem[], taskId: string, running: boolean): AgentItem[] {
  const tally = makeSubagentTally(taskId)
  const latest = new Map<string, SubagentItem>()
  const out = items.map((item): AgentItem => {
    if (!isLegacySubagentCall(item, taskId)) return item
    const input = typeof item.input === "object" && item.input !== null ? (item.input as Record<string, unknown>) : {}
    const text = (key: string) => (typeof input[key] === "string" ? (input[key] as string) : null)
    return {
      _tag: "subagent",
      id: item.id,
      parentToolId: item.parentToolId,
      title: text("description") ?? text("subagent_type") ?? "task",
      agentType: text("subagent_type"),
      prompt: text("prompt"),
      model: text("model"),
      status: item.status === "ok" ? "completed" : item.status === "error" ? "failed" : running ? "running" : "stopped",
      calls: 0,
      failedCalls: 0,
      activity: null,
      // A background subagent's call returns at once with a launch notice; its report came later, unrecorded.
      result: item.output?.startsWith(ASYNC_LAUNCH) === true ? null : item.output,
    }
  })
  for (const item of out) {
    if (item._tag === "subagent") latest.set(item.id, item)
    for (const changed of tally.observe(item)) latest.set(changed.id, changed)
  }
  return out.map((item) => {
    if (item._tag !== "subagent") return item
    const tallied = latest.get(item.id) ?? item
    return tallied.status === "running" && !running ? { ...tallied, status: "stopped" } : tallied
  })
}

/**
 * The part of a run's items `scope` asks for. `main`: what the main agent did, each subagent as its tallied item;
 * `subagents`: every item a subagent made, at any depth, in arrival order.
 */
export function scopeRunItems(items: readonly AgentItem[], scope: RunItemsScope, taskId: string, running: boolean): AgentItem[] {
  if (scope === "subagents") return items.filter((item) => !isMainItem(item))
  return withSubagentItems(items, taskId, running).filter(isMainItem)
}
