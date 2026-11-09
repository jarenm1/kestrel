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
