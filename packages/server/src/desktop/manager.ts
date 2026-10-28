import { spawn, type ChildProcess } from "node:child_process"
import { existsSync } from "node:fs"
import { StringDecoder } from "node:string_decoder"
import { Context, Data, Deferred, Effect, Layer } from "effect"
import type { DesktopInput, DesktopState, DesktopStatus } from "@cloudagents/protocol"
import { NEW_PROCESS_GROUP, killProcessGroup, ownGroup } from "../process"
import { avcCodecString, Mp4Splitter, type Mp4Piece } from "./fmp4"
import { encodePng, resample, type RgbFrame } from "./frames"

export class DesktopError extends Data.TaggedError("DesktopError")<{ readonly message: string }> {}

export interface DesktopSink {
  onStatus(s: DesktopStatus): void
  onMedia(chunk: Uint8Array): void
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

export interface DesktopStartOptions {
  /** Builds the terminal opened on a fresh desktop, given its X display (e.g. ":101"). */
  readonly terminal: (display: string) => Effect.Effect<ProcessSpec, DesktopError>
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
    readonly stopAll: () => Effect.Effect<void>
  }
>() {}

const WIDTH = 1920
const HEIGHT = 1080
const FPS = 60
const FIRST_DISPLAY = 101
const LAST_DISPLAY = 199
const X_SOCKET_TIMEOUT_MS = 10_000
const READY_TIMEOUT_MS = 20_000
const TERM_GRACE_MS = 2_000
const COMMAND_TIMEOUT_MS = 15_000
/** Output kept per launched app; older text is dropped. */
const OUTPUT_TAIL_CHARS = 32 * 1024
/**
 * Frames per keyframe: 4 s at 60 fps. On a static desktop the IDR frames are nearly all of the bitrate
 * (NVENC: ~600 KB IDR vs ~0.1 KB P-frame at 1080p), so GOP 240 halves idle bandwidth against GOP 120.
 * Late joiners don't wait for it: they get the cached GOP.
 */
const GOP = 240
/** Cap on the cached current GOP replayed to late joiners. Past it, joiners wait for the next keyframe. */
const GOP_CACHE_MAX_BYTES = 8 * 1024 * 1024
/** How long a live encoder keeps running after its last viewer leaves. */
const LINGER_MS = 15_000
/** Unexpected encoder exits tolerated while viewers are attached before the desktop fails. */
const MAX_ENCODER_RESTARTS = 3
/** Unexpected xdotool helper exits tolerated per desktop before it fails. */
const MAX_INPUT_RESTARTS = 3
/** NVENC is skipped for this long after it reports a busy GPU (session limit). */
const NVENC_BUSY_BACKOFF_MS = 30_000
/** Process-wide: NVENC that fails to start for a non-busy reason is not tried again. */
let nvencDisabled = false
let nvencBusyUntil = 0

type EncoderKind = "nvenc" | "x264"

/** One ffmpeg encoder process and the splitter for its stdout. */
interface Encoder {
  readonly kind: EncoderKind
  readonly splitter: Mp4Splitter
  /** Set right after spawn. */
  child: ChildProcess | null
  /** The init segment arrived: later exits are restarts, not boot failures. */
  initialized: boolean
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

interface Session {
  readonly taskId: string
  readonly num: number
  readonly display: string
  readonly terminal: DesktopStartOptions["terminal"]
  /** Completes when the init segment has been parsed (running) or fails. */
  readonly ready: Deferred.Deferred<void, DesktopError>
  /** Live child processes; each is a process-group leader (detached). */
  readonly procs: Set<ChildProcess>
  readonly sinks: Set<DesktopSink>
  /** Apps started with launch(), in launch order. */
  readonly apps: Map<string, AppRecord>
  /** Live encoder, or null while idle (no viewers past the linger) or after failure. */
  encoder: Encoder | null
  state: DesktopState
  error: string | null
  mime: string | null
  init: Uint8Array | null
  /** Fragments of the current GOP, keyframe first; null when not cached (restarting, or over the cap). */
  gop: Uint8Array[] | null
  gopBytes: number
  /** Sinks that must not get delta fragments until the next keyframe. */
  awaiting: Set<DesktopSink>
  lingerTimer: NodeJS.Timeout | null
  restartsLeft: number
  stderrTail: string
  /** The long-lived xdotool helper; null until boot starts it and while it is being restarted. */
  input: InputPipe | null
  inputRestartsLeft: number
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

/** One click per 50 units of wheel delta, between 1 and 10 clicks. */
const wheelClicks = (delta: number) => Math.min(10, Math.max(1, Math.round(Math.abs(delta) / 50)))

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
      const args: string[] = []
      if (e.dy !== 0) args.push("click", "--repeat", String(wheelClicks(e.dy)), e.dy > 0 ? "5" : "4")
      if (e.dx !== 0) args.push("click", "--repeat", String(wheelClicks(e.dx)), e.dx > 0 ? "7" : "6")
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
 * Encoder arguments by kind. Both produce High-profile 4:2:0 H.264 with a GOP of GOP frames and no B-frames.
 * NVENC takes x11grab's bgr0 frames directly and converts to 4:2:0 on the GPU (adding `-pix_fmt yuv420p`
 * moves that conversion to the CPU: ~50% of a core at 1080p60). `-delay 0 -zerolatency 1` stop NVENC from
 * holding output frames: screen change to fragment on stdout drops from 66 ms to 33 ms. p4/ll costs the same
 * CPU and latency as p1/ull at ~25-30% less bitrate on text and scrolling.
 */
const ENCODER_ARGS: Record<EncoderKind, readonly string[]> = {
  nvenc: [
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
    "-profile:v", "high",
    "-g", String(GOP),
    "-forced-idr", "1",
  ],
  x264: [
    "-c:v", "libx264",
    "-preset", "veryfast",
    "-tune", "zerolatency",
    "-profile:v", "high",
    "-crf", "23",
    "-pix_fmt", "yuv420p",
    "-g", String(GOP),
    "-sc_threshold", "0",
  ],
}

const ffmpegArgs = (display: string, kind: EncoderKind): string[] => [
  "-hide_banner",
  "-loglevel",
  "error",
  // Grab frames as they are produced: no input buffering, no stream probing.
  "-fflags",
  "nobuffer",
  "-probesize",
  "32",
  "-f",
  "x11grab",
  "-framerate",
  String(FPS),
  "-video_size",
  `${WIDTH}x${HEIGHT}`,
  "-i",
  display,
  ...ENCODER_ARGS[kind],
  "-r",
  String(FPS),
  "-an",
  "-f",
  "mp4",
  // One moof+mdat per frame, so each frame reaches the viewer as soon as it is encoded.
  "-movflags",
  "empty_moov+default_base_moof+frag_every_frame",
  "-flush_packets",
  "1",
  "pipe:1",
]

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

const waitForSocket = async (s: Session) => {
  const socket = `/tmp/.X11-unix/X${s.num}`
  const deadline = Date.now() + X_SOCKET_TIMEOUT_MS
  while (!existsSync(socket)) {
    if (s.state !== "starting") throw new Error(s.error ?? "Xvfb stopped before accepting connections")
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${socket}`)
    const { promise, resolve } = Promise.withResolvers<void>()
    setTimeout(resolve, 50)
    await promise
  }
}

const runCommand = (command: string, args: readonly string[], display: string) => {
  const { promise, resolve, reject } = Promise.withResolvers<{ exitCode: number; stdout: Buffer; stderr: string }>()
  const child = spawn(command, args, {
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
    const watchers = new Set<(s: DesktopStatus) => void>()

    const toStatus = (taskId: string, s: Session | undefined): DesktopStatus => {
      const live = s !== undefined && s.state !== "stopped"
      return {
        taskId,
        state: s?.state ?? "stopped",
        display: live ? s.display : null,
        width: WIDTH,
        height: HEIGHT,
        fps: FPS,
        mime: live ? s.mime : null,
        error: live ? s.error : null,
      }
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
      s.encoder = null
      s.init = null
      s.gop = null
      s.gopBytes = 0
      s.awaiting.clear()
    }

    const failSession = (s: Session, message: string) => {
      if (s.state !== "starting" && s.state !== "running") return
      const tail = s.stderrTail.trim().slice(-500)
      const full = tail ? `${message}: ${tail}` : message
      s.state = "failed"
      s.error = full
      detachEncoder(s)
      Deferred.unsafeDone(s.ready, Effect.fail(new DesktopError({ message: full })))
      publish(s)
      void terminate(s.procs)
    }

    /** Stops the encoder on purpose (no viewers left): not a failure, so nothing restarts it. */
    const stopEncoder = (s: Session) => {
      const enc = s.encoder
      if (enc === null) return
      detachEncoder(s)
      if (enc.child) void terminate([enc.child])
    }

    /** Starts the linger countdown once the last viewer has left a live encoder. */
    const scheduleStop = (s: Session) => {
      if (s.sinks.size > 0 || s.encoder === null || s.lingerTimer !== null) return
      s.lingerTimer = setTimeout(() => {
        s.lingerTimer = null
        if (s.sinks.size === 0) stopEncoder(s)
      }, LINGER_MS)
    }

    const onEncoderBytes = (s: Session, enc: Encoder, data: Buffer) => {
      if (s.encoder !== enc || (s.state !== "starting" && s.state !== "running")) return
      let pieces: Mp4Piece[]
      try {
        pieces = enc.splitter.push(data)
      } catch (e) {
        failSession(s, toErr(e).message)
        return
      }
      for (const piece of pieces) {
        if (piece.kind === "init") {
          const codec = avcCodecString(piece.bytes)
          if (codec === null) {
            failSession(s, "could not read H.264 codec from init segment")
            return
          }
          enc.initialized = true
          s.restartsLeft = MAX_ENCODER_RESTARTS
          s.init = piece.bytes
          s.mime = `video/mp4; codecs="${codec}"`
          s.state = "running"
          Deferred.unsafeDone(s.ready, Effect.void)
          for (const sink of s.sinks) sink.onMedia(piece.bytes)
          publish(s)
          scheduleStop(s)
          continue
        }
        if (piece.keyframe) {
          s.gop = [piece.bytes]
          s.gopBytes = piece.bytes.length
          s.awaiting.clear()
        } else if (s.gop !== null) {
          s.gop.push(piece.bytes)
          s.gopBytes += piece.bytes.length
          if (s.gopBytes > GOP_CACHE_MAX_BYTES) {
            s.gop = null
            s.gopBytes = 0
          }
        }
        for (const sink of s.sinks) if (piece.keyframe || !s.awaiting.has(sink)) sink.onMedia(piece.bytes)
      }
    }

    /** NVENC when it is usable, libx264 otherwise. */
    const preferredEncoder = (): EncoderKind => (!nvencDisabled && Date.now() >= nvencBusyUntil ? "nvenc" : "x264")

    /** Starts an encoder; throws if the process cannot be spawned. Viewers wait for its keyframe. */
    const startEncoder = (s: Session, kind: EncoderKind) => {
      const enc: Encoder = { kind, splitter: new Mp4Splitter(), child: null, initialized: false, stderr: "" }
      s.init = null
      s.gop = null
      s.gopBytes = 0
      s.awaiting = new Set(s.sinks)
      enc.child = spawnTracked(s, "ffmpeg", ffmpegArgs(s.display, kind), {
        critical: false,
        onStdout: (d) => onEncoderBytes(s, enc, d),
        onStderr: (d) => {
          enc.stderr = (enc.stderr + d.toString()).slice(-2000)
        },
        onExit: (reason) => onEncoderExit(s, enc, reason),
      })
      s.encoder = enc
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
      if (s.restartsLeft === 0) {
        failSession(s, `${why}; gave up after ${MAX_ENCODER_RESTARTS} restarts`)
        return
      }
      s.restartsLeft--
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
        cwd?: string
        env?: Readonly<Record<string, string>>
        onStdout?: (d: Buffer) => void
        onStderr?: (d: Buffer) => void
        /** Replaces the default handling of the process ending (a restartable encoder). */
        onExit?: (reason: string) => void
      },
    ) => {
      const child = ownGroup(
        spawn(command, args, {
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
        yield* Effect.try({
          // Only the /tmp/.X11-unix/X<n> file socket: sandboxes share the host network namespace, so the
          // abstract socket (`local`) would let every task's agent reach every display.
          try: () =>
            spawnTracked(
              s,
              "Xvfb",
              [s.display, "-screen", "0", `${WIDTH}x${HEIGHT}x24`, "-nolisten", "tcp", "-nolisten", "local"],
              { critical: true },
            ),
          catch: toErr,
        })
        yield* Effect.tryPromise({ try: () => waitForSocket(s), catch: toErr })
        yield* Effect.try({ try: () => startInput(s), catch: toErr })
        yield* Effect.try({
          try: () => {
            spawnTracked(s, "openbox", ["--sm-disable"], { critical: false })
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
        yield* Effect.promise(() => terminate(s.procs))
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
      for (const s of sessions.values()) for (const p of s.procs) killProcessGroup(p.pid, "SIGKILL")
    })

    return DesktopManager.of({
      start: (taskId, opts) =>
        Effect.gen(function* () {
          if (process.platform !== "linux") {
            return yield* Effect.fail(new DesktopError({ message: "the task desktop needs Linux (Xvfb, x11grab)" }))
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
                ready,
                procs: new Set(),
                sinks: new Set(),
                apps: new Map(),
                encoder: null,
                input: null,
                state: "starting",
                error: null,
                mime: null,
                init: null,
                gop: null,
                gopBytes: 0,
                awaiting: new Set(),
                lingerTimer: null,
                restartsLeft: MAX_ENCODER_RESTARTS,
                inputRestartsLeft: MAX_INPUT_RESTARTS,
                stderrTail: "",
              }
              sessions.set(taskId, s)
              return { s, created: true }
            },
            catch: toErr,
          })
          if (!claim.created) return yield* awaitReady(claim.s)
          return yield* boot(claim.s).pipe(
            Effect.tapError((e) => Effect.sync(() => failSession(claim.s, e.message))),
          )
        }),

      stop: stopTask,

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
            try: () => runCommand("xdotool", ["getmouselocation", "--shell"], s.display),
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
          const r = yield* Effect.tryPromise({ try: () => runCommand("xdotool", args, s.display), catch: toErr })
          if (r.exitCode !== 0) {
            return yield* Effect.fail(new DesktopError({ message: `xdotool failed: ${r.stderr.trim()}` }))
          }
        }),

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

      subscribe: (taskId, sink) =>
        Effect.gen(function* () {
          const s = yield* lookup(taskId)
          s.sinks.add(sink)
          sink.onStatus(toStatus(taskId, s))
          cancelLinger(s)
          if (s.encoder === null && s.state === "running") {
            // Idle desktop: start the encoder again; this viewer waits for its first keyframe.
            yield* Effect.try({ try: () => startEncoder(s, preferredEncoder()), catch: toErr }).pipe(
              Effect.tapError(() => Effect.sync(() => s.sinks.delete(sink))),
            )
          } else if (s.init !== null && s.gop !== null) {
            // Live encoder with a cached GOP: the keyframe and its deltas bring this viewer straight to live.
            sink.onMedia(s.init)
            for (const fragment of s.gop) sink.onMedia(fragment)
          } else {
            if (s.init !== null) sink.onMedia(s.init)
            s.awaiting.add(sink)
          }
          return Effect.sync(() => {
            s.sinks.delete(sink)
            s.awaiting.delete(sink)
            scheduleStop(s)
          })
        }),

      watchStatus: (listener) =>
        Effect.sync(() => {
          watchers.add(listener)
          return Effect.sync(() => {
            watchers.delete(listener)
          })
        }),

      stopAll: () =>
        Effect.gen(function* () {
          for (const taskId of [...sessions.keys()]) yield* stopTask(taskId)
        }),
    })
  }),
)
