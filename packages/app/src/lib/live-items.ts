import type { AgentItem } from "@cloudagents/protocol"

/**
 * Items that may still be streaming. The main agent and each subagent (items under one `parentToolId`) stream
 * concurrently, so each stream's newest item is live while the run is; a subagent's stream ends with its tool call.
 * An item updated in place keeps its position, so "newest" is the last position per stream, not the last update.
 */
export function liveItemIds(items: readonly AgentItem[], running: boolean): ReadonlySet<string> {
  const live = new Set<string>()
  if (!running) return live
  const toolStatus = new Map(items.flatMap((item) => (item._tag === "tool" ? [[item.id, item.status] as const] : [])))
  const newestByStream = new Map<string | null, string>()
  for (const item of items) {
    newestByStream.set(item._tag === "turn" || item._tag === "error" ? null : item.parentToolId, item.id)
  }
  for (const [parentToolId, id] of newestByStream) {
    if (parentToolId === null || (toolStatus.get(parentToolId) ?? "running") === "running") live.add(id)
  }
  return live
}
