import type { ChildProcess } from "node:child_process"
import { createSocket, type Socket } from "node:dgram"
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { findExecutable, pulseSocket } from "../sandbox"

/** One Opus packet: 10 ms of 48 kHz stereo audio, low-delay CELT. */
export interface AudioPacket {
  readonly opus: Uint8Array
  /** RTP timestamp in 48 kHz units: random base, +480 per 10 ms frame. A packet the silence gate dropped leaves a jump. */
  readonly timestamp: number
}

export interface DesktopAudio {
  /** Env that points apps in the desktop at its audio server (for launches that do not go through the sandbox). */
  readonly env: Readonly<Record<string, string>>
  /** The capture runs only while something is subscribed: encoding Opus for nobody costs CPU on every idle desktop. */
  subscribe(listener: (packet: AudioPacket) => void): () => void
  stop(): void
}

export interface DesktopAudioOptions {
  /** The desktop's X display, ":101". The audio socket is named after its number. */
  readonly display: string
  /** The holder's X socket directory as the server sees it (sandbox x11Dir). */
  readonly x11Dir: string
  /** Spawns a command inside the desktop's namespaces (IPC and mount, see netns joinTaskDesktop). */
  readonly spawn: (command: string, args: readonly string[], env: Readonly<Record<string, string>>) => ChildProcess
  /** Reports runtime failures after startup. Startup failures resolve null and are reported here too. */
  readonly onError: (message: string) => void
}

export const AUDIO_SINK = "kestrel"
const SILENT_SOURCE = "kestrel-silence"
const READY_TIMEOUT_MS = 10_000
const RTP_PAYLOAD_TYPE = 111

const isRunning = (child: ChildProcess): boolean => child.exitCode === null && child.signalCode === null

/** Parses one RTP packet carrying Opus (no padding in ffmpeg's output, but handled). Null when malformed. */
export const parseRtp = (msg: Uint8Array): AudioPacket | null => {
  if (msg.length < 12) return null
  const first = msg[0] ?? 0
  if (first >> 6 !== 2) return null
  const view = new DataView(msg.buffer, msg.byteOffset, msg.byteLength)
  let offset = 12 + (first & 0x0f) * 4
  if (first & 0x10) {
    if (msg.length < offset + 4) return null
    offset += 4 + view.getUint16(offset + 2) * 4
  }
  let end = msg.length
  if (first & 0x20) end -= msg[msg.length - 1] ?? 0
  if (offset > end) return null
  return { opus: msg.subarray(offset, end), timestamp: view.getUint32(4) }
}

/** libopus in DTX sends a 1-byte packet per silent 10 ms frame; audible 128 kb/s frames are far larger. */
export const SILENT_MAX_BYTES = 2
/** Interval between the silent packets that pass the gate: enough for the receiver to keep its timing and sequence. */
export const SILENCE_INTERVAL_MS = 400

/**
 * Drops DTX silence to one packet per SILENCE_INTERVAL_MS. Audible packets always pass. `nowMs` is a monotonic clock in
 * milliseconds, read once per packet.
 */
export const createSilenceGate = (intervalMs = SILENCE_INTERVAL_MS): ((packet: AudioPacket, nowMs: number) => boolean) => {
  let lastSilentAt = Number.NEGATIVE_INFINITY
  return (packet, nowMs) => {
    if (packet.opus.length > SILENT_MAX_BYTES) return true
    if (nowMs - lastSilentAt < intervalMs) return false
    lastSilentAt = nowMs
    return true
  }
}

/** Starts the desktop's PulseAudio server and null sink. Null when audio is unavailable. The capture follows `subscribe`. */
export const startDesktopAudio = async (opts: DesktopAudioOptions): Promise<DesktopAudio | null> => {
  const n = /^:(\d+)$/.exec(opts.display)?.[1]
  if (n === undefined) return null
  const pulseBin = findExecutable("pulseaudio")
  const ffmpegBin = findExecutable("ffmpeg")
  if (pulseBin === null || ffmpegBin === null) return null

  const socket = pulseSocket(Number(n))
  const socketName = socket.slice(socket.lastIndexOf("/") + 1)
  const home = mkdtempSync(join(tmpdir(), "kestrel-audio-"))
  mkdirSync(join(home, "pulse"))
  writeFileSync(join(home, "pulse", "daemon.conf"), "system-instance = no\nflat-volumes = no\n")
  const env = {
    PATH: process.env.PATH ?? "/usr/bin:/bin",
    HOME: home,
    XDG_CONFIG_HOME: home,
    XDG_RUNTIME_DIR: home,
  }
  const pulseEnv = { PULSE_SERVER: `unix:${socket}` }

  let server: ChildProcess | null = null
  let capture: ChildProcess | null = null
  let stopped = false
  let rtp: Socket | null = null
  const listeners = new Set<(packet: AudioPacket) => void>()

  const stopCapture = (): ChildProcess | null => {
    const running = capture
    capture = null
    if (running === null || !isRunning(running)) return null
    running.kill("SIGTERM")
    return running
  }

  const teardown = (): void => {
    stopped = true
    rtp?.close()
    rtp = null
    rmSync(join(opts.x11Dir, socketName), { force: true })
    // The capture stops first: ffmpeg logs a demux error when its pulse source vanishes while it still runs.
    const stopServer = (): void => {
      if (server !== null && isRunning(server)) server.kill("SIGTERM")
      rmSync(home, { recursive: true, force: true })
    }
    const ending = stopCapture()
    if (ending === null) stopServer()
    else ending.once("exit", stopServer)
  }

  const fail = (message: string): void => {
    if (stopped) return
    teardown()
    opts.onError(message)
  }

  const pulse = opts.spawn(
    pulseBin,
    [
      "-n",
      "--daemonize=no",
      "--system=false",
      "--exit-idle-time=-1",
      "--disallow-exit",
      "--disallow-module-loading",
      "--no-cpu-limit=yes",
      "--realtime=no",
      "--high-priority=no",
      "--use-pid-file=no",
      "--log-target=stderr",
      // An idle null sink stops rendering, so its monitor carries nothing; this silent loopback keeps it running.
      `--load=module-null-sink sink_name=${AUDIO_SINK} rate=48000 channels=2 format=s16le`,
      `--load=module-null-source source_name=${SILENT_SOURCE} rate=48000 channels=2 format=s16le`,
      `--load=module-loopback source=${SILENT_SOURCE} sink=${AUDIO_SINK} latency_msec=20`,
      `--load=module-native-protocol-unix socket=${socket} auth-anonymous=1`,
    ],
    env,
  )
  server = pulse
  pulse.once("exit", (code) => fail(`pulseaudio exited with code ${code}`))

  const ready = await waitForSocket(opts.x11Dir, socketName, READY_TIMEOUT_MS)
  if (!ready || stopped) {
    fail(`pulseaudio did not open ${socket} within ${READY_TIMEOUT_MS} ms`)
    return null
  }

  const sock = createSocket("udp4")
  rtp = sock
  const bound = Promise.withResolvers<void>()
  sock.once("error", bound.reject)
  sock.bind(0, "127.0.0.1", () => bound.resolve())
  await bound.promise
  const port = sock.address().port

  const startCapture = (): void => {
    const child = opts.spawn(
      ffmpegBin,
      [
        "-hide_banner",
        "-loglevel",
        "error",
        // The pulse demuxer reads 5 ms fragments; a pipe would make ffmpeg read 85 ms blocks, arriving clumped.
        "-f",
        "pulse",
        "-fragment_size",
        "960",
        "-i",
        `${AUDIO_SINK}.monitor`,
        "-c:a",
        "libopus",
        "-application",
        "lowdelay",
        "-frame_duration",
        "10",
        "-dtx",
        "1",
        "-b:a",
        "128k",
        "-flush_packets",
        "1",
        "-f",
        "rtp",
        "-payload_type",
        String(RTP_PAYLOAD_TYPE),
        `rtp://127.0.0.1:${port}`,
      ],
      { ...env, ...pulseEnv },
    )
    capture = child
    child.once("exit", (code) => {
      if (capture === child) fail(`audio capture exited with code ${code}`)
    })
  }

  const gate = createSilenceGate()
  sock.on("message", (msg) => {
    const packet = parseRtp(msg)
    if (packet === null || !gate(packet, performance.now())) return
    for (const listener of listeners) listener(packet)
  })

  return {
    env: pulseEnv,
    subscribe(listener) {
      listeners.add(listener)
      if (capture === null && !stopped) {
        try {
          startCapture()
        } catch (e) {
          fail(`audio capture did not start: ${e instanceof Error ? e.message : String(e)}`)
        }
      }
      return () => {
        listeners.delete(listener)
        if (listeners.size === 0) stopCapture()
      }
    },
    stop() {
      if (!stopped) teardown()
    },
  }
}

const waitForSocket = async (dir: string, name: string, timeoutMs: number): Promise<boolean> => {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (existsSync(join(dir, name))) return true
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
  return false
}
