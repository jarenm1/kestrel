/**
 * Minimal fragmented-MP4 splitter for ffmpeg's stdout, written with
 * `-movflags empty_moov+default_base_moof+frag_every_frame`: one `moof` + `mdat` pair per encoded frame.
 *
 * The splitter emits the init segment (everything before the first `moof`) once, then one media piece per
 * `moof` + `mdat` pair. Each media piece is a single copy of its bytes; bytes are only buffered while a box is
 * incomplete, and the buffer is reused rather than reallocated for every chunk.
 */

export type Mp4Piece =
  | { readonly kind: "init"; readonly bytes: Uint8Array }
  | { readonly kind: "media"; readonly bytes: Uint8Array; /** The fragment's first sample is an IDR (sync) sample. */ readonly keyframe: boolean }

const MIN_CAPACITY = 256 * 1024

/** Unsigned big-endian 32-bit read. The caller guarantees `i + 4` is in range. */
const u32 = (b: Uint8Array, i: number): number => ((b[i]! << 24) | (b[i + 1]! << 16) | (b[i + 2]! << 8) | b[i + 3]!) >>> 0

interface BoxHeader {
  readonly type: string
  /** Total box size, header included. */
  readonly size: number
  /** Header length: 8, or 16 for a 64-bit "largesize" box. */
  readonly header: number
}

const readBoxHeader = (buf: Uint8Array, at: number, end: number): BoxHeader | null => {
  if (end - at < 8) return null
  let size = u32(buf, at)
  const type = String.fromCharCode(buf[at + 4]!, buf[at + 5]!, buf[at + 6]!, buf[at + 7]!)
  let header = 8
  if (size === 1) {
    if (end - at < 16) return null
    size = u32(buf, at + 8) * 2 ** 32 + u32(buf, at + 12)
    header = 16
  } else if (size === 0) {
    // "to end of file": not produced by ffmpeg's streaming muxer; treat as unparseable.
    throw new Error(`mp4 box '${type}' with size 0 is not supported`)
  }
  if (size < header) throw new Error(`mp4 box '${type}' has invalid size ${size}`)
  return { type, size, header }
}

interface Box {
  readonly type: string
  /** Offset of the box's first byte. */
  readonly at: number
  /** Offset of the box's payload (after the header). */
  readonly body: number
  /** Offset one past the box's last byte. */
  readonly end: number
}

/** Direct children of the box range [begin, end), stopping at the first malformed or truncated box. */
const boxesIn = (buf: Uint8Array, begin: number, end: number): Box[] => {
  const out: Box[] = []
  for (let at = begin; at < end; ) {
    const h = readBoxHeader(buf, at, end)
    if (h === null || at + h.size > end) break
    out.push({ type: h.type, at, body: at + h.header, end: at + h.size })
    at += h.size
  }
  return out
}

const findBox = (buf: Uint8Array, begin: number, end: number, type: string): Box | undefined =>
  boxesIn(buf, begin, end).find((b) => b.type === type)

const SAMPLE_NON_SYNC = 0x0001_0000

/**
 * True when the first sample of a `moof` + `mdat` fragment is a sync (IDR) sample. The flag comes from the
 * first `trun` sample flags, else the per-sample flags, else the `tfhd` default (ffmpeg writes the keyframe's
 * flags in `first_sample_flags` and leaves deltas to the `tfhd` default). Unknown flags count as not a keyframe.
 */
export const isSyncFragment = (fragment: Uint8Array): boolean => {
  const moof = findBox(fragment, 0, fragment.length, "moof")
  const traf = moof ? findBox(fragment, moof.body, moof.end, "traf") : undefined
  if (!traf) return false
  const trun = findBox(fragment, traf.body, traf.end, "trun")
  if (!trun || trun.end - trun.body < 8 || u32(fragment, trun.body + 4) === 0) return false
  const trunFlags = u32(fragment, trun.body) & 0xff_ffff
  let p = trun.body + 8 // version/flags and sample_count
  if (trunFlags & 0x1) p += 4 // data_offset
  let flags: number | undefined
  if (trunFlags & 0x4) {
    flags = u32(fragment, p) // first_sample_flags
  } else if (trunFlags & 0x400) {
    // Per-sample flags: skip the duration and size fields that precede them in sample 0.
    if (trunFlags & 0x100) p += 4
    if (trunFlags & 0x200) p += 4
    flags = u32(fragment, p)
  } else {
    const tfhd = findBox(fragment, traf.body, traf.end, "tfhd")
    if (tfhd && (u32(fragment, tfhd.body) & 0x20) !== 0) {
      // Optional tfhd fields in order, then default_sample_flags.
      let q = tfhd.body + 8 // version/flags and track_ID
      const tfhdFlags = u32(fragment, tfhd.body) & 0xff_ffff
      if (tfhdFlags & 0x1) q += 8 // base_data_offset
      if (tfhdFlags & 0x2) q += 4 // sample_description_index
      if (tfhdFlags & 0x8) q += 4 // default_sample_duration
      if (tfhdFlags & 0x10) q += 4 // default_sample_size
      flags = u32(fragment, q)
    }
  }
  return flags !== undefined && (flags & SAMPLE_NON_SYNC) === 0
}

export class Mp4Splitter {
  /** Backing store. Valid bytes are [start, end); everything before `start` is already emitted. */
  private buf = new Uint8Array(0)
  private start = 0
  private end = 0
  /** Next top-level box to examine. Always >= start. */
  private cursor = 0
  /** Offset of the `moof` of the fragment being assembled, or -1 between fragments. */
  private fragStart = -1
  private initEmitted = false

  /** Feed raw bytes; returns completed pieces in stream order. */
  push(data: Uint8Array): Mp4Piece[] {
    this.reserve(data.length)
    this.buf.set(data, this.end)
    this.end += data.length
    const out: Mp4Piece[] = []
    for (;;) {
      const h = readBoxHeader(this.buf, this.cursor, this.end)
      if (h === null || this.end - this.cursor < h.size) break
      const at = this.cursor
      this.cursor += h.size
      if (h.type === "moof") {
        if (!this.initEmitted) {
          out.push({ kind: "init", bytes: this.buf.slice(this.start, at) })
          this.initEmitted = true
        }
        // A moof while another fragment is incomplete drops the incomplete one.
        this.start = at
        this.fragStart = at
      } else if (this.fragStart >= 0) {
        if (h.type === "mdat") {
          const bytes = this.buf.slice(this.start, this.cursor)
          out.push({ kind: "media", bytes, keyframe: isSyncFragment(bytes) })
          this.start = this.cursor
          this.fragStart = -1
        }
      } else if (this.initEmitted) {
        // Stray top-level box between fragments: not part of any fragment.
        this.start = this.cursor
      }
    }
    return out
  }

  /** Makes room for `n` more bytes after `end`, compacting or growing the backing store as needed. */
  private reserve(n: number): void {
    if (this.end + n <= this.buf.length) return
    const live = this.end - this.start
    if (live + n > this.buf.length) {
      const grown = new Uint8Array(Math.max(live + n, this.buf.length * 2, MIN_CAPACITY))
      grown.set(this.buf.subarray(this.start, this.end))
      this.buf = grown
    } else {
      this.buf.copyWithin(0, this.start, this.end)
    }
    const shift = this.start
    this.cursor -= shift
    this.end -= shift
    if (this.fragStart >= 0) this.fragStart -= shift
    this.start = 0
  }
}

/**
 * Builds the RFC 6381 codec string (`avc1.PPCCLL`) from the avcC box in the init segment,
 * i.e. the profile_idc / constraint flags / level_idc actually written by the encoder.
 */
export const avcCodecString = (init: Uint8Array): string | null => {
  const tag = [0x61, 0x76, 0x63, 0x43] // "avcC"
  for (let i = 0; i + 8 <= init.length; i++) {
    if (init[i] !== tag[0] || init[i + 1] !== tag[1] || init[i + 2] !== tag[2] || init[i + 3] !== tag[3]) continue
    // payload starts after the 'avcC' type: configurationVersion, profile, compat, level
    const p = i + 4
    const hex = (n: number) => n.toString(16).toUpperCase().padStart(2, "0")
    return `avc1.${hex(init[p + 1]!)}${hex(init[p + 2]!)}${hex(init[p + 3]!)}`
  }
  return null
}
