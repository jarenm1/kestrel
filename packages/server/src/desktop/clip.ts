/**
 * The inverse of `flv.ts`: muxes the H.264 access units the desktop encoder produces into an FLV stream.
 *
 * A recording writes the file header once, then the AVC sequence header (the encoder's raw avcC record), then one
 * video tag per access unit. Tags use the same layout the demuxer reads: an 11-byte header whose timestamp is in
 * milliseconds, the AVC video packet header, the length-prefixed access unit, and the previous tag's size. The caller
 * supplies elapsed milliseconds and whether the access unit is a keyframe; this module only encodes them.
 */

const FLV_VERSION = 1
const FLV_FLAGS_VIDEO = 0x01
const FLV_HEADER_BYTES = 9
const PREV_TAG_SIZE_BYTES = 4
const TAG_HEADER_BYTES = 11
const TAG_TYPE_VIDEO = 9
const CODEC_AVC = 7
const FRAME_KEY = 1
const FRAME_INTER = 2
const AVC_SEQUENCE_HEADER = 0
const AVC_NALU = 1
/** Frame type + codec (1 byte), AVC packet type (1 byte), composition time offset (3 bytes). */
const AVC_VIDEO_HEADER_BYTES = 5
const MAX_TIMESTAMP_MS = 0xffffffff

/** The 9-byte FLV file header plus the first PreviousTagSize field. */
export const flvHeader = (): Uint8Array => {
  const bytes = new Uint8Array(FLV_HEADER_BYTES + PREV_TAG_SIZE_BYTES)
  bytes.set([0x46, 0x4c, 0x56, FLV_VERSION, FLV_FLAGS_VIDEO, 0, 0, 0, FLV_HEADER_BYTES])
  return bytes
}

const tag = (timestampMs: number, body: Uint8Array): Uint8Array => {
  const timestamp = Math.max(0, Math.min(MAX_TIMESTAMP_MS, Math.floor(timestampMs)))
  const bytes = new Uint8Array(TAG_HEADER_BYTES + body.length + PREV_TAG_SIZE_BYTES)
  bytes[0] = TAG_TYPE_VIDEO
  bytes[1] = (body.length >>> 16) & 0xff
  bytes[2] = (body.length >>> 8) & 0xff
  bytes[3] = body.length & 0xff
  // Timestamp: a UI24 in big-endian byte order (like every FLV multi-byte integer), then its high 8 bits.
  bytes[4] = (timestamp >>> 16) & 0xff
  bytes[5] = (timestamp >>> 8) & 0xff
  bytes[6] = timestamp & 0xff
  bytes[7] = (timestamp >>> 24) & 0xff
  bytes.set(body, TAG_HEADER_BYTES)
  const previousSize = TAG_HEADER_BYTES + body.length
  const at = TAG_HEADER_BYTES + body.length
  bytes[at] = (previousSize >>> 24) & 0xff
  bytes[at + 1] = (previousSize >>> 16) & 0xff
  bytes[at + 2] = (previousSize >>> 8) & 0xff
  bytes[at + 3] = previousSize & 0xff
  return bytes
}

const avcBody = (keyframe: boolean, packetType: number, payload: Uint8Array): Uint8Array => {
  const body = new Uint8Array(AVC_VIDEO_HEADER_BYTES + payload.length)
  body[0] = ((keyframe ? FRAME_KEY : FRAME_INTER) << 4) | CODEC_AVC
  body[1] = packetType
  body.set(payload, AVC_VIDEO_HEADER_BYTES)
  return body
}

/** Writes a stream as it is produced; the recorder hands it a file's write callback. */
export class FlvMuxer {
  private started = false
  private lastTimestamp = 0

  constructor(private readonly write: (bytes: Uint8Array) => void) {}

  /** The file header. Called implicitly by the first tag; calling it again writes nothing. */
  header(): void {
    if (this.started) return
    this.started = true
    this.write(flvHeader())
  }

  /** The AVC sequence header, exactly the avcC record the encoder reported. Re-sending one after an encoder restart is valid. */
  sequenceHeader(avcc: Uint8Array, timestampMs = this.lastTimestamp): void {
    this.header()
    this.write(tag(timestampMs, avcBody(true, AVC_SEQUENCE_HEADER, avcc)))
  }

  /** One length-prefixed (AVCC) access unit. Timestamps never go backwards, even if the caller's clock does. */
  videoTag(au: Uint8Array, keyframe: boolean, elapsedMs: number): void {
    this.header()
    const timestamp = Math.max(this.lastTimestamp, Math.max(0, Math.floor(elapsedMs)))
    this.lastTimestamp = timestamp
    this.write(tag(timestamp, avcBody(keyframe, AVC_NALU, au)))
  }
}
