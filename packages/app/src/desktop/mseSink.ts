/** Keep this much media behind the playhead; older data is removed from the SourceBuffer. */
const KEEP_BEHIND_S = 10
/** If the playhead falls further than this behind the live edge, jump forward. */
const LIVE_EDGE_S = 1.5

/**
 * Feeds fragmented MP4 chunks (init segment first, then moof+mdat fragments) into a
 * MediaSource attached to `video`. Appends are serialized through a queue.
 */
export class MseSink {
  private readonly mediaSource = new MediaSource()
  private readonly objectUrl: string
  private sourceBuffer: SourceBuffer | null = null
  private queue: Uint8Array<ArrayBuffer>[] = []
  private closed = false

  constructor(
    private readonly video: HTMLVideoElement,
    private readonly mime: string,
    private readonly onError: (message: string) => void,
  ) {
    this.objectUrl = URL.createObjectURL(this.mediaSource)
    video.src = this.objectUrl
    this.mediaSource.addEventListener("sourceopen", () => this.open())
  }

  push(chunk: Uint8Array<ArrayBuffer>): void {
    if (this.closed) return
    this.queue.push(chunk)
    this.pump()
  }

  close(): void {
    if (this.closed) return
    this.closed = true
    this.queue = []
    if (this.mediaSource.readyState === "open") {
      try {
        this.mediaSource.endOfStream()
      } catch {
        // A pending update prevents endOfStream; the object URL is revoked below regardless.
      }
    }
    URL.revokeObjectURL(this.objectUrl)
    this.video.removeAttribute("src")
    this.video.load()
  }

  private open(): void {
    try {
      this.sourceBuffer = this.mediaSource.addSourceBuffer(this.mime)
    } catch (e) {
      this.onError(`Browser cannot decode ${this.mime}: ${String(e)}`)
      return
    }
    this.sourceBuffer.addEventListener("updateend", () => this.pump())
    this.pump()
  }

  private pump(): void {
    const sb = this.sourceBuffer
    if (this.closed || !sb || sb.updating) return
    if (this.trim(sb)) return
    this.followLiveEdge(sb)
    const chunk = this.queue.shift()
    if (!chunk) return
    try {
      sb.appendBuffer(chunk)
    } catch (e) {
      this.queue.unshift(chunk)
      this.onError(`Desktop stream buffer error: ${String(e)}`)
    }
  }

  /** Starts removing media older than KEEP_BEHIND_S; returns true when a removal was started. */
  private trim(sb: SourceBuffer): boolean {
    if (sb.buffered.length === 0) return false
    const keepFrom = this.video.currentTime - KEEP_BEHIND_S
    if (keepFrom <= sb.buffered.start(0)) return false
    sb.remove(0, keepFrom)
    return true
  }

  private followLiveEdge(sb: SourceBuffer): void {
    if (sb.buffered.length === 0) return
    const start = sb.buffered.start(0)
    const end = sb.buffered.end(sb.buffered.length - 1)
    if (this.video.currentTime < start) {
      this.video.currentTime = start
    } else if (end - this.video.currentTime > LIVE_EDGE_S) {
      this.video.currentTime = end - 0.1
    }
  }
}
