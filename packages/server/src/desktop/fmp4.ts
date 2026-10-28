/**
 * Fragmented-MP4 muxer for the desktop stream. It reads the encoder's FLV stdout (see `flv.ts`) and writes the
 * wire format the clients read: an init segment (ftyp + moov with one avc1 track and mvex defaults), then one
 * moof + mdat per frame. Each frame is muxed the moment its FLV tag completes, so no frame waits for the next.
 *
 * Each media piece holds exactly one copy of its frame's bytes.
 */
import { FlvDemuxer } from "./flv"

export type Mp4Piece =
  | { readonly kind: "init"; readonly bytes: Uint8Array; /** RFC 6381 codec string from the avcC record, e.g. `avc1.640028`. */ readonly codec: string }
  | { readonly kind: "media"; readonly bytes: Uint8Array; /** The frame is an IDR (sync) sample. */ readonly keyframe: boolean }

/** Track timescale: the usual 90 kHz video clock. */
const TIMESCALE = 90_000
/** Capture rate. The encoder runs constant frame rate at 60 fps (`-r 60`), so every frame is exactly one frame duration. */
const FPS = 60
const FRAME_TICKS = TIMESCALE / FPS

// The timeline counts frames in arrival order and never follows the wall clock. Chromium's MSE drops every
// non-keyframe that follows a timeline gap, until the next keyframe, so an idle pause or a dropped tag must not
// leave a hole. A paused stream simply resumes at the next frame; the client's live-edge follow handles any lag.

const TFHD_DEFAULT_BASE_IS_MOOF = 0x02_0000
const TRUN_DATA_OFFSET = 0x01
const TRUN_FIRST_SAMPLE_FLAGS = 0x04
const TRUN_SAMPLE_DURATION = 0x100
const TRUN_SAMPLE_SIZE = 0x200
/** sample_depends_on = 2 (does not depend on others): a sync sample. */
const SAMPLE_SYNC = 0x0200_0000
/** sample_depends_on = 1 and is_non_sync_sample: the flags the client reads as "not a keyframe". */
const SAMPLE_NON_SYNC = 0x0101_0000
const MATRIX_IDENTITY = [0x0001_0000, 0, 0, 0, 0x0001_0000, 0, 0, 0, 0x4000_0000]

const ascii = (s: string): Uint8Array => Uint8Array.from(s, (c) => c.charCodeAt(0))
const zeros = (n: number): Uint8Array => new Uint8Array(n)

const cat = (parts: readonly Uint8Array[]): Uint8Array => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0))
  let at = 0
  for (const p of parts) {
    out.set(p, at)
    at += p.length
  }
  return out
}

const u8 = (...vs: number[]): Uint8Array => Uint8Array.from(vs)

const u16 = (...vs: number[]): Uint8Array => {
  const out = new Uint8Array(vs.length * 2)
  const view = new DataView(out.buffer)
  vs.forEach((v, i) => view.setUint16(i * 2, v))
  return out
}

const u32 = (...vs: number[]): Uint8Array => {
  const out = new Uint8Array(vs.length * 4)
  const view = new DataView(out.buffer)
  vs.forEach((v, i) => view.setUint32(i * 4, v >>> 0))
  return out
}

const u64 = (v: number): Uint8Array => {
  const out = new Uint8Array(8)
  new DataView(out.buffer).setBigUint64(0, BigInt(v))
  return out
}

const box = (type: string, ...parts: Uint8Array[]): Uint8Array => {
  const body = cat(parts)
  return cat([u32(body.length + 8), ascii(type), body])
}

const fullBox = (type: string, version: number, flags: number, ...parts: Uint8Array[]): Uint8Array =>
  box(type, u8(version, (flags >>> 16) & 0xff, (flags >>> 8) & 0xff, flags & 0xff), ...parts)

const MATRIX = u32(...MATRIX_IDENTITY)

const initSegment = (avcc: Uint8Array, width: number, height: number): Uint8Array => {
  const avc1 = box(
    "avc1",
    zeros(6),
    u16(1),
    zeros(16),
    u16(width, height),
    u32(0x0048_0000, 0x0048_0000),
    u32(0),
    u16(1),
    zeros(32),
    u16(0x18),
    u16(0xffff),
    box("avcC", avcc),
  )
  const stbl = box(
    "stbl",
    fullBox("stsd", 0, 0, u32(1), avc1),
    fullBox("stts", 0, 0, u32(0)),
    fullBox("stsc", 0, 0, u32(0)),
    fullBox("stsz", 0, 0, u32(0, 0)),
    fullBox("stco", 0, 0, u32(0)),
  )
  const minf = box(
    "minf",
    fullBox("vmhd", 0, 1, zeros(8)),
    box("dinf", fullBox("dref", 0, 0, u32(1), fullBox("url ", 0, 1))),
    stbl,
  )
  const mdia = box(
    "mdia",
    fullBox("mdhd", 0, 0, u32(0, 0, TIMESCALE, 0), u16(0x55c4, 0)),
    fullBox("hdlr", 0, 0, u32(0), ascii("vide"), zeros(12), ascii("VideoHandler"), zeros(1)),
    minf,
  )
  const trak = box(
    "trak",
    fullBox("tkhd", 0, 3, u32(0, 0, 1, 0, 0), zeros(8), u16(0, 0, 0, 0), MATRIX, u32(width * 0x1_0000, height * 0x1_0000)),
    mdia,
  )
  const moov = box(
    "moov",
    fullBox("mvhd", 0, 0, u32(0, 0, TIMESCALE, 0, 0x0001_0000), u16(0x0100, 0), u32(0, 0), MATRIX, zeros(24), u32(2)),
    trak,
    box("mvex", fullBox("trex", 0, 0, u32(1, 1, 0, 0, SAMPLE_NON_SYNC))),
  )
  return cat([box("ftyp", ascii("isom"), u32(0x200), ascii("isom"), ascii("iso5"), ascii("iso6"), ascii("avc1"), ascii("mp41")), moov])
}

const moofBox = (sequence: number, dts: number, duration: number, size: number, keyframe: boolean, dataOffset: number): Uint8Array =>
  box(
    "moof",
    fullBox("mfhd", 0, 0, u32(sequence)),
    box(
      "traf",
      fullBox("tfhd", 0, TFHD_DEFAULT_BASE_IS_MOOF, u32(1)),
      fullBox("tfdt", 1, 0, u64(dts)),
      fullBox(
        "trun",
        0,
        TRUN_DATA_OFFSET | TRUN_FIRST_SAMPLE_FLAGS | TRUN_SAMPLE_DURATION | TRUN_SAMPLE_SIZE,
        u32(1, dataOffset, keyframe ? SAMPLE_SYNC : SAMPLE_NON_SYNC, duration, size),
      ),
    ),
  )

/** Every moof has the same size whatever its values, so the mdat payload offset is a constant. */
const MOOF_BYTES = moofBox(0, 0, 0, 0, false, 0).length

const mediaFragment = (sequence: number, dts: number, duration: number, payload: Uint8Array, keyframe: boolean): Uint8Array => {
  const moof = moofBox(sequence, dts, duration, payload.length, keyframe, MOOF_BYTES + 8)
  return cat([moof, u32(payload.length + 8), ascii("mdat"), payload])
}

const avcCodec = (avcc: Uint8Array): string => {
  if (avcc.length < 4) throw new Error("H.264 avcC record is truncated")
  const hex = (v: number) => v.toString(16).padStart(2, "0")
  return `avc1.${hex(avcc[1]!)}${hex(avcc[2]!)}${hex(avcc[3]!)}`
}

export class Mp4Muxer {
  private readonly demuxer = new FlvDemuxer()
  private readonly width: number
  private readonly height: number
  private configured = false
  private sequence = 0

  constructor(width: number, height: number) {
    this.width = width
    this.height = height
  }

  /** Feeds encoder stdout and returns the pieces it completes, in order. Throws on a stream that is not H.264 FLV. */
  push(chunk: Uint8Array): Mp4Piece[] {
    const pieces: Mp4Piece[] = []
    for (const event of this.demuxer.push(chunk)) {
      if (event.kind === "config") {
        this.configured = true
        pieces.push({ kind: "init", bytes: initSegment(event.avcc, this.width, this.height), codec: avcCodec(event.avcc) })
        continue
      }
      if (!this.configured) throw new Error("H.264 frame before the sequence header")
      this.sequence += 1
      const decodeTime = (this.sequence - 1) * FRAME_TICKS
      pieces.push({ kind: "media", bytes: mediaFragment(this.sequence, decodeTime, FRAME_TICKS, event.data, event.keyframe), keyframe: event.keyframe })
    }
    return pieces
  }
}
