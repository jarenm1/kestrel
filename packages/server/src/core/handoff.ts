import type { Message } from "@cloudagents/protocol"

/** Roughly how much of the earlier conversation a handoff prompt carries, in characters. */
export const HANDOFF_HISTORY_LIMIT = 60_000

const ROLE_LABEL: Record<"user" | "agent", string> = { user: "User", agent: "Agent" }

/**
 * The prompt a run starts with when the thread's latest session belongs to another provider: the conversation so
 * far (newest messages first to fit `limit`, then printed oldest first), framed as another agent's, followed by
 * the new prompt. System messages and empty text carry no conversation and are skipped.
 */
export const formatHandoff = (
  history: ReadonlyArray<Pick<Message, "role" | "text">>,
  prompt: string,
  limit = HANDOFF_HISTORY_LIMIT,
): string => {
  const turns: Array<{ readonly role: "user" | "agent"; readonly text: string }> = []
  for (const message of history) {
    if ((message.role === "user" || message.role === "agent") && message.text.trim() !== "") {
      turns.push({ role: message.role, text: message.text })
    }
  }
  const kept: typeof turns = []
  let used = 0
  for (const turn of [...turns].reverse()) {
    // The newest message is kept whole even when it alone exceeds the limit; the cap is approximate.
    if (kept.length > 0 && used + turn.text.length + 1 > limit) break
    kept.unshift(turn)
    used += turn.text.length + 1
  }
  if (kept.length === 0) return prompt
  const transcript = kept.map((turn) => `${ROLE_LABEL[turn.role]}:\n${turn.text}`).join("\n\n")
  return [
    "You are continuing a conversation the user started with a different agent, which cannot continue this thread.",
    "The conversation so far, oldest first:",
    "",
    transcript,
    "",
    "Continue the conversation. The user's new message follows:",
    "",
    prompt,
  ].join("\n")
}
