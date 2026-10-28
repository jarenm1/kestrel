import { describe, expect, test } from "bun:test"
import { mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { isInitSegment, parseFragment, parseInit } from "./fmp4"
import { codecFromMime } from "./videoRenderer"

const FRAMES = 50
const GOP = 25

/** Encodes a 320x240 test pattern with ffmpeg and returns the fMP4 bytes. */
async function encode(movflags: string, profile: string): Promise<Uint8Array<ArrayBuffer>> {
  const dir = await mkdtemp(join(tmpdir(), "fmp4-test-"))
  const out = join(dir, "out.mp4")
  try {
    const proc = Bun.spawn(
      [
        "ffmpeg", "-v", "error", "-y",
        "-f", "lavfi", "-i", "testsrc=size=320x240:rate=25",
        "-frames:v", String(FRAMES),
        "-c:v", "libx264", "-preset", profile === "high" ? "veryfast" : "ultrafast", "-profile:v", profile,
        "-pix_fmt", "yuv420p", "-g", String(GOP), "-keyint_min", String(GOP), "-sc_threshold", "0", "-bf", "0",
        "-f", "mp4", "-movflags", movflags,
        out,
      ],
      { stdout: "ignore", stderr: "pipe" },
    )
    const code = await proc.exited
    if (code !== 0) throw new Error(`ffmpeg failed: ${await new Response(proc.stderr).text()}`)
    return new Uint8Array(await readFile(out))
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

interface Box {
  type: string
  bytes: Uint8Array<ArrayBuffer>
}

function topLevelBoxes(buf: Uint8Array<ArrayBuffer>): Box[] {
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength)
  const boxes: Box[] = []
  let offset = 0
  while (offset < buf.byteLength) {
    const size = view.getUint32(offset)
    const type = String.fromCharCode(...buf.subarray(offset + 4, offset + 8))
    boxes.push({ type, bytes: buf.subarray(offset, offset + size) })
    offset += size
  }
  return boxes
}

/** Splits an ffmpeg fMP4 into its init segment and moof+mdat fragments (one entry per moof). */
function splitSegments(buf: Uint8Array<ArrayBuffer>): { init: Uint8Array<ArrayBuffer>; fragments: Uint8Array<ArrayBuffer>[] } {
  const boxes = topLevelBoxes(buf)
  const firstMoof = boxes.findIndex((b) => b.type === "moof")
  const init = concat(boxes.slice(0, firstMoof).map((b) => b.bytes))
  const fragments: Uint8Array<ArrayBuffer>[] = []
  for (let i = firstMoof; i < boxes.length && boxes[i]!.type === "moof"; i += 2) {
    expect(boxes[i + 1]!.type).toBe("mdat")
    fragments.push(concat([boxes[i]!.bytes, boxes[i + 1]!.bytes]))
  }
  return { init, fragments }
}

function concat(parts: Uint8Array<ArrayBuffer>[]): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.byteLength, 0))
  let offset = 0
  for (const p of parts) {
    out.set(p, offset)
    offset += p.byteLength
  }
  return out
}

describe("fmp4 init segment", () => {
  test("parses dimensions, timescale, avcC and track defaults", async () => {
    const { init } = splitSegments(await encode("empty_moov+default_base_moof+frag_keyframe", "high"))
    expect(isInitSegment(init)).toBe(true)

    const parsed = parseInit(init)
    expect(parsed.codedWidth).toBe(320)
    expect(parsed.codedHeight).toBe(240)
    expect(parsed.timescale).toBeGreaterThan(0)
    // avcC: configurationVersion 1, then AVCProfileIndication, which is 100 for High.
    expect(parsed.description[0]).toBe(1)
    expect(parsed.description[1]).toBe(100)
    expect(parsed.trex.get(1)).toBeDefined()
  })

  test("baseline profile avcC carries profile 66", async () => {
    const { init } = splitSegments(await encode("empty_moov+default_base_moof+frag_keyframe", "baseline"))
    expect(parseInit(init).description[1]).toBe(66)
  })

  test("a fragment is not an init segment", async () => {
    const { fragments } = splitSegments(await encode("empty_moov+default_base_moof+frag_keyframe", "high"))
    expect(isInitSegment(fragments[0]!)).toBe(false)
  })
})

describe("fmp4 fragments", () => {
  test("one sample per fragment when every frame is a fragment", async () => {
    const { init, fragments } = splitSegments(
      await encode("empty_moov+default_base_moof+frag_every_frame", "high"),
    )
    const parsed = parseInit(init)
    expect(fragments.length).toBe(FRAMES)

    const samples = fragments.flatMap((f) => parseFragment(f, parsed))
    expect(samples.length).toBe(FRAMES)
    expect(samples.every((s) => s.data.byteLength > 0)).toBe(true)
    expect(samples[0]!.key).toBe(true)
    expect(samples[0]!.timestampUs).toBe(0)
    for (let i = 1; i < samples.length; i++) {
      expect(samples[i]!.timestampUs).toBeGreaterThan(samples[i - 1]!.timestampUs)
      expect(Math.abs(samples[i]!.timestampUs - samples[i - 1]!.timestampUs - 40000)).toBeLessThanOrEqual(2)
    }
  })

  test("keyframe-aligned fragments carry multiple samples and flag the GOP start", async () => {
    const { init, fragments } = splitSegments(
      await encode("empty_moov+default_base_moof+frag_keyframe", "high"),
    )
    const parsed = parseInit(init)
    expect(fragments.length).toBe(FRAMES / GOP)

    const perFragment = fragments.map((f) => parseFragment(f, parsed))
    for (const samples of perFragment) {
      expect(samples.length).toBe(GOP)
      expect(samples[0]!.key).toBe(true)
      expect(samples.slice(1).every((s) => !s.key)).toBe(true)
    }
    const all = perFragment.flat()
    expect(all.length).toBe(FRAMES)
    // Timestamps continue across fragments (tfdt drives the timeline, not sample order).
    for (let i = 1; i < all.length; i++) {
      expect(all[i]!.timestampUs).toBeGreaterThan(all[i - 1]!.timestampUs)
    }
  })

  test("sample bytes are the coded data, not the box headers", async () => {
    const { init, fragments } = splitSegments(
      await encode("empty_moov+default_base_moof+frag_keyframe", "high"),
    )
    const [first] = parseFragment(fragments[0]!, parseInit(init))
    // Length-prefixed NAL units (4-byte big-endian length each). A sample may hold SEI before the IDR slice.
    const view = new DataView(first!.data.buffer, first!.data.byteOffset, first!.data.byteLength)
    const nalTypes: number[] = []
    for (let offset = 0; offset < first!.data.byteLength; ) {
      const len = view.getUint32(offset)
      nalTypes.push(first!.data[offset + 4]! & 0x1f)
      offset += 4 + len
    }
    expect(nalTypes).toContain(5) // IDR slice
  })
})

describe("codecFromMime", () => {
  test("returns the codecs parameter verbatim", () => {
    expect(codecFromMime('video/mp4; codecs="avc1.640028"')).toBe("avc1.640028")
  })

  test("throws without a codecs parameter", () => {
    expect(() => codecFromMime("video/mp4")).toThrow()
  })
})
