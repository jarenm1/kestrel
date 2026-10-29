import type { MediaKind } from "./manager"

/** Flushes a held bundle early once it carries this many bytes, so a keyframe burst does not grow without bound. */
const MAX_BUNDLE_BYTES = 1024 * 1024

export interface BundleClock {
  readonly now: () => number
  readonly setTimeout: (callback: () => void, ms: number) => unknown
  readonly clearTimeout: (timer: unknown) => void
}

/** A timer handle from either the DOM or Node typings. */
type TimerHandle = number | NodeJS.Timeout

const systemClock: BundleClock = {
  now: () => performance.now(),
  setTimeout: (callback, ms) => setTimeout(callback, ms),
  clearTimeout: (timer) => clearTimeout(timer as TimerHandle),
}

/**
 * Coalesces desktop media fragments into at most one WebSocket message per `windowMs`, trading smoothness for fewer
 * relayed messages (each incoming relay message is billed; outgoing ones are free). The first fragment after a quiet
 * period goes out at once, so a lone keystroke or click costs no added latency; fragments arriving while a bundle is
 * held are concatenated into it and go out together at most `windowMs` after the last emit. `windowMs <= 0` passes
 * every fragment through on its own.
 */
export class MediaBundler {
  private pending: Uint8Array[] = []
  private pendingBytes = 0
  private pendingKind: MediaKind | null = null
  private timer: unknown = null
  private lastEmit: number | null = null

  constructor(
    private readonly windowMs: number,
    private readonly emit: (chunk: Uint8Array, kind: MediaKind) => void,
    private readonly clock: BundleClock = systemClock,
  ) {}

  push(chunk: Uint8Array, kind: MediaKind): void {
    const now = this.clock.now()
    if (this.windowMs <= 0) {
      this.emitNow(chunk, kind, now)
      return
    }
    if (kind === "init") {
      // Init segments describe the decoder's parameters; they never share a message with media and never wait.
      this.flush(now)
      this.emitNow(chunk, kind, now)
      return
    }
    if (kind === "key") {
      // A bundle never carries a keyframe after deltas: flush the deltas, then start over with the keyframe.
      this.flush(now)
    }
    if (this.pending.length === 0 && this.quiet(now)) {
      this.emitNow(chunk, kind, now)
      return
    }
    this.pending.push(chunk)
    this.pendingBytes += chunk.byteLength
    if (this.pendingKind === null) this.pendingKind = kind
    if (this.pendingBytes >= MAX_BUNDLE_BYTES) {
      this.flush(now)
      return
    }
    if (this.timer === null) {
      const at = (this.lastEmit ?? now) + this.windowMs
      this.timer = this.clock.setTimeout(() => {
        this.timer = null
        this.flush(this.clock.now())
      }, Math.max(0, at - now))
    }
  }

  /** Stops the timer and drops anything pending. */
  close(): void {
    if (this.timer !== null) {
      this.clock.clearTimeout(this.timer)
      this.timer = null
    }
    this.pending = []
    this.pendingBytes = 0
    this.pendingKind = null
  }

  /** Whether no emit has happened within the last window. */
  private quiet(now: number): boolean {
    return this.lastEmit === null || now - this.lastEmit >= this.windowMs
  }

  private emitNow(chunk: Uint8Array, kind: MediaKind, now: number): void {
    this.lastEmit = now
    this.emit(chunk, kind)
  }

  /** Emits what is held now, as one message. Call it before sending anything else to the viewer, to keep order. */
  flush(now: number = this.clock.now()): void {
    if (this.timer !== null) {
      this.clock.clearTimeout(this.timer)
      this.timer = null
    }
    if (this.pending.length === 0 || this.pendingKind === null) return
    const kind = this.pendingKind
    const chunk = new Uint8Array(this.pendingBytes)
    let at = 0
    for (const part of this.pending) {
      chunk.set(part, at)
      at += part.byteLength
    }
    this.pending = []
    this.pendingBytes = 0
    this.pendingKind = null
    this.emitNow(chunk, kind, now)
  }
}
