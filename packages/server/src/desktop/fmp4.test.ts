import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Mp4Muxer, type Mp4Piece } from "./fmp4"

const FRAMES = 120
const GOP = 30
const WIDTH = 320
const HEIGHT = 240
/** One frame at 60 fps on the 90 kHz track clock the muxer writes. */
const FRAME_TICKS = 1500
const HAS_FFMPEG = Bun.which("ffmpeg") !== null && Bun.which("ffprobe") !== null

const run = async (args: string[]): Promise<string> => {
  const proc = Bun.spawn(args, { stdout: "pipe", stderr: "pipe" })
  const [out, err, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ])
  if (code !== 0) throw new Error(`${args[0]} failed: ${err}`)
  return out
}

/** Keyframe flag of each video frame, in decode order, as ffprobe reads it. */
const keyframesOf = async (file: string): Promise<boolean[]> => {
  const out = await run(["ffprobe", "-v", "error", "-select_streams", "v:0", "-show_entries", "frame=key_frame", "-of", "default=nokey=1:noprint_wrappers=1", file])
  return out.trim().split("\n").map((line) => line.trim() === "1")
}

/** End offset (exclusive, including PreviousTagSize) of each H.264 NALU tag in an FLV file. */
const frameTagEnds = (file: Uint8Array): number[] => {
  const ends: number[] = []
  let at = 9 + 4
  while (at + 11 <= file.length) {
    const type = file[at]! & 0x1f
    const size = (file[at + 1]! << 16) | (file[at + 2]! << 8) | file[at + 3]!
    const end = at + 11 + size + 4
    if (type === 9 && file[at + 12] === 1) ends.push(end)
    at = end
  }
  return ends
}

const CHUNK_SIZES = [1, 7, 188, 4096, 65_536, 33_333]

/** Feeds `bytes` in a fixed mix of chunk sizes, so tags are split at every kind of boundary. */
const feed = (muxer: Mp4Muxer, bytes: Uint8Array): Mp4Piece[] => {
  const pieces: Mp4Piece[] = []
  let at = 0
  for (let i = 0; at < bytes.length; i++) {
    const n = CHUNK_SIZES[i % CHUNK_SIZES.length]!
    pieces.push(...muxer.push(bytes.subarray(at, at + n)))
    at += n
  }
  return pieces
}

const media = (pieces: Mp4Piece[]) => pieces.filter((p) => p.kind === "media")

/** Decode time (tfdt) and sample duration (trun) of a media fragment, read from its moof. */
const timingOf = (fragment: Uint8Array): { decodeTime: number; duration: number } => {
  const moofEnd = new DataView(fragment.buffer, fragment.byteOffset, fragment.byteLength).getUint32(0)
  const moof = Buffer.from(fragment.subarray(0, moofEnd))
  const view = new DataView(moof.buffer, moof.byteOffset, moof.byteLength)
  const tfdt = moof.indexOf("tfdt") + 4 // payload: version and flags, then baseMediaDecodeTime
  const trun = moof.indexOf("trun") + 4 // payload: version and flags, sample count, data offset, first flags, duration
  return { decodeTime: Number(view.getBigUint64(tfdt + 4)), duration: view.getUint32(trun + 16) }
}

describe.skipIf(!HAS_FFMPEG)("Mp4Muxer", () => {
  let dir = ""
  let flvPath = ""
  let flv = new Uint8Array()

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "desktop-fmp4-"))
    flvPath = join(dir, "in.flv")
    await run([
      "ffmpeg", "-v", "error", "-y",
      "-f", "lavfi", "-i", `testsrc=size=${WIDTH}x${HEIGHT}:rate=60`,
      "-frames:v", String(FRAMES),
      "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p",
      "-g", String(GOP), "-keyint_min", String(GOP), "-sc_threshold", "0", "-bf", "0",
      "-f", "flv", flvPath,
    ])
    flv = new Uint8Array(await readFile(flvPath))
  })

  afterAll(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  test("writes one fragment per frame, decodable, with the source keyframe pattern", async () => {
    const pieces = feed(new Mp4Muxer(WIDTH, HEIGHT), flv)
    const [init, ...rest] = pieces
    expect(init?.kind).toBe("init")
    if (init?.kind !== "init") throw new Error("first piece is not the init segment")
    expect(init.codec).toMatch(/^avc1\.[0-9a-f]{6}$/)

    const frames = media(rest)
    expect(frames.length).toBe(FRAMES)

    const reference = await keyframesOf(flvPath)
    expect(frames.map((f) => f.keyframe === true)).toEqual(reference)
    expect(reference.filter(Boolean).length).toBe(FRAMES / GOP)

    const mp4Path = join(dir, "out.mp4")
    await Bun.write(mp4Path, Buffer.concat([init.bytes, ...frames.map((f) => f.bytes)]))
    expect(await keyframesOf(mp4Path)).toEqual(reference)
    const decoded = await run(["ffprobe", "-v", "error", "-count_frames", "-select_streams", "v:0", "-show_entries", "stream=nb_read_frames", "-of", "default=nokey=1:noprint_wrappers=1", mp4Path])
    expect(decoded.trim()).toBe(String(FRAMES))
  })

  test("timestamps are contiguous: each fragment starts where the previous one ends", () => {
    const timings = media(feed(new Mp4Muxer(WIDTH, HEIGHT), flv)).map((f) => timingOf(f.bytes))
    expect(timings.length).toBe(FRAMES)
    for (const t of timings) expect(t.duration).toBe(FRAME_TICKS)
    timings.reduce((prev, cur) => {
      expect(cur.decodeTime).toBe(prev.decodeTime + prev.duration)
      return cur
    })
  })

  test("a gap on the FLV clock leaves no gap on the timeline", () => {
    // Drop the sixth frame's tag: the next frame arrives two frame periods later on the FLV clock.
    const ends = frameTagEnds(flv)
    const gapped = new Uint8Array([...flv.subarray(0, ends[4]), ...flv.subarray(ends[5]!)])
    const timings = media(feed(new Mp4Muxer(WIDTH, HEIGHT), gapped)).map((f) => timingOf(f.bytes))
    expect(timings.length).toBe(FRAMES - 1)
    timings.reduce((prev, cur) => {
      expect(cur.decodeTime).toBe(prev.decodeTime + prev.duration)
      return cur
    })
  })

  test("emits each frame the moment its FLV tag is complete", () => {
    const muxer = new Mp4Muxer(WIDTH, HEIGHT)
    const ends = frameTagEnds(flv).slice(0, 10)
    let at = 0
    let emitted = 0
    ends.forEach((end, k) => {
      emitted += media(muxer.push(flv.subarray(at, end))).length
      at = end
      expect(emitted).toBe(k + 1)
    })
  })
})
