/**
 * Minimal ISO-BMFF reader for the fragmented H.264 stream the desktop server emits
 * (`ffmpeg -movflags empty_moov+default_base_moof+frag_keyframe`). It reads only what
 * WebCodecs needs: the init segment (avcC, coded size, timescale, trex defaults) and
 * moof+mdat fragments (per-sample offsets, sizes, durations, sync flags, timestamps).
 */

export interface VideoInit {
  /** AVCDecoderConfigurationRecord (avcC payload), the VideoDecoderConfig.description for AVCC samples. */
  description: Uint8Array<ArrayBuffer>
  codedWidth: number
  codedHeight: number
  /** Ticks per second of the track's media timeline (mdhd). */
  timescale: number
  /** trex defaults keyed by track ID; fragments fall back to these when tfhd/trun omit a value. */
  trex: Map<number, TrexDefaults>
}

export interface TrexDefaults {
  duration: number
  size: number
  flags: number
}

export interface Sample {
  key: boolean
  /** Presentation timestamp in microseconds. */
  timestampUs: number
  durationUs: number
  /** One length-prefixed (AVCC) access unit, a view into the fragment bytes. */
  data: Uint8Array<ArrayBuffer>
}

interface Box {
  type: string
  /** Offset of the box header. */
  start: number
  /** Offset of the box payload (after the header). */
  payload: number
  end: number
}

const NON_SYNC_BIT = 0x10000

const typeAt = (buf: Uint8Array, offset: number): string =>
  String.fromCharCode(buf[offset]!, buf[offset + 1]!, buf[offset + 2]!, buf[offset + 3]!)

function boxesIn(buf: Uint8Array<ArrayBuffer>, start: number, end: number): Box[] {
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength)
  const out: Box[] = []
  let pos = start
  while (pos < end) {
    if (pos + 8 > end) throw new Error("truncated mp4 box header")
    let size = view.getUint32(pos)
    const type = typeAt(buf, pos + 4)
    let header = 8
    if (size === 1) {
      size = Number(view.getBigUint64(pos + 8))
      header = 16
    } else if (size === 0) {
      size = end - pos
    }
    if (size < header || pos + size > end) throw new Error(`malformed mp4 box '${type}'`)
    out.push({ type, start: pos, payload: pos + header, end: pos + size })
    pos += size
  }
  return out
}

function requireBox(buf: Uint8Array<ArrayBuffer>, parent: { payload: number; end: number }, type: string): Box {
  const box = boxesIn(buf, parent.payload, parent.end).find((b) => b.type === type)
  if (!box) throw new Error(`mp4 box '${type}' missing`)
  return box
}

const u32 = (buf: Uint8Array<ArrayBuffer>, at: number): number =>
  new DataView(buf.buffer, buf.byteOffset, buf.byteLength).getUint32(at)

/** True for an init segment (first box `ftyp` or `moov`), false for a moof fragment. */
export function isInitSegment(buf: Uint8Array): boolean {
  if (buf.length < 8) return false
  const type = typeAt(buf, 4)
  return type === "ftyp" || type === "moov"
}

/** Reads the init segment: the video track's avcC, coded size, timescale and trex defaults. */
export function parseInit(buf: Uint8Array<ArrayBuffer>): VideoInit {
  const moov = requireBox(buf, { payload: 0, end: buf.length }, "moov")
  const trak = requireBox(buf, moov, "trak")
  const mdia = requireBox(buf, trak, "mdia")
  const mdhd = requireBox(buf, mdia, "mdhd")
  // mdhd v0: creation(4) modification(4) timescale(4); v1 uses 8-byte times.
  const timescale = u32(buf, mdhd.payload + (buf[mdhd.payload] === 1 ? 20 : 12))
  const minf = requireBox(buf, mdia, "minf")
  const stbl = requireBox(buf, minf, "stbl")
  const stsd = requireBox(buf, stbl, "stsd")
  // stsd is a FullBox: version/flags(4) entry_count(4), then sample entries.
  const entry = boxesIn(buf, stsd.payload + 8, stsd.end).find((b) => b.type === "avc1" || b.type === "avc3")
  if (!entry) throw new Error("no H.264 sample entry in init segment")
  // VisualSampleEntry: 8 bytes SampleEntry fields, then 16 bytes of predefined fields, then width/height.
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength)
  const codedWidth = view.getUint16(entry.payload + 24)
  const codedHeight = view.getUint16(entry.payload + 26)
  // Child boxes start after the 78-byte VisualSampleEntry fields.
  const avcC = requireBox(buf, { payload: entry.payload + 78, end: entry.end }, "avcC")

  const trex = new Map<number, TrexDefaults>()
  const mvex = boxesIn(buf, moov.payload, moov.end).find((b) => b.type === "mvex")
  if (mvex) {
    for (const box of boxesIn(buf, mvex.payload, mvex.end)) {
      if (box.type !== "trex") continue
      // trex: version/flags(4) track_ID(4) default_sample_description_index(4) default_duration(4) default_size(4) default_flags(4)
      trex.set(u32(buf, box.payload + 4), {
        duration: u32(buf, box.payload + 12),
        size: u32(buf, box.payload + 16),
        flags: u32(buf, box.payload + 20),
      })
    }
  }

  return {
    description: buf.slice(avcC.payload, avcC.end),
    codedWidth,
    codedHeight,
    timescale,
    trex,
  }
}

/**
 * Reads one moof+mdat fragment into samples in decode order. Sample data offsets are resolved
 * against the moof (default-base-is-moof, which the server's ffmpeg flags produce); a fragment
 * may carry one sample (per-frame) or many (keyframe-aligned GOP), and the timestamps come from
 * tfdt plus per-sample durations and composition offsets.
 */
export function parseFragment(buf: Uint8Array<ArrayBuffer>, init: VideoInit): Sample[] {
  const samples: Sample[] = []
  for (const moof of boxesIn(buf, 0, buf.length)) {
    if (moof.type !== "moof") continue
    for (const traf of boxesIn(buf, moof.payload, moof.end)) {
      if (traf.type !== "traf") continue
      samples.push(...parseTraf(buf, moof, traf, init))
    }
  }
  return samples
}

function parseTraf(buf: Uint8Array<ArrayBuffer>, moof: Box, traf: Box, init: VideoInit): Sample[] {
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength)
  const tfhd = requireBox(buf, traf, "tfhd")
  const tfhdFlags = u32(buf, tfhd.payload) & 0xffffff
  const trackId = u32(buf, tfhd.payload + 4)
  const trex = init.trex.get(trackId)
  let at = tfhd.payload + 8
  let base = moof.start
  if (tfhdFlags & 0x1) {
    base = Number(view.getBigUint64(at))
    at += 8
  }
  if (tfhdFlags & 0x2) at += 4
  let defaultDuration = trex?.duration ?? 0
  let defaultSize = trex?.size ?? 0
  let defaultFlags = trex?.flags ?? 0
  if (tfhdFlags & 0x8) {
    defaultDuration = u32(buf, at)
    at += 4
  }
  if (tfhdFlags & 0x10) {
    defaultSize = u32(buf, at)
    at += 4
  }
  if (tfhdFlags & 0x20) {
    defaultFlags = u32(buf, at)
  }

  const tfdt = requireBox(buf, traf, "tfdt")
  const decodeTime =
    buf[tfdt.payload] === 1
      ? Number(view.getBigUint64(tfdt.payload + 4))
      : u32(buf, tfdt.payload + 4)

  const samples: Sample[] = []
  let dts = decodeTime
  let dataOffset = base
  for (const trun of boxesIn(buf, traf.payload, traf.end)) {
    if (trun.type !== "trun") continue
    const version = buf[trun.payload]!
    const flags = u32(buf, trun.payload) & 0xffffff
    const count = u32(buf, trun.payload + 4)
    let p = trun.payload + 8
    if (flags & 0x1) {
      dataOffset = base + view.getInt32(p)
      p += 4
    }
    let firstFlags: number | null = null
    if (flags & 0x4) {
      firstFlags = u32(buf, p)
      p += 4
    }
    for (let i = 0; i < count; i++) {
      let duration = defaultDuration
      let size = defaultSize
      let sampleFlags = defaultFlags
      let compositionOffset = 0
      if (flags & 0x100) {
        duration = u32(buf, p)
        p += 4
      }
      if (flags & 0x200) {
        size = u32(buf, p)
        p += 4
      }
      if (flags & 0x400) {
        sampleFlags = u32(buf, p)
        p += 4
      }
      if (flags & 0x800) {
        compositionOffset = version === 0 ? u32(buf, p) : view.getInt32(p)
        p += 4
      }
      if (i === 0 && firstFlags !== null) sampleFlags = firstFlags
      if (dataOffset + size > buf.length) throw new Error("mp4 sample data past end of fragment")
      samples.push({
        key: (sampleFlags & NON_SYNC_BIT) === 0,
        timestampUs: toMicros(dts + compositionOffset, init.timescale),
        durationUs: toMicros(duration, init.timescale),
        data: buf.subarray(dataOffset, dataOffset + size),
      })
      dataOffset += size
      dts += duration
    }
  }
  return samples
}

const toMicros = (ticks: number, timescale: number): number => Math.round((ticks * 1_000_000) / timescale)
