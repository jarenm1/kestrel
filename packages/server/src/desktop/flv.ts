/**
 * Incremental FLV demuxer for the H.264 video tags of ffmpeg's `-f flv` stdout.
 *
 * A video tag declares its payload size before the payload, so a frame is complete the moment its last byte
 * arrives: the caller can mux and send it without waiting for the next frame. The AVC sequence header tag carries
 * the avcC record, and each NALU tag carries one length-prefixed (AVCC) access unit. Composition offsets are
 * ignored because the encoder runs with `-bf 0`, so decode order equals presentation order.
 */

export type FlvEvent =
  | { readonly kind: "config"; readonly avcc: Uint8Array }
  | { readonly kind: "frame"; /** Decode timestamp in milliseconds. */ readonly dts: number; readonly keyframe: boolean; readonly data: Uint8Array }

const FLV_SIGNATURE = [0x46, 0x4c, 0x56] // "FLV"
const FLV_HEADER_BYTES = 9
const PREV_TAG_SIZE_BYTES = 4
const TAG_HEADER_BYTES = 11
const TAG_VIDEO = 9
const CODEC_AVC = 7
const FRAME_KEY = 1
const AVC_SEQUENCE_HEADER = 0
const AVC_NALU = 1
/** Frame type (1 byte) + AVC packet type (1 byte) + composition time offset (3 bytes) before the AVC payload. */
const AVC_VIDEO_HEADER_BYTES = 5
const MIN_CAPACITY = 256 * 1024

const u24 = (b: Uint8Array, i: number): number => (b[i]! << 16) | (b[i + 1]! << 8) | b[i + 2]!

/** Accepts stream chunks of any size and returns the events each chunk completes. */
export class FlvDemuxer {
  private buf = new Uint8Array(MIN_CAPACITY)
  private start = 0
  private end = 0
  private headerRead = false

  /**
   * Returns the events completed by `chunk`. A frame's `data` is a view into the internal buffer and is only valid
   * until the next `push`.
   */
  push(chunk: Uint8Array): FlvEvent[] {
    this.append(chunk)
    const events: FlvEvent[] = []
    for (;;) {
      if (!this.headerRead) {
        if (this.end - this.start < FLV_HEADER_BYTES + PREV_TAG_SIZE_BYTES) break
        if (FLV_SIGNATURE.some((c, i) => this.buf[this.start + i] !== c)) throw new Error("ffmpeg output is not FLV")
        this.start += FLV_HEADER_BYTES + PREV_TAG_SIZE_BYTES
        this.headerRead = true
        continue
      }
      if (this.end - this.start < TAG_HEADER_BYTES) break
      const at = this.start
      const dataSize = u24(this.buf, at + 1)
      const tagEnd = at + TAG_HEADER_BYTES + dataSize + PREV_TAG_SIZE_BYTES
      if (tagEnd > this.end) break
      if ((this.buf[at]! & 0x1f) === TAG_VIDEO) this.videoTag(at + TAG_HEADER_BYTES, at + TAG_HEADER_BYTES + dataSize, events, at)
      this.start = tagEnd
    }
    return events
  }

  private videoTag(body: number, bodyEnd: number, events: FlvEvent[], tagAt: number): void {
    const b = this.buf
    const frameType = b[body]! >> 4
    const codec = b[body]! & 0x0f
    if (codec !== CODEC_AVC) throw new Error(`unexpected FLV video codec ${codec}`)
    const packetType = b[body + 1]
    const payload = body + AVC_VIDEO_HEADER_BYTES
    if (packetType === AVC_SEQUENCE_HEADER) events.push({ kind: "config", avcc: b.slice(payload, bodyEnd) })
    else if (packetType === AVC_NALU) {
      const dts = ((b[tagAt + 7]! << 24) | u24(b, tagAt + 4)) >>> 0
      events.push({ kind: "frame", dts, keyframe: frameType === FRAME_KEY, data: b.subarray(payload, bodyEnd) })
    }
  }

  /** Appends `chunk`, first compacting or growing the buffer so that the unconsumed bytes stay contiguous. */
  private append(chunk: Uint8Array): void {
    const live = this.end - this.start
    if (this.end + chunk.length > this.buf.length) {
      const need = live + chunk.length
      const next = need > this.buf.length ? new Uint8Array(Math.max(need, 2 * this.buf.length)) : this.buf
      next.set(this.buf.subarray(this.start, this.end))
      this.buf = next
      this.start = 0
      this.end = live
    }
    this.buf.set(chunk, this.end)
    this.end += chunk.length
  }
}
