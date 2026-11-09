import type { DesktopStatus } from "@cloudagents/protocol"

/**
 * Which writer produced a cached desktop lifecycle status. A live status frame is the box's truth, a
 * `desktop.updated` event is the box's snapshot, and a mutation response is the user's request answered last.
 */
export type DesktopStatusSource = "stream" | "event" | "mutation"

/**
 * The one shape of `keys.desktop(taskId)`: the lifecycle phase and the writer that last applied it. The connection
 * state (`RtcState`) and diagnostics are separate: they describe one viewer's session, not the desktop.
 */
export interface DesktopStatusValue {
  readonly status: DesktopStatus
  readonly source: DesktopStatusSource
  /** Bumped on every applied write, so a request can notice that a newer status landed while it was in flight. */
  readonly revision: number
}

/**
 * Tasks whose desktop stream is mounted in this tab. It is viewer connection state, not lifecycle state, so it lives
 * here rather than in the cache: while a stream is mounted, its status frames are the only lifecycle writer, because a
 * `desktop.updated` can be a backlogged event older than the last frame. Without a stream, events are the only writer.
 */
const streaming = new Set<string>()

export function setDesktopStreamActive(taskId: string, active: boolean): void {
  if (active) streaming.add(taskId)
  else streaming.delete(taskId)
}

export function isDesktopStreamActive(taskId: string): boolean {
  return streaming.has(taskId)
}

/**
 * Tracks which task's status frames are authoritative in this tab. A session claims it when its first frame arrives
 * (the socket is open and delivering truth) and releases it on close, so a disconnected viewer lets the task events
 * and REST snapshots drive the lifecycle again instead of holding stale authority forever.
 */
export class DesktopStreamAuthority {
  private taskId: string | null = null

  /** A status frame arrived from an open socket: it is now the lifecycle writer for this task. */
  frame(taskId: string): void {
    if (this.taskId === taskId) return
    this.close()
    setDesktopStreamActive(taskId, true)
    this.taskId = taskId
  }

  /** The socket closed or the session ended: events and snapshots may write the lifecycle again. */
  close(): void {
    if (this.taskId === null) return
    setDesktopStreamActive(this.taskId, false)
    this.taskId = null
  }
}

/**
 * The one writer of the desktop lifecycle cache. Every writer (status frame, `desktop.updated`, mutation response)
 * goes through it.
 *
 * Source priority is live stream > event > mutation. While a stream is mounted (`streamActive`), an event is ignored:
 * the frames are level truth for the lifecycle and the event stream may be catching up. A mutation response may only
 * land if nothing else wrote the entry since the mutation started (`base` is the entry captured in `onMutate`), so a
 * response that raced a newer event or status frame cannot roll the desktop back. Equal sources are last-write-wins.
 */
export function applyDesktopStatus(
  current: DesktopStatusValue | undefined,
  status: DesktopStatus,
  source: DesktopStatusSource,
  base?: DesktopStatusValue | undefined,
  streamActive = false,
): DesktopStatusValue {
  if (source === "event" && streamActive && current !== undefined) return current
  if (source === "mutation" && base !== undefined && current !== undefined && current.revision !== base.revision) {
    return current
  }
  return { status, source, revision: (current?.revision ?? 0) + 1 }
}
