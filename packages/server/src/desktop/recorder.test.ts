import { afterEach, describe, expect, test } from "bun:test"
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Cause, Effect, Exit } from "effect"
import type { DesktopState } from "@cloudagents/protocol"
import { FlvDemuxer, type FlvEvent } from "./flv"
import { listRunClips, Recorder, type RecorderDesktop, runClipFile } from "./recorder"
import { parseAvcConfig, type H264Unit } from "./rtp"
import { DesktopError, type DesktopSink } from "./manager"

const SPS = Uint8Array.from([0x67, 0x64, 0x00, 0x28, 0xac])
const PPS = Uint8Array.from([0x68, 0xee, 0x3c, 0x80])
const AVCC = Uint8Array.from([1, 0x64, 0x00, 0x28, 0xff, 0xe1, 0, SPS.length, ...SPS, 1, 0, PPS.length, ...PPS])
const CONFIG = parseAvcConfig(AVCC)
const lengthPrefixed = (...nals: Uint8Array[]): Uint8Array =>
  Uint8Array.from(nals.flatMap((n) => [(n.length >>> 24) & 0xff, (n.length >>> 16) & 0xff, (n.length >>> 8) & 0xff, n.length & 0xff, ...n]))
const KEY = lengthPrefixed(Uint8Array.from([0x65, 0x11, 0x22]))
const DELTA = lengthPrefixed(Uint8Array.from([0x41, 0x33]))
const CONFIG_UNIT: H264Unit = { kind: "config", config: CONFIG }
const KEY_UNIT: H264Unit = { kind: "key", au: KEY }
const DELTA_UNIT: H264Unit = { kind: "delta", au: DELTA }
/** A Baseline configuration, as an encoder restart for a Baseline-only viewer would produce. */
const ALT_SPS = Uint8Array.from([0x67, 0x42, 0x00, 0x1f, 0xaa])
const ALT_AVCC = Uint8Array.from([1, 0x42, 0x00, 0x1f, 0xff, 0xe1, 0, ALT_SPS.length, ...ALT_SPS, 1, 0, PPS.length, ...PPS])
const ALT_CONFIG_UNIT: H264Unit = { kind: "config", config: parseAvcConfig(ALT_AVCC) }

const dirs: string[] = []
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

const runDir = (runsDir: string) => join(runsDir, "run")

interface Fake {
  readonly desktop: RecorderDesktop
  readonly emit: (unit: H264Unit) => void
  readonly subscribes: () => number
  readonly unsubscribes: () => number
  readonly screenshots: () => number
  readonly setState: (state: DesktopState) => void
  readonly setScreenshotFails: (fails: boolean) => void
}

const fakeDesktop = (state: DesktopState = "running"): Fake => {
  let current = state
  let sink: DesktopSink | null = null
  let subscribes = 0
  let unsubscribes = 0
  let screenshots = 0
  let screenshotFails = false
  const desktop: RecorderDesktop = {
    status: () =>
      Effect.succeed({
        taskId: "task",
        state: current,
        display: current === "running" ? ":1" : null,
        width: 1280,
        height: 720,
        fps: 30,
        quality: "720p60" as const,
        error: null,
      }),
    subscribe: (_taskId, next) =>
      Effect.sync(() => {
        subscribes += 1
        sink = next
        // What a live desktop hands a new sink: the config and the cached GOP, replayed synchronously.
        next.onMedia(CONFIG_UNIT)
        next.onMedia(KEY_UNIT)
        next.onMedia(DELTA_UNIT)
        return Effect.sync(() => {
          unsubscribes += 1
          if (sink === next) sink = null
        })
      }),
    screenshot: () =>
      Effect.suspend(() => {
        screenshots += 1
        return screenshotFails
          ? Effect.fail(new DesktopError({ message: "no desktop" }))
          : Effect.succeed(Uint8Array.from([0x89, 0x50, 0x4e, 0x47]))
      }),
  }
  return {
    desktop,
    emit: (unit) => sink?.onMedia(unit),
    subscribes: () => subscribes,
    unsubscribes: () => unsubscribes,
    screenshots: () => screenshots,
    setState: (next) => {
      current = next
    },
    setScreenshotFails: (fails) => {
      screenshotFails = fails
    },
  }
}

interface Harness {
  readonly recorder: Recorder
  readonly runsDir: string
  readonly clock: { now: number }
  readonly flv: () => Uint8Array
  readonly remuxed: string[]
  /** Fires the lifecycle watcher: a settled run, a deleted thread or a stopped desktop. */
  readonly endRun: () => void
  readonly watched: () => number
  readonly unwatched: () => number
}

const harness = (
  fake: Fake,
  options: { readonly remuxFails?: boolean; readonly statusGate?: Promise<void> } = {},
): Harness => {
  const runsDir = mkdtempSync(join(tmpdir(), "kestrel-recorder-"))
  dirs.push(runsDir)
  const clock = { now: 10_000 }
  let flvBytes = new Uint8Array()
  const remuxed: string[] = []
  let onEnd: (() => void) | null = null
  let watched = 0
  let unwatched = 0
  const desktop: RecorderDesktop =
    options.statusGate === undefined
      ? fake.desktop
      : {
          ...fake.desktop,
          status: (taskId) =>
            Effect.promise(async () => {
              await options.statusGate
              return Effect.runPromise(fake.desktop.status(taskId))
            }),
        }
  const recorder = new Recorder({
    desktop,
    runsDir,
    now: () => clock.now,
    remux: async (flvPath, mp4Path) => {
      remuxed.push(flvPath)
      flvBytes = readFileSync(flvPath)
      if (options.remuxFails === true) throw new Error("ffmpeg is unavailable")
      writeFileSync(mp4Path, Uint8Array.from([0, 0, 0, 0x18]))
    },
    watch: (_taskId, _runId, end) =>
      Effect.sync(() => {
        watched += 1
        onEnd = end
        return Effect.sync(() => {
          unwatched += 1
          if (onEnd === end) onEnd = null
        })
      }),
  })
  return {
    recorder,
    runsDir,
    clock,
    flv: () => flvBytes,
    remuxed,
    endRun: () => onEnd?.(),
    watched: () => watched,
    unwatched: () => unwatched,
  }
}

const failureOf = async (effect: Effect.Effect<unknown, unknown>): Promise<{ _tag: string; message: string }> => {
  const exit = await Effect.runPromiseExit(effect)
  if (!Exit.isFailure(exit)) throw new Error("expected the effect to fail")
  return Cause.squash(exit.cause) as { _tag: string; message: string }
}

const start = (h: Harness, caption = "Spawn demo") => Effect.runPromise(h.recorder.start("task", "run", caption))

describe("desktop recorder", () => {
  test("records a clip, its poster and its sidecar, and removes the intermediate FLV", async () => {
    const fake = fakeDesktop()
    const h = harness(fake)
    await start(h)
    expect(fake.subscribes()).toBe(1)
    // The replayed GOP is history: the recording begins on the next live keyframe.
    h.clock.now = 10_100
    fake.emit(KEY_UNIT)
    h.clock.now = 10_250
    fake.emit(DELTA_UNIT)
    const clip = await Effect.runPromise(h.recorder.stop("task", "run"))
    expect(fake.unsubscribes()).toBe(1)
    expect(fake.screenshots()).toBe(1)
    expect(clip.caption).toBe("Spawn demo")
    expect(clip.durationMs).toBe(150)
    expect(clip.poster).toMatch(/^[0-9a-f]{32}\.png$/)
    const clips = join(runDir(h.runsDir), "clips")
    expect(existsSync(join(clips, clip.id))).toBe(true)
    expect(existsSync(join(clips, clip.poster!))).toBe(true)
    expect(existsSync(join(clips, `${clip.id.slice(0, -4)}.flv`))).toBe(false)
    expect(JSON.parse(readFileSync(join(clips, `${clip.id.slice(0, -4)}.json`), "utf8"))).toEqual(clip)
    expect(listRunClips(runDir(h.runsDir))).toEqual([clip])
    expect(runClipFile(runDir(h.runsDir), clip.id)).toMatchObject({ mimeType: "video/mp4" })
    expect(runClipFile(runDir(h.runsDir), clip.poster!)).toMatchObject({ mimeType: "image/png" })
    // The FLV holds the config plus exactly the two live frames (the replayed ones were dropped).
    const events = new FlvDemuxer().push(h.flv())
    expect(events.map((event) => event.kind)).toEqual(["config", "frame", "frame"])
    const frames = events.filter((event): event is Extract<FlvEvent, { kind: "frame" }> => event.kind === "frame")
    expect(frames.map((frame) => [frame.dts, frame.keyframe])).toEqual([[0, true], [150, false]])
  })

  test("refuses to record a desktop that is not running, without subscribing", async () => {
    const fake = fakeDesktop("stopped")
    const h = harness(fake)
    const error = await failureOf(h.recorder.start("task", "run", undefined))
    expect(error._tag).toBe("RecordingConflict")
    expect(error.message).toContain("desktop is stopped")
    expect(fake.subscribes()).toBe(0)
  })

  test("allows one recording per run and removes the subscription once", async () => {
    const fake = fakeDesktop()
    const h = harness(fake)
    await start(h)
    const again = await failureOf(h.recorder.start("task", "run", undefined))
    expect(again._tag).toBe("RecordingConflict")
    expect(fake.subscribes()).toBe(1)
    h.clock.now = 10_100
    fake.emit(KEY_UNIT)
    await Effect.runPromise(h.recorder.stop("task", "run"))
    expect(fake.unsubscribes()).toBe(1)
    const second = await failureOf(h.recorder.stop("task", "run"))
    expect(second._tag).toBe("RecordingConflict")
  })

  test("an encoder restart adds a new sequence header without ending the recording", async () => {
    const fake = fakeDesktop()
    const h = harness(fake)
    await start(h)
    h.clock.now = 10_100
    fake.emit(KEY_UNIT)
    h.clock.now = 10_200
    fake.emit(CONFIG_UNIT)
    h.clock.now = 10_300
    fake.emit(KEY_UNIT)
    await Effect.runPromise(h.recorder.stop("task", "run"))
    const events = new FlvDemuxer().push(h.flv())
    expect(events.map((event) => event.kind)).toEqual(["config", "frame", "config", "frame"])
    expect((events[3] as Extract<FlvEvent, { kind: "frame" }>).dts).toBe(200)
  })

  test("a clip with no video is refused and leaves no files", async () => {
    const fake = fakeDesktop()
    const h = harness(fake)
    await start(h)
    const error = await failureOf(h.recorder.stop("task", "run"))
    expect(error._tag).toBe("RecordingFailed")
    expect(error.message).toContain("captured no video")
    expect(fake.unsubscribes()).toBe(1)
    expect(listRunClips(runDir(h.runsDir))).toEqual([])
    expect(readdirSync(join(runDir(h.runsDir), "clips"))).toEqual([])
  })

  test("a failed poster capture still saves the clip", async () => {
    const fake = fakeDesktop()
    const h = harness(fake)
    await start(h)
    fake.setScreenshotFails(true)
    h.clock.now = 10_100
    fake.emit(KEY_UNIT)
    const clip = await Effect.runPromise(h.recorder.stop("task", "run"))
    expect(clip.poster).toBeNull()
    expect(existsSync(join(runDir(h.runsDir), "clips", clip.id))).toBe(true)
  })

  test("a failed remux unsubscribes, fails the stop and leaves no partial clip", async () => {
    const fake = fakeDesktop()
    const h = harness(fake, { remuxFails: true })
    await start(h)
    h.clock.now = 10_100
    fake.emit(KEY_UNIT)
    const error = await failureOf(h.recorder.stop("task", "run"))
    expect(error._tag).toBe("RecordingFailed")
    expect(error.message).toContain("ffmpeg")
    expect(fake.unsubscribes()).toBe(1)
    expect(listRunClips(runDir(h.runsDir))).toEqual([])
    expect(readdirSync(join(runDir(h.runsDir), "clips"))).toEqual([])
  })
})

describe("recording lifetime", () => {
  test("a settled run ends the recording without saving a clip or leaking the subscription", async () => {
    const fake = fakeDesktop()
    const h = harness(fake)
    await start(h)
    h.clock.now = 10_100
    fake.emit(KEY_UNIT)
    expect(h.watched()).toBe(1)
    h.endRun()
    expect(fake.unsubscribes()).toBe(1)
    expect(h.unwatched()).toBe(1)
    const error = await failureOf(h.recorder.stop("task", "run"))
    expect(error._tag).toBe("RecordingConflict")
    expect(listRunClips(runDir(h.runsDir))).toEqual([])
    expect(readdirSync(join(runDir(h.runsDir), "clips"))).toEqual([])
    expect(h.remuxed).toEqual([])
    // Aborting again is a no-op.
    await Effect.runPromise(h.recorder.abort("run"))
    expect(fake.unsubscribes()).toBe(1)
  })

  test("a stopped desktop ends the recording and leaves no map entry", async () => {
    const fake = fakeDesktop()
    const h = harness(fake)
    await start(h)
    h.clock.now = 10_100
    fake.emit(KEY_UNIT)
    fake.setState("stopped")
    h.endRun()
    expect(fake.unsubscribes()).toBe(1)
    expect(h.unwatched()).toBe(1)
    expect(listRunClips(runDir(h.runsDir))).toEqual([])
    expect(readdirSync(join(runDir(h.runsDir), "clips"))).toEqual([])
    // Nothing is left recording: start declines for a stopped desktop, and a fresh running one could start again.
    const stopped = await failureOf(h.recorder.start("task", "run", undefined))
    expect(stopped._tag).toBe("RecordingConflict")
    fake.setState("running")
    await start(h)
    expect(fake.subscribes()).toBe(2)
  })

  test("stop removes the lifecycle watcher", async () => {
    const fake = fakeDesktop()
    const h = harness(fake)
    await start(h)
    h.clock.now = 10_100
    fake.emit(KEY_UNIT)
    await Effect.runPromise(h.recorder.stop("task", "run"))
    expect(h.unwatched()).toBe(1)
    // A late end event after stop cannot tear down a new recording of the same run.
    h.endRun()
    expect(fake.unsubscribes()).toBe(1)
  })

  test("concurrent starts reserve the run before awaiting the desktop status", async () => {
    const fake = fakeDesktop()
    let release!: () => void
    const statusGate = new Promise<void>((resolve) => {
      release = resolve
    })
    const h = harness(fake, { statusGate })
    const first = Effect.runPromise(h.recorder.start("task", "run", "first"))
    const second = Effect.runPromiseExit(h.recorder.start("task", "run", "second"))
    release()
    await first
    const exit = await second
    if (!Exit.isFailure(exit)) throw new Error("expected the second start to fail")
    expect((Cause.squash(exit.cause) as { _tag: string })._tag).toBe("RecordingConflict")
    expect(fake.subscribes()).toBe(1)
  })

  test("a mid-recording config change discards the clip instead of writing a half-decodable MP4", async () => {
    const fake = fakeDesktop()
    const h = harness(fake)
    await start(h)
    h.clock.now = 10_100
    fake.emit(KEY_UNIT)
    h.clock.now = 10_200
    fake.emit(ALT_CONFIG_UNIT)
    h.clock.now = 10_300
    fake.emit(KEY_UNIT)
    const error = await failureOf(h.recorder.stop("task", "run"))
    expect(error._tag).toBe("RecordingFailed")
    expect(error.message).toContain("configuration")
    expect(fake.unsubscribes()).toBe(1)
    expect(h.remuxed).toEqual([])
    expect(listRunClips(runDir(h.runsDir))).toEqual([])
    expect(readdirSync(join(runDir(h.runsDir), "clips"))).toEqual([])
  })
})
