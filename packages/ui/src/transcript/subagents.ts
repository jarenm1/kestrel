import { describeTool, type AgentItem, type ToolItem } from "@cloudagents/protocol"

/** A harness subagent's call (Claude's `Task`/`Agent`): its own work arrives as items under it (`parentToolId`). */
export const isSubagentCall = (item: AgentItem, taskId: string): item is ToolItem =>
  item._tag === "tool" && describeTool(item, taskId).kind === "agent"

/** What a subagent did, at any depth under its call, in arrival order: a child arrives after the call it hangs off. */
export function subagentItems(items: readonly AgentItem[], toolId: string): AgentItem[] {
  const inside = new Set([toolId])
  const found: AgentItem[] = []
  for (const item of items) {
    const parent = item._tag === "turn" || item._tag === "error" ? null : item.parentToolId
    if (parent === null || !inside.has(parent)) continue
    found.push(item)
    if (item._tag === "tool") inside.add(item.id)
  }
  return found
}

/** One line of what an item shows: a tool's label (a report's message), or the last line of prose without markdown. */
export function activityLine(item: AgentItem, taskId: string): string | undefined {
  if (item._tag === "tool") {
    const view = describeTool(item, taskId)
    return view.icon === "message" ? view.note ?? view.label : view.label
  }
  if (item._tag !== "text") return undefined
  return item.text
    .split("\n")
    .map((line) => line.replace(/^[\s#>*-]+/, "").replaceAll("**", "").replaceAll("`", "").trim())
    .filter((line) => line !== "")
    .at(-1)
}

/** A subagent's progress as its row shows it: its tool calls, how many failed, and its newest step. */
export interface SubagentWork {
  readonly calls: number
  readonly failed: number
  readonly activity: string | undefined
}

export function subagentWork(items: readonly AgentItem[], toolId: string, taskId: string): SubagentWork {
  let calls = 0
  let failed = 0
  let activity: string | undefined
  for (const item of subagentItems(items, toolId)) {
    if (item._tag === "tool") {
      calls++
      if (item.status === "error") failed++
    }
    activity = activityLine(item, taskId) ?? activity
  }
  return { calls, failed, activity }
}
