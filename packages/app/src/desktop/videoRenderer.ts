import { isInitSegment, parseFragment, parseInit, type Sample, type VideoInit } from "./fmp4"

/**
 * Deltas are dropped (until the next keyframe) once the decoder holds more than this many chunks. A joining
 * viewer receives the server's cached GOP (keyframe + up to 4 s of deltas) in one burst, which decodes in a
 * fraction of a second; a low cap would throw that replay away and freeze on the keyframe until the next one.
 * This only guards against a decoder that is falling behind for good.
 */
const MAX_DECODE_QUEUE = 300

export interface RenderStats {
  /** Frames drawn to the canvas over the last second. */
  fps: number
  /** Mean decoder latency (chunk submitted to frame output) over the last second, in ms. */
  decodeMs: number
}

/** Codec string from a MediaSource-style mime, e.g. `video/mp4; codecs="avc1.640028"` -> `avc1.640028`. */
export function codecFromMime(mime: string): string {
  const match = /codecs="([^"]+)"/.exec(mime)
  if (!match) throw new Error(`no codec in ${mime}`)
  return match[1]!
}

/**
 * Decodes the desktop fMP4 stream with WebCodecs and paints the newest decoded frame to a canvas
 * once per animation frame. Frames the screen can't show in time are dropped, not queued.
 */
export class VideoRenderer {
  private readonly ctx: CanvasRenderingContext2D
  private readonly codec: string
  private init: VideoInit | null = null
  private decoder: VideoDecoder | null = null
  /** Waits for a keyframe: at start, after a decoder error, and after dropping deltas for latency. */
  private awaitingKey = true
  private pending: VideoFrame | null = null
  private frameRequest = 0
  private submitted = new Map<number, number>()
  private failed = false
  private drawn = 0
  private decodedCount = 0
  private decodeMsSum = 0
  private statsTimer: number
  private closed = false

  constructor(
    private readonly canvas: HTMLCanvasElement,
    mime: string,
    private readonly onStats: (stats: RenderStats) => void,
    private readonly onError: (message: string | null) => void,
  ) {
    const ctx = canvas.getContext("2d")
    if (!ctx) throw new Error("canvas 2d context unavailable")
    this.ctx = ctx
    this.codec = codecFromMime(mime)
    this.statsTimer = window.setInterval(() => this.publishStats(), 1000)
  }

  /** Feeds one binary frame: an init segment (configures the decoder) or a moof+mdat fragment. */
  push(bytes: Uint8Array<ArrayBuffer>): void {
    if (this.closed) return
    if (isInitSegment(bytes)) {
      this.configure(parseInit(bytes))
      return
    }
    if (!this.init) return
    for (const sample of parseFragment(bytes, this.init)) this.submit(sample)
  }

  close(): void {
    if (this.closed) return
    this.closed = true
    window.clearInterval(this.statsTimer)
    window.cancelAnimationFrame(this.frameRequest)
    this.pending?.close()
    this.pending = null
    this.decoder?.close()
    this.decoder = null
    this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height)
  }

  /** A new init segment (first of the connection, or an encoder restart) reconfigures the decoder. */
  private configure(init: VideoInit): void {
    this.init = init
    this.awaitingKey = true
    this.openDecoder()
  }

  private openDecoder(): void {
    if (!this.init) return
    if (!this.decoder) {
      this.decoder = new VideoDecoder({
        output: (frame) => this.onFrame(frame),
        error: (e) => this.onDecodeError(e),
      })
    }
    this.decoder.configure({
      codec: this.codec,
      description: this.init.description,
      codedWidth: this.init.codedWidth,
      codedHeight: this.init.codedHeight,
      optimizeForLatency: true,
      hardwareAcceleration: "no-preference",
    })
  }

  private submit(sample: Sample): void {
    if (sample.key) {
      if (!this.decoder) this.openDecoder()
      this.awaitingKey = false
    } else if (this.awaitingKey || !this.decoder) {
      return
    } else if (this.decoder.decodeQueueSize > MAX_DECODE_QUEUE) {
      // Decoding is behind: skip to the next keyframe rather than letting latency grow.
      this.awaitingKey = true
      return
    }
    const decoder = this.decoder
    if (!decoder || decoder.state !== "configured") return
    this.submitted.set(sample.timestampUs, performance.now())
    decoder.decode(
      new EncodedVideoChunk({
        type: sample.key ? "key" : "delta",
        timestamp: sample.timestampUs,
        duration: sample.durationUs,
        data: sample.data,
      }),
    )
  }

  private onFrame(frame: VideoFrame): void {
    if (this.closed) {
      frame.close()
      return
    }
    const started = this.submitted.get(frame.timestamp)
    if (started !== undefined) {
      this.submitted.delete(frame.timestamp)
      this.decodeMsSum += performance.now() - started
      this.decodedCount++
    }
    if (this.failed) {
      this.failed = false
      this.onError(null)
    }
    this.pending?.close()
    this.pending = frame
    if (this.frameRequest === 0) this.frameRequest = window.requestAnimationFrame(() => this.draw())
  }

  private draw(): void {
    this.frameRequest = 0
    const frame = this.pending
    if (!frame) return
    this.pending = null
    if (this.canvas.width !== frame.displayWidth || this.canvas.height !== frame.displayHeight) {
      this.canvas.width = frame.displayWidth
      this.canvas.height = frame.displayHeight
    }
    this.ctx.drawImage(frame, 0, 0)
    frame.close()
    this.drawn++
  }

  private onDecodeError(e: DOMException): void {
    // The decoder is closed by the browser; restart at the next keyframe.
    console.warn("desktop decoder error", e)
    this.decoder = null
    this.awaitingKey = true
    this.failed = true
    this.onError(`Desktop decoder error: ${e.message}`)
  }

  private publishStats(): void {
    this.onStats({
      fps: this.drawn,
      decodeMs: this.decodedCount === 0 ? 0 : this.decodeMsSum / this.decodedCount,
    })
    this.drawn = 0
    this.decodedCount = 0
    this.decodeMsSum = 0
    this.submitted.clear()
  }
}
