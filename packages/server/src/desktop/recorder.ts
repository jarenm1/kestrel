/**
 * Explicit desktop recording: a `DesktopSink` that muxes the live H.264 stream to FLV, then remuxes the FLV to MP4
 * with ffmpeg. A recording subscribes like any viewer, so its membership keeps the shared encoder alive and it sees
 * the encoder's config and keyframes even when nobody is watching.
 *
 * Recordings are keyed by run. One may be active per run; stopping always removes the subscription before any of the
 * slower work, so a failed remux or screenshot cannot leak a sink into the desktop's encoder. The finished clip lives
 * beside the run's other artifacts: `<runDir>/clips/<id>.mp4`, `<id>.png` (its poster) and `<id>.json` (the sidecar
 * the list route reads). The FLV is deleted once the MP4 exists.
 */

import { spawn } from "node:child_process"
import { randomBytes } from "node:crypto"
import { createWriteStream, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync, type WriteStream } from "node:fs"
import { join } from "node:path"
import { Data, Effect, Schema } from "effect"
import { RunClip, type DesktopStatus } from "@cloudagents/protocol"
import { FlvMuxer } from "./clip"
import type { DesktopSink } from "./manager"
import { DesktopError } from "./manager"

/** Asked for something the run's recording state does not allow: desktop not running, already recording, or none. */
export class RecordingConflict extends Data.TaggedError("RecordingConflict")<{ readonly message: string }> {}

/** The recording could not be written, finished empty, or its remux failed. No partial clip is left behind. */
export class RecordingFailed extends Data.TaggedError("RecordingFailed")<{ readonly message: string }> {}

export type RecordingError = RecordingConflict | RecordingFailed

/** The desktop operations a recorder needs; the manager supplies them, tests fake them. */
export interface RecorderDesktop {
  readonly status: (taskId: string) => Effect.Effect<DesktopStatus>
  readonly subscribe: (taskId: string, sink: DesktopSink) => Effect.Effect<Effect.Effect<void>, DesktopError>
  readonly screenshot: (taskId: string) => Effect.Effect<Uint8Array, DesktopError>
}

export interface RecorderOptions {
  readonly desktop: RecorderDesktop
  /** The box's runs directory; each clip goes under `<runsDir>/<runId>/clips`. */
  readonly runsDir: string
  /** Replaces the ffmpeg invocation in tests. */
  readonly remux?: (flvPath: string, mp4Path: string) => Promise<void>
  readonly now?: () => number
  /**
   * Watches the run and its desktop for the recording's end: a settled/cancelled run, a deleted thread or a desktop
   * that leaves `running` calls `onEnd`. Returns the unsubscribe. Without it, a recording lasts until `stop`/`abort`.
   */
  readonly watch?: (taskId: string, runId: string, onEnd: () => void) => Effect.Effect<Effect.Effect<void>>
}

interface ActiveRecording {
  readonly taskId: string
  readonly runId: string
  readonly id: string
  readonly caption: string
  readonly createdAt: string
  readonly startedAt: number
  readonly stream: WriteStream
  readonly muxer: FlvMuxer
  readonly flvPath: string
  unsubscribe: Effect.Effect<void> | null
  unwatch: Effect.Effect<void> | null
  /** Identity of the first avcC. MP4 holds one configuration; a different one would leave undecodable frames. */
  avccKey: string | null
  /** A later config differed from the first: the recording is discarded on stop instead of remuxed. */
  configChanged: boolean
  writeError: Error | null
  configured: boolean
  /** False until subscribe returns: frames replayed to the new sink are history, not this recording's time line. */
  accepting: boolean
  /** Set when replayed frames were dropped, so recording resumes on the next keyframe and never joins on a delta. */
  needsKey: boolean
  frames: number
  firstFrameAt: number
  elapsedMs: number
}

const messageOf = (e: unknown): string => (e instanceof Error ? e.message : String(e))

/** The identity of an avcC record: an MP4 can hold only one, so the recording tracks the first one it saw. */
const avccKey = (avcc: Uint8Array): string => Buffer.from(avcc).toString("hex")

/** `ffmpeg -c copy`: no re-encode, so the MP4 holds exactly the encoded access units. */
export const remuxFfmpeg = (flvPath: string, mp4Path: string): Promise<void> => {
  const { promise, resolve, reject } = Promise.withResolvers<void>()
  const child = spawn(
    "ffmpeg",
    ["-hide_banner", "-loglevel", "error", "-y", "-i", flvPath, "-c", "copy", "-movflags", "+faststart", mp4Path],
    { stdio: ["ignore", "ignore", "pipe"] },
  )
  let stderr = ""
  child.stderr.on("data", (chunk: Buffer) => {
    stderr = (stderr + chunk.toString()).slice(-2000)
  })
  child.once("error", reject)
  child.once("close", (code) => {
    if (code === 0) resolve()
    else reject(new Error(`ffmpeg exited with code ${code}${stderr === "" ? "" : `: ${stderr.trim()}`}`))
  })
  return promise
}

export const clipsDir = (runDir: string): string => join(runDir, "clips")

const CLIP_FILE = /^[0-9a-f]{32}\.(mp4|png)$/
const MIME_TYPES: Readonly<Record<string, string>> = { mp4: "video/mp4", png: "image/png" }
const SIDECAR_EXT = ".json"

/** The file and type behind an id a `RunClip` names, or null for anything else. */
export function runClipFile(runDir: string, fileId: string): { readonly path: string; readonly mimeType: string } | null {
  const extension = CLIP_FILE.exec(fileId)?.[1]
  const mimeType = extension === undefined ? undefined : MIME_TYPES[extension]
  return mimeType === undefined ? null : { path: join(clipsDir(runDir), fileId), mimeType }
}

/** The run's saved clips, oldest first. A missing directory is an empty run; a malformed sidecar is skipped. */
export function listRunClips(runDir: string): RunClip[] {
  let names: string[]
  try {
    names = readdirSync(clipsDir(runDir))
  } catch {
    return []
  }
  const clips: RunClip[] = []
  for (const name of names) {
    if (!name.endsWith(SIDECAR_EXT)) continue
    try {
      const clip = Schema.decodeUnknownSync(RunClip)(JSON.parse(readFileSync(join(clipsDir(runDir), name), "utf8")))
      if (CLIP_FILE.test(clip.id) && (clip.poster === null || CLIP_FILE.test(clip.poster))) clips.push(clip)
    } catch {
      // A half-written sidecar or one from another version: leave it out rather than fail the whole list.
    }
  }
  return clips.sort((a, b) => a.createdAt.localeCompare(b.createdAt))
}

/** Starts and stops recordings; one instance serves every run of every task. */
export class Recorder {
  private readonly recordings = new Map<string, ActiveRecording>()
  private readonly starting = new Set<string>()
  private readonly now: () => number

  constructor(private readonly options: RecorderOptions) {
    this.now = options.now ?? Date.now
  }

  /** Begins recording the task's running desktop for `runId`. Failures leave no file and no subscription behind. */
  start(taskId: string, runId: string, caption: string | undefined): Effect.Effect<void, RecordingError> {
    return Effect.gen(this, function* () {
      if (this.recordings.has(runId) || this.starting.has(runId)) {
        return yield* Effect.fail(new RecordingConflict({ message: `run ${runId} is already being recorded` }))
      }
      // Reserved before the first await: two concurrent starts must not both subscribe.
      this.starting.add(runId)
      const status = yield* this.options.desktop.status(taskId)
      if (status.state !== "running") {
        return yield* Effect.fail(
          new RecordingConflict({ message: `the desktop is ${status.state}; call desktop_open before recording` }),
        )
      }
      const runDir = join(this.options.runsDir, runId)
      const id = `${randomBytes(16).toString("hex")}.mp4`
      const flvPath = join(clipsDir(runDir), `${id.slice(0, -".mp4".length)}.flv`)
      const prepared = yield* Effect.try({
        try: () => {
          mkdirSync(clipsDir(runDir), { recursive: true })
          return createWriteStream(flvPath)
        },
        catch: (e) => new RecordingFailed({ message: `cannot create the clip: ${messageOf(e)}` }),
      })
      let active: ActiveRecording
      const muxer = new FlvMuxer((bytes) => {
        if (active.writeError !== null) return
        try {
          prepared.write(bytes, (e) => {
            if (e !== null && e !== undefined) active.writeError = e
          })
        } catch (e) {
          active.writeError = e instanceof Error ? e : new Error(String(e))
        }
      })
      active = {
        taskId,
        runId,
        id,
        caption: caption === undefined || caption.trim() === "" ? "Desktop recording" : caption.trim(),
        createdAt: new Date(this.now()).toISOString(),
        startedAt: this.now(),
        stream: prepared,
        muxer,
        flvPath,
        unsubscribe: null,
        unwatch: null,
        avccKey: null,
        configChanged: false,
        writeError: null,
        configured: false,
        accepting: false,
        needsKey: true,
        frames: 0,
        firstFrameAt: -1,
        elapsedMs: 0,
      }
      prepared.once("error", (e) => {
        active.writeError = e
      })
      const sink: DesktopSink = {
        // Not a viewer: no payload constraint, so a recording alone lets the encoder keep High profile.
        baselineOnly: false,
        onStatus: () => {},
        onAudio: () => {},
        onMedia: (unit) => {
          if (active.writeError !== null || active.configChanged) return
          if (unit.kind === "config") {
            const key = avccKey(unit.config.avcc)
            if (active.avccKey === null) {
              // Config replayed during subscribe is wanted: it is the sequence header the file needs even when the
              // replayed access units themselves are dropped.
              active.avccKey = key
              active.muxer.sequenceHeader(unit.config.avcc)
              active.configured = true
              return
            }
            if (key === active.avccKey) {
              // The same encoder restarted: re-sending its sequence header is valid.
              active.muxer.sequenceHeader(unit.config.avcc)
              return
            }
            // An MP4 carries one avcC. Frames after a different config would not decode with the ones already
            // written, so discard this recording rather than return a half-undecodable clip.
            active.configChanged = true
            return
          }
          if (!active.configured || !active.accepting) return
          if (active.needsKey) {
            if (unit.kind !== "key") return
            active.needsKey = false
          }
          const now = this.now()
          if (active.firstFrameAt < 0) active.firstFrameAt = now
          active.elapsedMs = Math.max(0, now - active.firstFrameAt)
          active.frames += 1
          active.muxer.videoTag(unit.au, unit.kind === "key", active.elapsedMs)
        },
      }
      const unsubscribe = yield* this.options.desktop.subscribe(taskId, sink).pipe(
        Effect.mapError((e) => new RecordingFailed({ message: e.message })),
        Effect.tapError(() =>
          Effect.sync(() => {
            prepared.destroy()
            rmSync(flvPath, { force: true })
          }),
        ),
      )
      active.unsubscribe = unsubscribe
      active.accepting = true
      this.recordings.set(runId, active)
      if (this.options.watch !== undefined) {
        // From here the recording follows the run: a settled run, a deleted thread or a stopped desktop ends it.
        const unwatch = yield* this.options.watch(taskId, runId, () => this.abortNow(runId)).pipe(
          Effect.catchAll(() => Effect.succeed(Effect.void)),
        )
        if (this.recordings.get(runId) === active) active.unwatch = unwatch
        else yield* unwatch
      }
      return undefined
    }).pipe(
      Effect.ensuring(Effect.sync(() => this.starting.delete(runId))),
    )
  }

  /** Stops `runId`'s recording, writes the poster and sidecar, and returns the clip. The subscription is removed first. */
  stop(taskId: string, runId: string): Effect.Effect<RunClip, RecordingError> {
    return Effect.gen(this, function* () {
      const active = this.recordings.get(runId)
      if (active === undefined || active.taskId !== taskId) {
        return yield* Effect.fail(new RecordingConflict({ message: `run ${runId} has no recording in progress` }))
      }
      // Removed first: a concurrent stop finds nothing rather than finishing the same clip twice.
      this.recordings.delete(runId)
      const unwatch = active.unwatch
      active.unwatch = null
      if (unwatch !== null) yield* unwatch.pipe(Effect.catchAll(() => Effect.void))
      yield* (active.unsubscribe ?? Effect.void)
      active.unsubscribe = null
      yield* Effect.tryPromise({
        try: () => this.finish(active.stream),
        catch: (e) => new RecordingFailed({ message: `cannot finish the clip: ${messageOf(e)}` }),
      }).pipe(Effect.orElseSucceed(() => undefined))
      if (active.writeError !== null) {
        rmSync(active.flvPath, { force: true })
        return yield* Effect.fail(new RecordingFailed({ message: `writing the clip failed: ${active.writeError.message}` }))
      }
      if (active.configChanged) {
        rmSync(active.flvPath, { force: true })
        return yield* Effect.fail(
          new RecordingFailed({
            message: "the encoder changed its H.264 configuration mid-recording, so the clip was discarded",
          }),
        )
      }
      if (!active.configured || active.frames === 0) {
        rmSync(active.flvPath, { force: true })
        return yield* Effect.fail(new RecordingFailed({ message: "the recording captured no video" }))
      }
      const clips = clipsDir(join(this.options.runsDir, runId))
      const base = active.id.slice(0, -".mp4".length)
      const mp4Path = join(clips, active.id)
      const remux = this.options.remux ?? remuxFfmpeg
      const remuxError = yield* Effect.tryPromise({ try: () => remux(active.flvPath, mp4Path), catch: messageOf }).pipe(
        Effect.as(null),
        Effect.catchAll((message) => Effect.succeed(message)),
      )
      if (remuxError !== null) {
        rmSync(active.flvPath, { force: true })
        rmSync(mp4Path, { force: true })
        return yield* Effect.fail(
          new RecordingFailed({ message: `ffmpeg could not convert the recording to MP4: ${remuxError}` }),
        )
      }
      // A poster is nice to have: a desktop that stopped during the recording still leaves a usable clip.
      const posterBytes = yield* this.options.desktop.screenshot(taskId).pipe(
        Effect.catchAll(() => Effect.logWarning(`poster for clip ${active.id} could not be captured`).pipe(Effect.as(null))),
      )
      let poster: string | null = null
      if (posterBytes !== null) {
        try {
          const name = `${base}.png`
          writeFileSync(join(clips, name), posterBytes)
          poster = name
        } catch {
          poster = null
        }
      }
      const clip: RunClip = {
        id: active.id,
        caption: active.caption,
        createdAt: active.createdAt,
        durationMs: Math.max(0, Math.round(active.elapsedMs)),
        poster,
      }
      yield* Effect.try({
        try: () => {
          writeFileSync(join(clips, `${base}.json`), JSON.stringify(clip))
          rmSync(active.flvPath, { force: true })
        },
        catch: (e) => {
          rmSync(active.flvPath, { force: true })
          rmSync(mp4Path, { force: true })
          if (poster !== null) rmSync(join(clips, poster), { force: true })
          return new RecordingFailed({ message: `cannot save the clip: ${messageOf(e)}` })
        },
      })
      return clip
    })
  }

  /**
   * Ends a recording without saving it: the run settled, was cancelled/deleted, or its desktop stopped. Idempotent;
   * a recording already stopped or aborted is left alone. Removes the watcher, the encoder subscription and the FLV.
   */
  abort(runId: string): Effect.Effect<void> {
    return Effect.sync(() => this.abortNow(runId))
  }

  /**
   * The synchronous half of `abort`, for lifecycle callbacks. Both unsubscribes are synchronous effects (the desktop
   * manager and the event hub), so ending a recording never needs the caller's runtime.
   */
  private abortNow(runId: string): void {
    const active = this.recordings.get(runId)
    if (active === undefined) return
    this.recordings.delete(runId)
    const unwatch = active.unwatch
    active.unwatch = null
    if (unwatch !== null) Effect.runSync(unwatch.pipe(Effect.catchAll(() => Effect.void)))
    if (active.unsubscribe !== null) {
      Effect.runSync(active.unsubscribe.pipe(Effect.catchAll(() => Effect.void)))
      active.unsubscribe = null
    }
    // Destroy first: a write queued by the muxer must not leave the FLV behind.
    active.stream.destroy()
    rmSync(active.flvPath, { force: true })
  }

  /** Waits for everything written to reach the file and closes it. */
  private finish(stream: WriteStream): Promise<void> {
    const { promise, resolve, reject } = Promise.withResolvers<void>()
    if (stream.closed) {
      resolve()
      return promise
    }
    stream.once("close", () => resolve())
    stream.once("error", reject)
    stream.end()
    return promise
  }
}
