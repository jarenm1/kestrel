import type { Message } from "@cloudagents/protocol"

/** Maximum rendered history size in characters; the new user message is never truncated. */
export const HANDOFF_HISTORY_LIMIT = 60_000

/**
 * The prompt a run starts with when it needs conversation from another provider. Keep the newest whole turns
 * within `limit`, then print oldest first. An oversized newest turn is explicitly truncated; labels and separators
 * count toward the budget too. System messages and empty text carry no conversation and are skipped.
 */
export const formatHandoff = (
  history: ReadonlyArray<Pick<Message, "role" | "text" | "fromThread">>,
  prompt: string,
  limit = HANDOFF_HISTORY_LIMIT,
  mode: "full" | "delta" = "full",
): string => {
  const kept: string[] = []
  let used = 0
  for (let i = history.length - 1; i >= 0; i--) {
    const message = history[i]!
    if ((message.role !== "user" && message.role !== "agent") || message.text.trim() === "") continue
    const from = message.fromThread
    const label =
      message.role === "agent" ? "Agent" : from === undefined ? "User" : `Agent of thread "${from.title}" (${from.id})`
    const turn = `${label}:\n${message.text}`
    const size = turn.length + (kept.length === 0 ? 0 : 2)
    if (used + size > limit) {
      if (kept.length === 0 && limit > 0) {
        const marker = "\n[Earlier conversation truncated]"
        kept.push(limit <= marker.length ? marker.slice(0, limit) : turn.slice(0, limit - marker.length) + marker)
      }
      break
    }
    kept.push(turn)
    used += size
  }
  if (kept.length === 0) return prompt
  const transcript = kept.reverse().join("\n\n")
  return [
    mode === "delta"
      ? "Your session last ran before the following happened in this thread:"
      : "Another agent worked on this conversation. Use the following context to continue.",
    "The earlier messages to carry forward, oldest first:",
    "",
    transcript,
    "",
    "Continue the conversation. The user's new message follows:",
    "",
    prompt,
  ].join("\n")
}
