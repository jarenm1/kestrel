import type { Message } from "./index"

/** The display items of a run at positions `from` up to `to` (null: through the last one). */
export interface TranscriptSegment {
  readonly runId: string
  readonly from: number
  readonly to: number | null
}

/**
 * Where each run's transcript reads in a thread, keyed by user message id: after each user message a run took comes
 * what the run showed until its next one. The prompt starts at the run's first item; a message that reached the run
 * mid-way (a steer, an answer, inbox mail) at the item count recorded when it arrived, so it sits where it was sent.
 * A message without that count (persisted before it was recorded) starts at the first item, after the prompt.
 * `messages` must be in thread order.
 */
export function transcriptSegments(messages: readonly Message[]): ReadonlyMap<string, TranscriptSegment> {
  const byRun = new Map<string, Message[]>()
  for (const m of messages) {
    if (m.role !== "user" || m.runId === null) continue
    const list = byRun.get(m.runId) ?? []
    list.push(m)
    byRun.set(m.runId, list)
  }
  const segments = new Map<string, TranscriptSegment>()
  for (const [runId, list] of byRun) {
    // Positions never go back, so segments never overlap.
    let position = 0
    const starts = list.map((m) => (position = Math.max(position, m.afterItems ?? 0)))
    list.forEach((m, i) => segments.set(m.id, { runId, from: starts[i]!, to: starts[i + 1] ?? null }))
  }
  return segments
}
