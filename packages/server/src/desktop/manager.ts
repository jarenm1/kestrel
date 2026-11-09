import { spawn, type ChildProcess } from "node:child_process"
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { StringDecoder } from "node:string_decoder"
import { Context, Data, Deferred, Effect, Fiber, Layer } from "effect"
import { hasRenderNode } from "./requirements"
import {
  DEFAULT_DESKTOP_QUALITY,
  DESKTOP_QUALITIES,
  type DesktopInput,
  type DesktopQuality,
  type DesktopState,
  type DesktopStatus,
} from "@cloudagents/protocol"
import { NEW_PROCESS_GROUP, killProcessGroup, ownGroup } from "../process"
import { startDesktopAudio, type DesktopAudio } from "./audio"
import { FlvDemuxer, type FlvEvent } from "./flv"
import { type AvcConfig, type H264Unit, parseAvcConfig } from "./rtp"
import { type H264EncoderProfile, WEBRTC_H264_LEVEL } from "./h264"
import { profileFor, profileRestartNeeded } from "./profile"
import { encodePng, resample, type RgbFrame } from "./frames"
import { writeOpenboxConfig } from "./theme"
import { isWsl } from "./platform"
import { applyDesktopEvent } from "./desktop-state"
import { desktopStatus, HEIGHT, WIDTH, type DesktopStatusSource } from "./status"
import {
  ENCODER_STABLE_MS,
  MAX_ENCODER_RESTARTS,
  encoderConfigured,
  encoderRestart,
  encoderStable,
  restartBudget,
  viewerServed,
  type RestartBudget,
} from "./restart-budget"
import wallpaper from "./wallpaper.png" with { type: "file" }

export class DesktopError extends Data.TaggedError("DesktopError")<{ readonly message: string }> {}

/**
 * What the desktop emits to a viewer: H.264 config and access units, and Opus packets from the desktop's audio, each with
 * its RTP timestamp. `baselineOnly` is true while the viewer's payload is Constrained Baseline: the encoder stays on
 * Baseline while such a viewer is connected (see profileFor).
 */
export interface DesktopSink {
  readonly baselineOnly: boolean
  onStatus(s: DesktopStatus): void
  onMedia(unit: H264Unit): void
  onAudio(opus: Uint8Array, timestamp: number): void
}

/** A process prepared by the caller (sandboxed); the desktop only spawns and tracks it. */
export interface ProcessSpec {
  readonly file: string
  readonly args: ReadonlyArray<string>
  readonly env: Readonly<Record<string, string>>
  readonly cwd: string
}

/** A rectangle of the desktop, in the same pixel coordinates the rest of the desktop API uses. */
export interface DesktopRegion {
  readonly x: number
  readonly y: number
  readonly width: number
  readonly height: number
}

/** An app started with `launch`. `output` is the tail of its stdout and stderr. */
export interface DesktopApp {
  readonly id: string
  readonly command: string
  readonly running: boolean
  readonly exitCode: number | null
  /** Signal that ended the process, if any. */
  readonly signal: string | null
  readonly output: string
}

/**
 * The task holder's IPC and mount namespaces, which the task desktop and the box's clients of it join. The mount
 * namespace holds the desktop's X socket directory: a private /tmp/.X11-unix, since WSLg mounts the host's read-only.
 */
export interface IpcNamespace {
  /** Pid of a process in it now (the task's namespace holder). */
  readonly holder: number
  /** The X socket directory as this process sees it. */
  readonly x11Dir: string
  /** Argv prefix that runs a command in the IPC and mount namespaces of process `pid`. */
  readonly join: (pid: number) => ReadonlyArray<string>
}

export interface DesktopStartOptions {
  /** Builds the terminal opened on a fresh desktop, given its X display (e.g. ":101"). */
  readonly terminal: (display: string) => Effect.Effect<ProcessSpec, DesktopError>
  /**
   * The X server and the box's MIT-SHM clients (capture, screenshots) run in this namespace, so sandboxed apps can use
   * MIT-SHM too.
   */
  readonly ipcNamespace: Effect.Effect<IpcNamespace, DesktopError>
}

export class DesktopManager extends Context.Tag("cloudagents/DesktopManager")<
  DesktopManager,
  {
    readonly start: (taskId: string, opts: DesktopStartOptions) => Effect.Effect<DesktopStatus, DesktopError>
    readonly stop: (taskId: string) => Effect.Effect<void>
    readonly status: (taskId: string) => Effect.Effect<DesktopStatus>
    /** `crop` is in desktop pixels; `scale` multiplies the output size (1 = unchanged). */
    readonly screenshot: (
      taskId: string,
      crop?: DesktopRegion,
      scale?: number,
    ) => Effect.Effect<Uint8Array, DesktopError>
    /** The whole desktop as raw RGB24, grabbed now. */
    readonly grab: (taskId: string) => Effect.Effect<RgbFrame, DesktopError>
    readonly cursor: (taskId: string) => Effect.Effect<{ readonly x: number; readonly y: number }, DesktopError>
    /** Runs one event through xdotool and waits for it; a failing command is returned as an error. Used by MCP tools. */
    readonly input: (taskId: string, event: DesktopInput) => Effect.Effect<void, DesktopError>
    /** Queues one event for the desktop's persistent xdotool helper and returns at once; mouse moves coalesce. Used by viewer streams. */
    readonly streamInput: (taskId: string, event: DesktopInput) => Effect.Effect<void, DesktopError>
    /** Starts an app on the live desktop and returns it. Killed with the desktop. `command` is what was asked for. */
    readonly launch: (taskId: string, command: string, process: ProcessSpec) => Effect.Effect<DesktopApp, DesktopError>
    /** Every app launched on the desktop, exited ones included, oldest first. */
    readonly processes: (taskId: string) => Effect.Effect<ReadonlyArray<DesktopApp>, DesktopError>
    /** Terminates an app (SIGTERM, then SIGKILL) and returns its final state. */
    readonly kill: (taskId: string, id: string) => Effect.Effect<DesktopApp, DesktopError>
    readonly subscribe: (taskId: string, sink: DesktopSink) => Effect.Effect<Effect.Effect<void>, DesktopError>
    readonly watchStatus: (listener: (s: DesktopStatus) => void) => Effect.Effect<Effect.Effect<void>>
    /** Sets how the live desktop is streamed; a running encoder restarts at the new size and frame rate. */
    readonly setQuality: (taskId: string, quality: DesktopQuality) => Effect.Effect<DesktopStatus, DesktopError>
    /** Re-picks the live encoder's profile after a viewer's payload changed (see profileFor). Synchronous; no-op without a live encoder. */
    readonly refreshProfile: (taskId: string) => Effect.Effect<void>
    /** Desktops that are starting or running (a failed desktop has already had its processes terminated). */
    readonly activeCount: () => Effect.Effect<number>
    /** The GPU is available: desktops restart on the GPU renderer. */
    readonly attachHardwareRender: Effect.Effect<void, DesktopError>
    /** The GPU is going away: desktops on the GPU stop now and come back on software rendering in the background. */
    readonly releaseHardwareRender: Effect.Effect<void, DesktopError>
    readonly stopAll: () => Effect.Effect<void>
  }
>() {}

const FIRST_DISPLAY = 101
const LAST_DISPLAY = 199
const X_SOCKET_TIMEOUT_MS = 10_000
const READY_TIMEOUT_MS = 20_000
const TERM_GRACE_MS = 2_000
const COMMAND_TIMEOUT_MS = 15_000
/**
 * Shown centered on the black root window; 2560x1440-scale artwork, so it stays sharp at DESKTOP_SCALE. Embedded in a
 * compiled `kestrel-box`, where only this process can read it, so it is copied next to the openbox config for hsetroot.
 */
const WALLPAPER = wallpaper
/** Output kept per launched app; older text is dropped. */
const OUTPUT_TAIL_CHARS = 32 * 1024
/**
 * Keyframe clock: an IDR at least every KEYFRAME_INTERVAL_S of capture time. A static desktop encodes nothing, so the
 * interval is what bounds how long a joiner waits for a keyframe and how large the cached GOP can get. On a static
 * desktop the IDR is nearly all of the bitrate (NVENC: ~600 KB IDR vs ~0.1 KB P-frame at 1080p).
 * Late joiners don't wait for it: they get the cached GOP.
 */
const KEYFRAME_INTERVAL_S = 4
/** Cap on the cached current GOP replayed to late joiners. Past it, joiners wait for the next keyframe. */
const GOP_CACHE_MAX_BYTES = 8 * 1024 * 1024
/** How long a live encoder keeps running after its last viewer leaves. */
const LINGER_MS = 15_000
/** Unexpected xdotool helper exits tolerated per desktop before it fails. */
const MAX_INPUT_RESTARTS = 3
/** Leave most of the desktop readiness budget for CPU fallback if NVENC never produces its config. */
const NVENC_START_TIMEOUT_MS = 5_000
/** NVENC is skipped for this long after it reports a busy GPU (session limit) or misses its startup deadline. */
const NVENC_BUSY_BACKOFF_MS = 30_000
/** Process-wide: NVENC that fails to start for a non-busy reason is not tried again. */
let nvencDisabled = false
let nvencBusyUntil = 0
/** Process-wide: this ffmpeg has NVENC but not the CUDA filters (common in distro builds), so NVENC scales on the CPU. */
let cudaFiltersMissing = false
/** Boot waits this long for the audio server, so apps launched as the desktop comes up get its socket (see prepareLaunch). */
const AUDIO_BOOT_WAIT_MS = 3_000
/** Audio that dies is started again this many times per desktop, after this long. Running apps keep their dead socket. */
const MAX_AUDIO_RESTARTS = 3
const AUDIO_RESTART_DELAY_MS = 1_000

type EncoderKind = "nvenc" | "x264"

/** One ffmpeg encoder process and the demuxer for its FLV stdout. */
interface Encoder {
  readonly kind: EncoderKind
  readonly demux: FlvDemuxer
  /** Set right after spawn. */
  child: ChildProcess | null
  /** The config arrived: later exits are restarts, not boot failures. */
  initialized: boolean
  startupTimer: NodeJS.Timeout | undefined
  /** Tail of stderr, for classifying why NVENC would not start. */
  stderr: string
}

/** The long-lived `xdotool -` for a desktop: one command per stdin line, run as the line arrives. */
interface InputPipe {
  readonly child: ChildProcess
  /** Commands the helper has not taken yet. Queued mouse moves are coalesced; see queueInput. */
  readonly queue: PendingInput[]
}

interface PendingInput {
  readonly line: string
  readonly move: boolean
}

/** What a desktop needs to come back after a stop: its launch settings and the viewers that were watching it. */
interface Relaunch {
  readonly taskId: string
  readonly terminal: DesktopStartOptions["terminal"]
  readonly ipcNamespace: DesktopStartOptions["ipcNamespace"]
  readonly sinks: ReadonlyArray<DesktopSink>
}

interface Session {
  readonly taskId: string
  readonly num: number
  readonly display: string
  readonly terminal: DesktopStartOptions["terminal"]
  readonly ipcNamespace: DesktopStartOptions["ipcNamespace"]
  /** Size and frame rate cap of the stream; the encoder is started with it. */
  quality: DesktopQuality
  /**
   * Argv prefix for the box's clients of the desktop: joins the X server's IPC and mount namespaces (the mount namespace
   * holds its socket directory). The server lives as long as the session, so the target cannot go stale the way a
   * holder pid could. Set by boot once it is spawned; empty without a namespace.
   */
  ipc: ReadonlyArray<string>
  /** weston's XDG_RUNTIME_DIR (its Wayland socket); removed when the desktop stops. Null until boot makes it. */
  runtimeDir: string | null
  /** The renderer weston was started with: `gl` on the GPU, `pixman` in software. Null until boot starts it. */
  renderer: "gl" | "pixman" | null
  /** The boot, forked so a stop can cancel it. Null until startDesktop forks it. */
  boot: Fiber.RuntimeFiber<unknown, unknown> | null
  /** Completes when the stream's config has been parsed (running) or fails. */
  readonly ready: Deferred.Deferred<void, DesktopError>
  /** Live child processes; each is a process-group leader (detached). */
  readonly procs: Set<ChildProcess>
  readonly sinks: Set<DesktopSink>
  /** Apps started with launch(), in launch order. */
  readonly apps: Map<string, AppRecord>
  /** Live encoder, or null while idle (no viewers past the linger) or after failure. */
  encoder: Encoder | null
  /** The profile the live encoder produces (see profileFor); set when it starts. */
  profile: H264EncoderProfile
  state: DesktopState
  error: string | null
  /** The stream's H.264 config once the encoder produces it; null before that, and after a failure or stop. */
  config: AvcConfig | null
  /** Fragments of the current GOP, keyframe first; null when not cached (restarting, or over the cap). */
  gop: Uint8Array[] | null
  gopBytes: number
  /** Sinks that must not get delta fragments until the next keyframe. */
  awaiting: Set<DesktopSink>
  lingerTimer: NodeJS.Timeout | null
  /** Unexpected encoder restarts left; reset only by a stable live period or a served viewer. */
  restartBudget: RestartBudget
  /** Fires once the live encoder has been live long enough to earn its restart budget back. */
  stableTimer: NodeJS.Timeout | null
  stderrTail: string
  /** The long-lived xdotool helper; null until boot starts it and while it is being restarted. */
  input: InputPipe | null
  inputRestartsLeft: number
  /** The desktop's Opus source (PulseAudio and capture), or null when audio is unavailable. */
  audio: DesktopAudio | null
  /** Ends this desktop's subscription to `audio`, which keeps its capture running; null while nobody is listening. */
  audioListener: (() => void) | null
  audioRestartsLeft: number
}

/** Keeps the tail of a launched app's output. Decodes per stream so UTF-8 split across chunks survives. */
class OutputTail {
  private text = ""
  private readonly decoders = { stdout: new StringDecoder("utf8"), stderr: new StringDecoder("utf8") }

  push(stream: "stdout" | "stderr", data: Buffer): void {
    this.text = (this.text + this.decoders[stream].write(data)).slice(-OUTPUT_TAIL_CHARS)
  }

  get value(): string {
    return this.text
  }
}

interface AppRecord {
  readonly id: string
  readonly command: string
  readonly child: ChildProcess
  readonly output: OutputTail
  exit: { readonly code: number | null; readonly signal: string | null } | null
}

const appView = (a: AppRecord): DesktopApp => ({
  id: a.id,
  command: a.command,
  running: a.exit === null,
  exitCode: a.exit?.code ?? null,
  signal: a.exit?.signal ?? null,
  output: a.output.value,
})

const toErr = (e: unknown): DesktopError =>
  e instanceof DesktopError ? e : new DesktopError({ message: e instanceof Error ? e.message : String(e) })

const pixel = (v: number, max: number) => Math.min(max - 1, Math.max(0, Math.round(v * max)))

/** Notches per mouse.wheel event in each direction. The viewer sends notch counts; a larger count is clamped to this. */
const WHEEL_NOTCH_LIMIT = 10

/** "ctrl+c" -> ["ctrl", "c"]. The plus key is named "plus", so "+" and "ctrl++" both name it. */
const keyParts = (key: string): string[] => {
  const named = key === "+" ? "plus" : key.endsWith("++") ? `${key.slice(0, -2)}+plus` : key
  return named.length > 1 ? named.split("+").filter((p) => p.length > 0) : [named]
}

const xdotoolArgs = (e: DesktopInput): string[] => {
  switch (e._tag) {
    case "mouse.move":
      return ["mousemove", String(pixel(e.x, WIDTH)), String(pixel(e.y, HEIGHT))]
    case "mouse.button":
      return [
        "mousemove",
        String(pixel(e.x, WIDTH)),
        String(pixel(e.y, HEIGHT)),
        e.down ? "mousedown" : "mouseup",
        String(e.button),
      ]
    case "mouse.wheel": {
      // X buttons: 4 = up, 5 = down, 6 = left, 7 = right.
      const dy = Math.max(-WHEEL_NOTCH_LIMIT, Math.min(WHEEL_NOTCH_LIMIT, e.dy))
      const dx = Math.max(-WHEEL_NOTCH_LIMIT, Math.min(WHEEL_NOTCH_LIMIT, e.dx))
      const args: string[] = []
      if (dy !== 0) args.push("click", "--repeat", String(Math.abs(dy)), dy > 0 ? "5" : "4")
      if (dx !== 0) args.push("click", "--repeat", String(Math.abs(dx)), dx > 0 ? "7" : "6")
      return args
    }
    case "key": {
      // "ctrl+c" presses ctrl then c, releases in reverse order.
      const parts = keyParts(e.key)
      const ordered = e.down ? parts : [...parts].reverse()
      return ordered.flatMap((p) => [e.down ? "keydown" : "keyup", p])
    }
    case "text":
      return e.text.length === 0 ? [] : ["type", "--", e.text]
  }
}

/** Single-quotes one argument. xdotool's stdin mode splits each line shell-style; inside single quotes a word is literal. */
const quoteArg = (arg: string): string => {
  if (/[\r\n]/.test(arg)) throw new Error(`input cannot contain a line break: ${JSON.stringify(arg)}`)
  return `'${arg.replaceAll("'", `'"'"'`)}'`
}

/** xdotool stdin lines for one input event. Text is typed in pieces, and each line break in it is Return. */
const xdotoolLines = (e: DesktopInput): string[] => {
  if (e._tag !== "text") {
    const args = xdotoolArgs(e)
    return args.length === 0 ? [] : [args.map(quoteArg).join(" ")]
  }
  return e.text.split(/\r\n|\r|\n/).flatMap((piece, i) => [
    ...(i > 0 ? ["key Return"] : []),
    ...(piece.length > 0 ? [`type -- ${quoteArg(piece)}`] : []),
  ])
}

/**
 * Encoder arguments by kind and profile. Both produce 4:2:0 H.264 at level 4.0 (WEBRTC_H264_LEVEL) with a GOP of `gop`
 * frames and no B-frames. `profile` is "high" (High, no B-frames) or "baseline" (Constrained Baseline); see profileFor.
 * NVENC gets the frames as CUDA bgr0 surfaces (see ffmpegArgs) and converts them to 4:2:0 on the GPU. `-delay 0
 * -zerolatency 1` stop NVENC from holding output frames: screen change to frame on stdout drops from 66 ms to 33 ms.
 * p4/ll costs the same CPU and latency as p1/ull at ~25-30% less bitrate on text and scrolling. Both profiles need 4:2:0
 * output: an RGB 4:4:4 source makes NVENC write High 4:4:4 whatever the profile says.
 */
const encoderArgs = (kind: EncoderKind, gop: number, profile: H264EncoderProfile): readonly string[] => {
  const profileArgs = ["-profile:v", profile, "-level:v", WEBRTC_H264_LEVEL]
  switch (kind) {
    case "nvenc":
      return [
        "-c:v", "h264_nvenc",
        "-preset", "p4",
        "-tune", "ll",
        "-delay", "0",
        "-zerolatency", "1",
        "-rc", "vbr",
        "-cq", "23",
        "-b:v", "0",
        "-maxrate", "20M",
        "-bufsize", "20M",
        "-bf", "0",
        ...profileArgs,
        "-g", String(gop),
        "-forced-idr", "1",
      ]
    case "x264":
      return [
        "-c:v", "libx264",
        "-preset", "veryfast",
        "-tune", "zerolatency",
        ...profileArgs,
        "-bf", "0",
        "-crf", "23",
        "-pix_fmt", "yuv420p",
        "-g", String(gop),
        "-sc_threshold", "0",
      ]
  }
}

/**
 * ffmpeg reads the raw bgr0 frames that xdamage-capture writes to its stdin (xdamage-capture runs ffmpeg as its child)
 * at the desktop's size, and scales them to the quality's. Frames pass through at their arrival times (`-fps_mode passthrough`);
 * cfr would hold each frame until the next one arrives, adding up to a keepalive interval of latency. See ffmpegArgs.
 * NVENC: the frames are uploaded to CUDA at full size and scale_cuda shrinks them there. The CPU area scale cost ~75%
 * of a core at 2560x1440 -> 1920x1080 30 fps. scale_cuda takes bgr0 as-is; a format change before it fails in this build.
 */
export const ffmpegArgs = (
  kind: EncoderKind,
  quality: DesktopQuality,
  profile: H264EncoderProfile,
  cudaFilters = true,
): string[] => {
  const { width, height, fps } = DESKTOP_QUALITIES[quality]
  const gpu = kind === "nvenc" && cudaFilters
  // NVENC without CUDA filters takes the CPU's scale as 4:2:0: its RGB input would make it write High 4:4:4.
  const cpuScale = `scale=${width}:${height}:flags=area${kind === "nvenc" ? ",format=yuv420p" : ""}`
  return [
    "-hide_banner",
    "-loglevel",
    "error",
    ...(gpu ? ["-init_hw_device", "cuda=cu:0", "-filter_hw_device", "cu"] : []),
    // No -fflags nobuffer: with it, the x264 fallback after a stalled NVENC never produced an init segment on a still
    // desktop (startup.integration.test.ts, real xterm). Timestamps still come from the arrival clock.
    "-f",
    "rawvideo",
    "-pix_fmt",
    "bgr0",
    "-video_size",
    `${WIDTH}x${HEIGHT}`,
    "-use_wallclock_as_timestamps",
    "1",
    "-i",
    "pipe:0",
    // Area averaging keeps downscaled text legible on the CPU path. scale_cuda uses bicubic (interp_algo 3): the best of
    // its kernels against the area reference (lanczos, 4, scored ~11 dB lower), and ~3 dB under the CPU area filter.
    "-vf",
    gpu ? `hwupload_cuda,scale_cuda=${width}:${height}:interp_algo=3` : cpuScale,
    // GOP backstop: equal to KEYFRAME_INTERVAL_S at the capped rate, so the clock normally fires first.
    ...encoderArgs(kind, fps * KEYFRAME_INTERVAL_S, profile),
    "-force_key_frames",
    `expr:gte(t-prev_forced_t,${KEYFRAME_INTERVAL_S})`,
    // Passthrough: each frame is emitted as it arrives. xdamage-capture sends a keepalive frame each second while the
    // screen is still, so Chrome does not freeze long enough to send a PLI (about every 3 s), which replays the GOP.
    "-fps_mode",
    "passthrough",
    "-an",
    "-f",
    "flv",
    // One video tag per frame: the demuxer completes each frame as its tag arrives.
    "-flush_packets",
    "1",
    "pipe:1",
  ]
}

const waitExit = (p: ChildProcess, ms: number): Promise<void> => {
  if (p.exitCode !== null || p.signalCode !== null) return Promise.resolve()
  const { promise, resolve } = Promise.withResolvers<void>()
  const timer = setTimeout(resolve, ms)
  p.once("exit", () => {
    clearTimeout(timer)
    resolve()
  })
  return promise
}

/** SIGTERM every process group, wait a grace period, then SIGKILL whatever is left. */
const terminate = async (procs: Iterable<ChildProcess>) => {
  const list = [...procs]
  for (const p of list) killProcessGroup(p.pid, "SIGTERM")
  await Promise.all(list.map((p) => waitExit(p, TERM_GRACE_MS)))
  for (const p of list) killProcessGroup(p.pid, "SIGKILL")
}

const waitForSocket = async (s: Session, x11Dir: string) => {
  const socket = join(x11Dir, `X${s.num}`)
  const deadline = Date.now() + X_SOCKET_TIMEOUT_MS
  while (!existsSync(socket)) {
    if (s.state !== "starting") throw new Error(s.error ?? "the X server stopped before accepting connections")
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${socket}`)
    const { promise, resolve } = Promise.withResolvers<void>()
    setTimeout(resolve, 50)
    await promise
  }
}

/** `prefix` (an IPC namespace join, or empty) runs before the command. */
const runCommand = (command: string, args: readonly string[], display: string, prefix: ReadonlyArray<string> = []) => {
  const { promise, resolve, reject } = Promise.withResolvers<{ exitCode: number; stdout: Buffer; stderr: string }>()
  const [file = command, ...argv] = [...prefix, command, ...args]
  const child = spawn(file, argv, {
    env: { ...process.env, DISPLAY: display },
    stdio: ["ignore", "pipe", "pipe"],
  })
  const out: Buffer[] = []
  let err = ""
  const timer = setTimeout(() => child.kill("SIGKILL"), COMMAND_TIMEOUT_MS)
  child.stdout.on("data", (d: Buffer) => out.push(d))
  child.stderr.on("data", (d: Buffer) => {
    err += d.toString()
  })
  child.on("error", (e) => {
    clearTimeout(timer)
    reject(e)
  })
  child.on("close", (code) => {
    clearTimeout(timer)
    resolve({ exitCode: code ?? -1, stdout: Buffer.concat(out), stderr: err })
  })
  return promise
}

/** The whole desktop as raw RGB24, from one x11grab frame. */
const grabFrame = (s: Session): Effect.Effect<RgbFrame, DesktopError> =>
  Effect.gen(function* () {
    const r = yield* Effect.tryPromise({
      try: () =>
        runCommand(
          "ffmpeg",
          [
            "-hide_banner",
            "-loglevel",
            "error",
            "-f",
            "x11grab",
            "-video_size",
            `${WIDTH}x${HEIGHT}`,
            "-i",
            s.display,
            "-frames:v",
            "1",
            "-f",
            "rawvideo",
            "-pix_fmt",
            "rgb24",
            "pipe:1",
          ],
          s.display,
          s.ipc,
        ),
      catch: toErr,
    })
    if (r.exitCode !== 0 || r.stdout.length !== WIDTH * HEIGHT * 3) {
      return yield* Effect.fail(new DesktopError({ message: `screenshot failed: ${r.stderr.trim()}` }))
    }
    return { width: WIDTH, height: HEIGHT, pixels: r.stdout }
  })

/** Writes queued commands while the helper's pipe takes them. Past Node's buffer limit, the rest wait for 'drain'. */
const flushInput = (pipe: InputPipe) => {
  const stdin = pipe.child.stdin
  if (!stdin) return
  while (pipe.queue.length > 0 && !stdin.writableNeedDrain) {
    const next = pipe.queue.shift()
    if (next) stdin.write(`${next.line}\n`)
  }
}

/** Queues one command behind any backlog. A mouse move replaces a queued move: a backed-up helper sees only the latest position. */
const queueInput = (pipe: InputPipe, line: string, move: boolean) => {
  const last = pipe.queue.at(-1)
  if (move && last?.move) pipe.queue[pipe.queue.length - 1] = { line, move }
  else pipe.queue.push({ line, move })
  flushInput(pipe)
}

export const DesktopManagerLive: Layer.Layer<DesktopManager> = Layer.effect(
  DesktopManager,
  Effect.gen(function* () {
    const sessions = new Map<string, Session>()
    let hardwareRender = true
    /** The renderer a desktop booted now gets: the GPU when it is wanted and a render node exists. */
    const desiredRenderer = (): "gl" | "pixman" => (hardwareRender && hasRenderNode() ? "gl" : "pixman")
    const watchers = new Set<(s: DesktopStatus) => void>()
    /** Openbox config, theme and wallpaper shared by this process's desktops; written on the first boot, removed on exit. */
    let openboxConfig: { readonly dir: string; readonly rc: string; readonly wallpaper: string } | null = null

    const toStatus = (taskId: string, s: Session | undefined): DesktopStatus => {
      const source: DesktopStatusSource | undefined =
        s === undefined
          ? undefined
          : {
              state: s.state,
              display: s.display,
              quality: s.quality,
              error: s.error,
              // Encoder presence is the streaming fact; the lifecycle state is not.
              streaming: s.encoder !== null,
            }
      return desktopStatus(taskId, source)
    }

    const publish = (s: Session) => {
      const st = toStatus(s.taskId, s)
      for (const sink of s.sinks) sink.onStatus(st)
      for (const w of watchers) w(st)
    }

    const cancelLinger = (s: Session) => {
      if (s.lingerTimer === null) return
      clearTimeout(s.lingerTimer)
      s.lingerTimer = null
    }

    /** Forgets the encoder and everything cached from it. The caller stops the process. */
    const detachEncoder = (s: Session) => {
      cancelLinger(s)
      clearTimeout(s.encoder?.startupTimer)
      clearTimeout(s.stableTimer ?? undefined)
      s.stableTimer = null
      s.encoder = null
      s.config = null
      s.gop = null
      s.gopBytes = 0
      s.awaiting.clear()
    }

    const failSession = (s: Session, message: string) => {
      const tail = s.stderrTail.trim().slice(-500)
      const full = tail ? `${message}: ${tail}` : message
      const transition = applyDesktopEvent(s, { _tag: "failed", message: full })
      if (transition._tag === "illegal") return
      detachEncoder(s)
      Deferred.unsafeDone(s.ready, Effect.fail(new DesktopError({ message: full })))
      publish(s)
      s.audio?.stop()
      void terminate(s.procs)
    }

    /** Stops the encoder on purpose (no viewers left): not a failure, so nothing restarts it. */
    const stopEncoder = (s: Session) => {
      const enc = s.encoder
      if (enc === null) return
      detachEncoder(s)
      if (enc.child) void terminate([enc.child])
      // Encoder presence changed while `state` did not: watchers must see `streaming: false` (e.g. after the linger).
      publish(s)
    }

    /** Starts the linger countdown once the last viewer has left a live encoder. */
    const scheduleStop = (s: Session) => {
      if (s.sinks.size > 0 || s.lingerTimer !== null) return
      if (s.encoder === null) {
        stopListeningToAudio(s)
        return
      }
      s.lingerTimer = setTimeout(() => {
        s.lingerTimer = null
        if (s.sinks.size > 0) return
        stopEncoder(s)
        stopListeningToAudio(s)
      }, LINGER_MS)
    }

    /** Runs the audio capture for this desktop's viewers. A no-op until the audio server is up (see startAudio). */
    const listenToAudio = (s: Session) => {
      if (s.audio === null || s.audioListener !== null) return
      s.audioListener = s.audio.subscribe((packet) => {
        for (const sink of s.sinks) sink.onAudio(packet.opus, packet.timestamp)
      })
    }

    const stopListeningToAudio = (s: Session) => {
      s.audioListener?.()
      s.audioListener = null
    }

    const onEncoderBytes = (s: Session, enc: Encoder, data: Buffer) => {
      if (s.encoder !== enc || (s.state !== "starting" && s.state !== "running")) return
      let events: FlvEvent[]
      try {
        events = enc.demux.push(data)
      } catch (e) {
        failSession(s, toErr(e).message)
        return
      }
      for (const event of events) {
        if (event.kind === "config") {
          let config: AvcConfig
          try {
            config = parseAvcConfig(event.avcc.slice())
          } catch (e) {
            failSession(s, toErr(e).message)
            return
          }
          enc.initialized = true
          clearTimeout(enc.startupTimer)
          enc.startupTimer = undefined
          // A config proves the encoder started, not that it stays alive: only a stable live period (or a served
          // viewer) earns the restart budget back, so an encoder that initializes then dies cannot loop forever.
          s.restartBudget = encoderConfigured(s.restartBudget, Date.now())
          clearTimeout(s.stableTimer ?? undefined)
          s.stableTimer = setTimeout(() => {
            s.stableTimer = null
            if (s.encoder !== enc) return
            s.restartBudget = encoderStable(s.restartBudget, Date.now())
          }, ENCODER_STABLE_MS)
          s.config = config
          s.state = "running"
          Deferred.unsafeDone(s.ready, Effect.void)
          publish(s)
          for (const sink of s.sinks) sink.onMedia({ kind: "config", config })
          scheduleStop(s)
          continue
        }
        // Copied: the demuxer's views are only valid until its next push.
        const au = event.data.slice()
        if (event.keyframe) {
          s.gop = [au]
          s.gopBytes = au.length
          s.awaiting.clear()
        } else if (s.gop !== null) {
          s.gop.push(au)
          s.gopBytes += au.length
          if (s.gopBytes > GOP_CACHE_MAX_BYTES) {
            s.gop = null
            s.gopBytes = 0
          }
        }
        const unit: H264Unit = { kind: event.keyframe ? "key" : "delta", au }
        for (const sink of s.sinks) if (event.keyframe || !s.awaiting.has(sink)) sink.onMedia(unit)
      }
    }

    // WSL desktops use CPU encoding: trying NVENC there can consume the first startup timeout.
    const wsl = isWsl()
    /** NVENC when it is usable, libx264 otherwise. */
    const preferredEncoder = (): EncoderKind => (!wsl && !nvencDisabled && Date.now() >= nvencBusyUntil ? "nvenc" : "x264")

    /** Constrained Baseline while a connected viewer decodes only Baseline; High otherwise (see profile.ts). */
    const profileOf = (s: Session): H264EncoderProfile => profileFor(s.sinks)

    /** Starts an encoder; throws if the process cannot be spawned. Viewers wait for its keyframe. */
    const startEncoder = (s: Session, kind: EncoderKind) => {
      const { fps } = DESKTOP_QUALITIES[s.quality]
      const enc: Encoder = { kind, demux: new FlvDemuxer(), child: null, initialized: false, startupTimer: undefined, stderr: "" }
      s.config = null
      s.gop = null
      s.gopBytes = 0
      s.awaiting = new Set(s.sinks)
      s.profile = profileOf(s)
      const capture = [String(WIDTH), String(HEIGHT), String(fps), "ffmpeg", ...ffmpegArgs(kind, s.quality, s.profile, !cudaFiltersMissing)]
      enc.child = spawnTracked(s, "xdamage-capture", capture, {
        critical: false,
        prefix: s.ipc,
        onStdout: (d) => onEncoderBytes(s, enc, d),
        onStderr: (d) => {
          enc.stderr = (enc.stderr + d.toString()).slice(-2000)
        },
        onExit: (reason) => onEncoderExit(s, enc, reason),
      })
      s.encoder = enc
      // Encoder presence changed; `state` may not have (a viewer woke an idle running desktop).
      publish(s)
      if (kind === "nvenc") {
        enc.startupTimer = setTimeout(() => {
          if (s.encoder !== enc || enc.initialized || (s.state !== "starting" && s.state !== "running")) return
          // A timeout can be transient (slow startup or a quiet display), so retry hardware on a later start.
          nvencBusyUntil = Date.now() + NVENC_BUSY_BACKOFF_MS
          console.warn(`desktop ${s.display}: nvenc did not initialize within ${NVENC_START_TIMEOUT_MS} ms; using libx264`)
          stopEncoder(s)
          launchEncoder(s, "x264")
        }, NVENC_START_TIMEOUT_MS)
      }
    }

    /**
     * Starts the desktop's audio alongside the X server boot; the returned promise settles when it is up or has failed.
     * A desktop without audio still serves video and input. The audio m-line is answered sendonly for every viewer
     * (webrtc.ts), so audio that becomes ready after a viewer's offer starts flowing to it without renegotiation.
     */
    const startAudio = (s: Session, x11Dir: string): Promise<void> =>
      startDesktopAudio({
        display: s.display,
        x11Dir,
        spawn: (command, args, env) => spawnTracked(s, command, args, { critical: false, prefix: s.ipc, env }),
        onError: (message) => {
          console.warn(`desktop ${s.display}: audio: ${message}`)
          s.audio = null
          s.audioListener = null
          if (s.audioRestartsLeft === 0) return
          s.audioRestartsLeft--
          setTimeout(() => {
            if (s.state === "starting" || s.state === "running") void startAudio(s, x11Dir)
          }, AUDIO_RESTART_DELAY_MS)
        },
      }).then(
        (audio) => {
          if (audio === null) return
          if (s.state === "stopped" || s.state === "failed") {
            audio.stop()
            return
          }
          s.audio = audio
          if (s.sinks.size > 0) listenToAudio(s)
        },
        (e) => console.warn(`desktop ${s.display}: audio failed to start: ${toErr(e).message}`),
      )

    /**
     * Restarts a live encoder whose profile no longer matches the connected viewers. Viewers wait for its keyframe, as
     * after any start. With no live encoder nothing restarts: the next start picks the profile itself.
     */
    const applyProfile = (s: Session) => {
      const enc = s.encoder
      if (enc === null || (s.state !== "starting" && s.state !== "running")) return
      if (!profileRestartNeeded(s.sinks, s.profile)) return
      stopEncoder(s)
      launchEncoder(s, enc.kind)
    }

    /** Starts an encoder from a process callback, where a spawn error must fail the desktop instead of throwing. */
    const launchEncoder = (s: Session, kind: EncoderKind) => {
      try {
        startEncoder(s, kind)
      } catch (e) {
        failSession(s, toErr(e).message)
      }
    }

    const onEncoderExit = (s: Session, enc: Encoder, reason: string) => {
      if (s.encoder !== enc || (s.state !== "starting" && s.state !== "running")) return
      detachEncoder(s)
      const why = `${enc.kind} encoder exited (${reason})`
      if (enc.kind === "nvenc" && !enc.initialized) {
        // This ffmpeg lacks the CUDA filters, which says nothing about NVENC: scale on the CPU and keep the GPU encoder.
        if (!cudaFiltersMissing && /No such filter: '(?:hwupload|scale)_cuda'/.test(enc.stderr)) {
          cudaFiltersMissing = true
          console.warn(`desktop ${s.display}: ffmpeg has no CUDA filters; nvenc scales on the CPU`)
          launchEncoder(s, "nvenc")
          return
        }
        // NVENC could not start. A busy GPU (session limit) is retried later; anything else disables NVENC.
        if (/OpenEncodeSessionEx|out of memory/i.test(enc.stderr)) nvencBusyUntil = Date.now() + NVENC_BUSY_BACKOFF_MS
        else nvencDisabled = true
        console.warn(`desktop ${s.display}: ${why}; using libx264`)
        launchEncoder(s, "x264")
        return
      }
      if (s.state === "starting") {
        failSession(s, why)
        return
      }
      // Nobody is watching: the next subscribe starts the encoder again.
      if (s.sinks.size === 0) return
      const restart = encoderRestart(s.restartBudget)
      s.restartBudget = restart.budget
      if (!restart.allowed) {
        failSession(s, `${why}; gave up after ${MAX_ENCODER_RESTARTS} restarts`)
        return
      }
      launchEncoder(s, preferredEncoder())
    }

    const spawnTracked = (
      s: Session,
      command: string,
      args: readonly string[],
      opts: {
        critical: boolean
        /** Gives the child a stdin pipe to write commands to. */
        stdin?: boolean
        /** Argv prefix (an IPC namespace join) that runs before the command. */
        prefix?: ReadonlyArray<string>
        cwd?: string
        env?: Readonly<Record<string, string>>
        onStdout?: (d: Buffer) => void
        onStderr?: (d: Buffer) => void
        /** Replaces the default handling of the process ending (a restartable encoder). */
        onExit?: (reason: string) => void
      },
    ) => {
      const [file = command, ...argv] = [...(opts.prefix ?? []), command, ...args]
      const child = ownGroup(
        spawn(file, argv, {
          cwd: opts.cwd,
          detached: NEW_PROCESS_GROUP,
          env: opts.env ? { ...opts.env } : { ...process.env, DISPLAY: s.display },
          stdio: [opts.stdin ? "pipe" : "ignore", opts.onStdout ? "pipe" : "ignore", "pipe"],
        }),
      )
      s.procs.add(child)
      child.stderr?.on("data", (d: Buffer) => {
        s.stderrTail = (s.stderrTail + d.toString()).slice(-4000)
        opts.onStderr?.(d)
      })
      child.stdout?.on("data", (d: Buffer) => opts.onStdout?.(d))
      child.on("error", (e) => {
        s.procs.delete(child)
        if (opts.onExit) opts.onExit(e.message)
        else failSession(s, `${command}: ${e.message}`)
      })
      child.on("exit", (code, signal) => {
        s.procs.delete(child)
        if (opts.onExit) opts.onExit(`${code ?? signal}`)
        else if (opts.critical) failSession(s, `${command} exited (${code ?? signal})`)
      })
      return child
    }

    /** Starts the long-lived `xdotool -` for this desktop; it reads one command per stdin line. Throws if it cannot spawn. */
    const startInput = (s: Session) => {
      const child: ChildProcess = spawnTracked(s, "xdotool", ["-"], {
        critical: false,
        prefix: s.ipc,
        stdin: true,
        onStderr: (d) => {
          Effect.runFork(Effect.logWarning(`desktop ${s.display} input: ${d.toString().trim()}`))
        },
        onExit: (reason) => onInputExit(s, child, reason),
      })
      // EPIPE once the helper has exited; its exit handler restarts it.
      child.stdin?.on("error", () => {})
      const pipe: InputPipe = { child, queue: [] }
      child.stdin?.on("drain", () => flushInput(pipe))
      s.input = pipe
    }

    const onInputExit = (s: Session, child: ChildProcess, reason: string) => {
      if (s.input?.child !== child) return
      s.input = null
      if (s.state !== "starting" && s.state !== "running") return
      if (s.inputRestartsLeft === 0) {
        failSession(s, `xdotool input helper exited (${reason}); gave up after ${MAX_INPUT_RESTARTS} restarts`)
        return
      }
      s.inputRestartsLeft--
      Effect.runFork(Effect.logWarning(`desktop ${s.display}: xdotool input helper exited (${reason}); restarting`))
      try {
        startInput(s)
      } catch (e) {
        failSession(s, toErr(e).message)
      }
    }

    const pickDisplay = (): number => {
      const used = new Set([...sessions.values()].map((s) => s.num))
      for (let n = FIRST_DISPLAY; n <= LAST_DISPLAY; n++) {
        if (!used.has(n) && !existsSync(`/tmp/.X${n}-lock`) && !existsSync(`/tmp/.X11-unix/X${n}`)) return n
      }
      throw new Error(`no free X display in :${FIRST_DISPLAY}-:${LAST_DISPLAY}`)
    }

    const boot = (s: Session) =>
      Effect.gen(function* () {
        const ns = yield* s.ipcNamespace
        // The desktop's X server: a rootful Xwayland window filling a headless weston output. Xwayland draws with
        // glamor on the GPU weston renders with and gives X clients DRI3 + GLX on it, so desktop apps get hardware GL
        // and Vulkan. Without a render node weston uses pixman and Xwayland software rendering (Mesa llvmpipe).
        // Kiosk shell: the Xwayland window is the output's one fullscreen surface, with no panel or helper clients.
        // Idle time 0: an idle output stops the frame callbacks that pace Xwayland's Present. weston exits with Xwayland.
        // Only the /tmp/.X11-unix/X<n> file socket: sandboxes share the host network namespace, so the abstract socket
        // (`local`) would let every task's agent reach every display.
        const renderer = desiredRenderer()
        s.renderer = renderer
        const server = yield* Effect.try({
          try: () => {
            const runtimeDir = mkdtempSync(join(tmpdir(), `kestrel-wayland-${s.num}-`))
            s.runtimeDir = runtimeDir
            const env: Record<string, string> = { XDG_RUNTIME_DIR: runtimeDir }
            for (const [name, value] of Object.entries(process.env)) {
              if (value !== undefined && name !== "DISPLAY" && name !== "WAYLAND_DISPLAY" && name !== "XDG_RUNTIME_DIR") {
                env[name] = value
              }
            }
            return spawnTracked(
              s,
              "weston",
              [
                "--backend=headless",
                `--renderer=${renderer}`,
                `--width=${WIDTH}`,
                `--height=${HEIGHT}`,
                "--shell=kiosk",
                "--no-config",
                "--idle-time=0",
                "--",
                "Xwayland",
                s.display,
                "-geometry",
                `${WIDTH}x${HEIGHT}`,
                "-nolisten",
                "tcp",
                "-nolisten",
                "local",
              ],
              { critical: true, prefix: ns.join(ns.holder), env },
            )
          },
          catch: toErr,
        })
        // Xwayland is weston's child, so it is in the same IPC and mount namespaces.
        if (server.pid !== undefined) s.ipc = ns.join(server.pid)
        // Audio boots in parallel with Xwayland: its Pulse server and null sink take about two seconds.
        const audioUp = startAudio(s, ns.x11Dir)
        yield* Effect.tryPromise({ try: () => waitForSocket(s, ns.x11Dir), catch: toErr })
        yield* Effect.try({ try: () => startInput(s), catch: toErr })
        const shared = yield* Effect.try({
          try: () => {
            if (openboxConfig !== null) return openboxConfig
            const dir = mkdtempSync(join(tmpdir(), "kestrel-openbox-"))
            const wallpaperFile = join(dir, "wallpaper.png")
            writeFileSync(wallpaperFile, readFileSync(WALLPAPER))
            openboxConfig = { dir, rc: writeOpenboxConfig(dir), wallpaper: wallpaperFile }
            return openboxConfig
          },
          catch: toErr,
        })
        // The wallpaper is cosmetic: a desktop without it still serves the agent. hsetroot keeps the root pixmap
        // after it exits; it joins the IPC namespace because Imlib2 draws through MIT-SHM.
        yield* Effect.tryPromise({
          try: () => runCommand("hsetroot", ["-solid", "#000000", "-center", shared.wallpaper], s.display, s.ipc),
          catch: toErr,
        }).pipe(
          Effect.flatMap((r) =>
            r.exitCode === 0 ? Effect.void : Effect.fail(new DesktopError({ message: r.stderr.trim() })),
          ),
          Effect.catchAll((e) => Effect.logWarning(`desktop ${s.display}: no wallpaper: ${e.message}`)),
        )
        // A launch only gets the audio socket if it exists by then, and nothing can launch before `ready`.
        yield* Effect.promise(() => Promise.race([audioUp, Bun.sleep(AUDIO_BOOT_WAIT_MS)]))
        yield* Effect.try({
          try: () => {
            spawnTracked(s, "openbox", ["--sm-disable", "--config-file", shared.rc], { critical: false, prefix: s.ipc })
            startEncoder(s, preferredEncoder())
          },
          catch: toErr,
        })
        // The terminal is a convenience: a desktop without one still serves the agent.
        yield* s.terminal(s.display).pipe(
          Effect.flatMap((term) =>
            Effect.try({
              try: () => spawnTracked(s, term.file, term.args, { critical: false, cwd: term.cwd, env: term.env }),
              catch: toErr,
            }),
          ),
          Effect.catchAll((e) => Effect.logWarning(`desktop ${s.display}: no terminal: ${e.message}`)),
        )
        yield* Deferred.await(s.ready).pipe(
          Effect.timeoutFail({
            duration: READY_TIMEOUT_MS,
            onTimeout: () => new DesktopError({ message: "timed out waiting for desktop stream" }),
          }),
        )
        return toStatus(s.taskId, s)
      })

    const awaitReady = (s: Session) =>
      Deferred.await(s.ready).pipe(Effect.zipRight(Effect.sync(() => toStatus(s.taskId, s))))

    const stopTask = (taskId: string) =>
      Effect.gen(function* () {
        const s = sessions.get(taskId)
        if (!s) return
        sessions.delete(taskId)
        s.state = "stopped"
        s.error = null
        detachEncoder(s)
        Deferred.unsafeDone(s.ready, Effect.fail(new DesktopError({ message: "desktop stopped" })))
        publish(s)
        s.sinks.clear()
        s.audio?.stop()
        // Before terminating: a boot still running would spawn children after the snapshot below.
        if (s.boot !== null) yield* Fiber.interrupt(s.boot)
        yield* Effect.promise(() => terminate(s.procs))
        if (s.runtimeDir !== null) rmSync(s.runtimeDir, { recursive: true, force: true })
      })

    const lookup = (taskId: string) =>
      Effect.suspend((): Effect.Effect<Session, DesktopError> => {
        const s = sessions.get(taskId)
        return s
          ? Effect.succeed(s)
          : Effect.fail(new DesktopError({ message: `desktop for task ${taskId} is not running` }))
      })

    const requireLive = (taskId: string) =>
      Effect.flatMap(lookup(taskId), (s) =>
        s.state === "starting" || s.state === "running"
          ? Effect.succeed(s)
          : Effect.fail(new DesktopError({ message: `desktop for task ${taskId} is ${s.state}` })),
      )

    // Kill desktops on process exit even if shutdown hooks never ran.
    process.on("exit", () => {
      for (const s of sessions.values()) {
        for (const p of s.procs) killProcessGroup(p.pid, "SIGKILL")
        if (s.runtimeDir !== null) rmSync(s.runtimeDir, { recursive: true, force: true })
      }
      if (openboxConfig !== null) rmSync(openboxConfig.dir, { recursive: true, force: true })
    })

    const startDesktop = (taskId: string, opts: DesktopStartOptions) =>
      Effect.gen(function* () {
        if (process.platform !== "linux") {
          return yield* Effect.fail(new DesktopError({ message: "the task desktop needs Linux (Xwayland, x11grab)" }))
        }
        if (sessions.get(taskId)?.state === "failed") yield* stopTask(taskId)
        const ready = yield* Deferred.make<void, DesktopError>()
        const claim = yield* Effect.try({
          try: () => {
            const existing = sessions.get(taskId)
            if (existing) return { s: existing, created: false }
            // Synchronous reservation: no yield point between picking and registering the display.
            const num = pickDisplay()
            const s: Session = {
              taskId,
              num,
              display: `:${num}`,
              terminal: opts.terminal,
              ipcNamespace: opts.ipcNamespace,
              quality: DEFAULT_DESKTOP_QUALITY,
              ipc: [],
              runtimeDir: null,
              renderer: null,
              boot: null,
              ready,
              procs: new Set(),
              sinks: new Set(),
              apps: new Map(),
              encoder: null,
              profile: "high",
              input: null,
              state: "starting",
              error: null,
              config: null,
              audio: null,
              audioListener: null,
              audioRestartsLeft: MAX_AUDIO_RESTARTS,
              gop: null,
              gopBytes: 0,
              awaiting: new Set(),
              lingerTimer: null,
              restartBudget: restartBudget(),
              stableTimer: null,
              inputRestartsLeft: MAX_INPUT_RESTARTS,
              stderrTail: "",
            }
            sessions.set(taskId, s)
            // Viewers show the boot state while it comes up; the start call itself only returns once it is running.
            publish(s)
            return { s, created: true }
          },
          catch: toErr,
        })
        if (!claim.created) return yield* awaitReady(claim.s)
        // Forked so the request ending does not abandon the boot, and so a stop can cancel it. A failed boot fails
        // the desktop's ready, which is what the caller waits on.
        claim.s.boot = yield* Effect.forkDaemon(
          boot(claim.s).pipe(
            Effect.tapError((e) => Effect.sync(() => failSession(claim.s, e.message))),
            Effect.ignore,
          ),
        )
        return yield* awaitReady(claim.s)
      })

    /** Viewers that have left. A relaunch skips them, so one that left mid-restart is not attached to the new desktop. */
    const detachedSinks = new WeakSet<DesktopSink>()

    /**
     * Adds a viewer to the task's desktop. The returned effect removes the viewer from whichever desktop the task has
     * when it runs, so a viewer that outlives a renderer restart still leaves cleanly.
     */
    const attachSink = (taskId: string, sink: DesktopSink) =>
      Effect.gen(function* () {
        const s = yield* lookup(taskId)
        // A failed session has no live processes and no display: refuse it instead of parking a viewer that would wait
        // for a stream that will never come.
        if (s.state === "failed") {
          return yield* Effect.fail(new DesktopError({ message: `desktop for task ${taskId} failed` }))
        }
        s.sinks.add(sink)
        sink.onStatus(toStatus(taskId, s))
        cancelLinger(s)
        listenToAudio(s)
        // The viewer's payload decides the stream's profile. A Baseline-only viewer on a live High encoder would be
        // handed its config and GOP and then drop every frame (rtp.ts checks the profile idc), so restart the encoder
        // in the viewer's profile first: this viewer waits for the new keyframe instead.
        applyProfile(s)
        if (s.encoder === null && s.state === "running") {
          // Idle desktop: start the encoder again; this viewer waits for its first keyframe.
          yield* Effect.try({ try: () => startEncoder(s, preferredEncoder()), catch: toErr }).pipe(
            Effect.tapError(() => Effect.sync(() => s.sinks.delete(sink))),
          )
        } else if (s.config !== null && s.gop !== null) {
          // Live encoder with a cached GOP: the config and its keyframe with deltas bring this viewer straight to live.
          sink.onMedia({ kind: "config", config: s.config })
          for (const [i, au] of s.gop.entries()) sink.onMedia({ kind: i === 0 ? "key" : "delta", au })
        } else {
          if (s.config !== null) sink.onMedia({ kind: "config", config: s.config })
          s.awaiting.add(sink)
        }
        // A viewer attached to a live stream is a successful encoder session: the next failure starts from a full budget.
        if (s.state === "running" && s.config !== null) s.restartBudget = viewerServed()
        return Effect.sync(() => {
          // Marked first: a relaunch that is still running must not attach this viewer again.
          detachedSinks.add(sink)
          const current = sessions.get(taskId)
          if (current === undefined) return
          current.sinks.delete(sink)
          current.awaiting.delete(sink)
          // The last Baseline-only viewer leaving lets the remaining viewers have High back.
          applyProfile(current)
          scheduleStop(current)
        })
      })

    /** Stops the task's desktop and returns what a relaunch needs: its launch settings and its viewers. */
    const snapshotAndStop = (taskId: string) =>
      Effect.gen(function* () {
        const s = yield* lookup(taskId)
        const snapshot: Relaunch = { taskId, terminal: s.terminal, ipcNamespace: s.ipcNamespace, sinks: [...s.sinks] }
        yield* stopTask(taskId)
        return snapshot
      })

    // Starts the desktop again on the current renderer and attaches the viewers that are still watching it.
    const relaunch = (snapshot: Relaunch) =>
      Effect.gen(function* () {
        yield* startDesktop(snapshot.taskId, { terminal: snapshot.terminal, ipcNamespace: snapshot.ipcNamespace })
        for (const sink of snapshot.sinks) {
          if (detachedSinks.has(sink)) continue
          yield* attachSink(snapshot.taskId, sink).pipe(
            Effect.catchAll((e) => Effect.logWarning(`desktop viewer not reattached after restart: ${e.message}`)),
          )
        }
      })

    // Whether the desktop renders on a renderer other than the one the GPU state now allows.
    const stale = (s: Session) =>
      (s.state === "starting" || s.state === "running") && s.renderer !== null && s.renderer !== desiredRenderer()
    const liveApps = (s: Session) => [...s.apps.values()].some((app) => app.exit === null)

    // Restarts the task's desktop, attaching the viewers that are still watching it.
    const restart = (taskId: string) =>
      Effect.flatMap(snapshotAndStop(taskId), relaunch).pipe(
        Effect.catchAll((e) => Effect.logWarning(`desktop for task ${taskId} not restarted: ${e.message}`)),
      )

    // Restarts a desktop onto the current renderer once none of its apps is running. A restart stops the desktop's
    // processes, so apps keep the renderer they started on until they exit (the exit hook in launch retries this).
    const restartIdle = (s: Session) =>
      sessions.get(s.taskId) === s && stale(s) && !liveApps(s) ? restart(s.taskId) : Effect.void

    // The GPU arrived: restart each desktop whose renderer is stale and has no running app. A failed desktop that still
    // has viewers is retried, since they are waiting on it; one that fails again stays failed and the others still restart.
    const attachHardware = Effect.gen(function* () {
      hardwareRender = true
      for (const taskId of [...sessions.keys()]) {
        const s = sessions.get(taskId)
        if (s === undefined) continue
        if (s.state === "failed" && s.sinks.size > 0) yield* restart(taskId)
        else yield* restartIdle(s)
      }
    })

    // The GPU is going away: the desktops rendering on it stop now, so the GPU is free, and come back on software
    // rendering in the background. Nothing waits for those boots.
    const releaseHardware = Effect.gen(function* () {
      hardwareRender = false
      const stopped: Relaunch[] = []
      for (const s of [...sessions.values()]) {
        if (s.renderer === "gl" && (s.state === "starting" || s.state === "running")) {
          stopped.push(yield* snapshotAndStop(s.taskId))
        }
      }
      yield* Effect.forkDaemon(
        Effect.forEach(
          stopped,
          (snapshot) =>
            relaunch(snapshot).pipe(
              Effect.catchAll((e) => Effect.logWarning(`desktop for task ${snapshot.taskId} not restarted: ${e.message}`)),
            ),
          { discard: true },
        ),
      )
    })


    return DesktopManager.of({
      start: startDesktop,
      stop: stopTask,
      attachHardwareRender: attachHardware,
      releaseHardwareRender: releaseHardware,

      status: (taskId) => Effect.sync(() => toStatus(taskId, sessions.get(taskId))),

      screenshot: (taskId, crop, scale) =>
        Effect.gen(function* () {
          const s = yield* requireLive(taskId)
          const frame = yield* grabFrame(s)
          const area = crop ?? { x: 0, y: 0, width: frame.width, height: frame.height }
          return encodePng(resample(frame, area, scale ?? 1))
        }),

      grab: (taskId) =>
        Effect.gen(function* () {
          const s = yield* requireLive(taskId)
          return yield* grabFrame(s)
        }),

      cursor: (taskId) =>
        Effect.gen(function* () {
          const s = yield* requireLive(taskId)
          const r = yield* Effect.tryPromise({
            try: () => runCommand("xdotool", ["getmouselocation", "--shell"], s.display, s.ipc),
            catch: toErr,
          })
          const x = /^X=(\d+)$/m.exec(r.stdout.toString())
          const y = /^Y=(\d+)$/m.exec(r.stdout.toString())
          if (r.exitCode !== 0 || x === null || y === null) {
            return yield* Effect.fail(new DesktopError({ message: `cursor position failed: ${r.stderr.trim()}` }))
          }
          return { x: Number(x[1]), y: Number(y[1]) }
        }),

      input: (taskId, event) =>
        Effect.gen(function* () {
          const s = yield* requireLive(taskId)
          const args = xdotoolArgs(event)
          if (args.length === 0) return
          const r = yield* Effect.tryPromise({ try: () => runCommand("xdotool", args, s.display, s.ipc), catch: toErr })
          if (r.exitCode !== 0) {
            return yield* Effect.fail(new DesktopError({ message: `xdotool failed: ${r.stderr.trim()}` }))
          }
        }),

      refreshProfile: (taskId) =>
        lookup(taskId).pipe(
          Effect.flatMap((s) => Effect.sync(() => applyProfile(s))),
          Effect.catchAll(() => Effect.void),
        ),

      streamInput: (taskId, event) =>
        Effect.gen(function* () {
          const s = yield* requireLive(taskId)
          const pipe = s.input
          if (pipe === null) return yield* Effect.fail(new DesktopError({ message: "desktop input is not ready" }))
          const lines = yield* Effect.try({ try: () => xdotoolLines(event), catch: toErr })
          for (const line of lines) queueInput(pipe, line, event._tag === "mouse.move")
        }),

      launch: (taskId, command, proc) =>
        Effect.gen(function* () {
          const s = yield* requireLive(taskId)
          const output = new OutputTail()
          const child = yield* Effect.try({
            try: () =>
              spawnTracked(s, proc.file, proc.args, {
                critical: false,
                cwd: proc.cwd,
                env: proc.env,
                onStdout: (d) => output.push("stdout", d),
                onStderr: (d) => output.push("stderr", d),
              }),
            catch: toErr,
          })
          const app: AppRecord = { id: `app-${s.apps.size + 1}`, command, child, output, exit: null }
          child.once("exit", (code, signal) => {
            app.exit = { code, signal }
            // A renderer change that waited on this app can now restart the desktop.
            Effect.runFork(restartIdle(s))
          })
          s.apps.set(app.id, app)
          return appView(app)
        }),

      processes: (taskId) => Effect.map(lookup(taskId), (s) => [...s.apps.values()].map(appView)),

      kill: (taskId, id) =>
        Effect.gen(function* () {
          const s = yield* lookup(taskId)
          const app = s.apps.get(id)
          if (!app) {
            return yield* Effect.fail(new DesktopError({ message: `no process ${id} on the desktop for task ${taskId}` }))
          }
          if (app.exit === null) {
            yield* Effect.promise(() => terminate([app.child]).then(() => waitExit(app.child, TERM_GRACE_MS)))
          }
          return appView(app)
        }),

      subscribe: (taskId, sink) => attachSink(taskId, sink),

      watchStatus: (listener) =>
        Effect.sync(() => {
          watchers.add(listener)
          return Effect.sync(() => {
            watchers.delete(listener)
          })
        }),

      setQuality: (taskId, quality) =>
        Effect.gen(function* () {
          const s = yield* requireLive(taskId)
          if (s.quality === quality) return toStatus(taskId, s)
          s.quality = quality
          // A live encoder restarts at the new size and rate, and viewers reconfigure from its new config. An idle
          // desktop (no encoder) starts at the new quality on its next subscribe.
          const kind = s.encoder?.kind
          if (kind !== undefined) {
            stopEncoder(s)
            launchEncoder(s, kind)
          }
          publish(s)
          return toStatus(taskId, s)
        }),

      activeCount: () =>
        Effect.sync(() => [...sessions.values()].filter((s) => s.state === "starting" || s.state === "running").length),

      stopAll: () =>
        Effect.gen(function* () {
          for (const taskId of [...sessions.keys()]) yield* stopTask(taskId)
        }),
    })
  }),
)
