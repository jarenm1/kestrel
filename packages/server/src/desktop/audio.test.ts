import { describe, expect, test } from "bun:test"
import { type ChildProcess, spawn } from "node:child_process"
import { EventEmitter } from "node:events"
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { joinTaskDesktop } from "../sandbox/netns"
import { type AudioPacket, createSilenceGate, type DesktopAudio, SILENCE_INTERVAL_MS, SILENT_MAX_BYTES, startDesktopAudio } from "./audio"

const nsenter = Bun.which("nsenter")
const bwrapPath = Bun.which("bwrap")
const ready =
  nsenter !== null && bwrapPath !== null && Bun.which("pulseaudio") !== null && Bun.which("ffmpeg") !== null && Bun.which("pacat") !== null

const FRAME_MS = 10
const CHUNK_BYTES = 1920 // 10 ms of 48 kHz stereo s16le
const LEAD_FRAMES = 50
const SILENCE_FRAMES = 30
const TONE_FRAMES = 10
const BURSTS = 8

/** Spawns a command in the desktop's namespaces (IPC and mount, see netns joinTaskDesktop), with stdin piped. */
const inNamespace = (holder: number, command: string, args: readonly string[], env: Readonly<Record<string, string>>): ChildProcess => {
  const [file, ...rest] = [...joinTaskDesktop(nsenter as string, holder), command, ...args]
  return spawn(file as string, rest, { env, stdio: ["pipe", "ignore", "inherit"] })
}

/** 16-bit stereo 1 kHz sine for one 10 ms chunk, phase-continuous from sample `start`. */
const toneChunk = (start: number): Buffer => {
  const out = Buffer.alloc(CHUNK_BYTES)
  for (let i = 0; i < CHUNK_BYTES / 4; i++) {
    const v = Math.round(0.5 * 32767 * Math.sin((2 * Math.PI * 1000 * (start + i)) / 48000))
    out.writeInt16LE(v, i * 4)
    out.writeInt16LE(v, i * 4 + 2)
  }
  return out
}

// Real-time waits on purpose: the capture chain runs against the platform clock, and fake timers cannot drive a pulse server or ffmpeg.
const sleep = (ms: number): Promise<void> => Bun.sleep(ms).then(() => undefined)

const median = (xs: readonly number[]): number => {
  const s = [...xs].sort((a, b) => a - b)
  return s[Math.floor(s.length / 2)] as number
}

describe("desktop audio (live: holder namespace, pulseaudio, ffmpeg Opus capture)", () => {
  test.skipIf(!ready)("a tone in the desktop becomes audible Opus packets at 10 ms with DTX silence gated, and measured latency", async () => {
    const root = mkdtempSync(join(tmpdir(), "kestrel-audio-test-"))
    const pidFile = join(root, "holder.pid")
    // A holder like the sandbox's bwrap holder (netns.ts): its own user and IPC namespaces, the caller's uid mapped to
    // itself, and a private /tmp/.X11-unix tmpfs. Pulse refuses root, and the pasta holder maps the caller to root.
    const holderProc = spawn(
      bwrapPath as string,
      [
        "--die-with-parent",
        "--unshare-user",
        "--unshare-ipc",
        "--bind",
        "/",
        "/",
        "--tmpfs",
        "/tmp/.X11-unix",
        "--",
        "sh",
        "-c",
        `echo $$ > ${pidFile} && exec sleep 600`,
      ],
      { stdio: "ignore" },
    )
    let producer: ChildProcess | null = null
    let audio: DesktopAudio | null = null
    try {
      const deadline = performance.now() + 5_000
      while (!existsSync(pidFile)) {
        if (performance.now() > deadline) throw new Error("holder did not start")
        await sleep(10)
      }
      const holder = Number(readFileSync(pidFile, "utf8").trim())
      const x11Dir = `/proc/${holder}/root/tmp/.X11-unix`

      const startedAt = performance.now()
      audio = await startDesktopAudio({
        display: ":101",
        x11Dir,
        spawn: (command, args, env) => inNamespace(holder, command, args, env),
        onError: (message) => {
          throw new Error(`audio error: ${message}`)
        },
      })
      const startupMs = performance.now() - startedAt
      expect(audio).not.toBeNull()
      const running = audio as DesktopAudio

      const arrivals: { at: number; audible: boolean }[] = []
      running.subscribe((packet) => {
        arrivals.push({ at: performance.now(), audible: packet.opus.length > SILENT_MAX_BYTES })
      })

      // Wait for the first packet (the monitor capture is live) before playing anything.
      const firstDeadline = performance.now() + 10_000
      while (arrivals.length === 0) {
        if (performance.now() > firstDeadline) throw new Error("no packets within 10 s of start")
        await sleep(10)
      }
      const firstPacketMs = arrivals[0]!.at - startedAt

      // The producer writes one 10 ms chunk per frame at real time and records when each tone burst starts.
      producer = inNamespace(holder, "pacat", ["--playback", "--device=kestrel", "--format=s16le", "--rate=48000", "--channels=2", "--latency-msec=20"], {
        PATH: process.env.PATH ?? "",
        PULSE_SERVER: running.env.PULSE_SERVER as string,
      })
      const pacat = producer
      const schedule: boolean[] = []
      for (let i = 0; i < LEAD_FRAMES; i++) schedule.push(false)
      for (let b = 0; b < BURSTS; b++) {
        for (let i = 0; i < SILENCE_FRAMES; i++) schedule.push(false)
        for (let i = 0; i < TONE_FRAMES; i++) schedule.push(true)
      }
      const toneStarts: number[] = []
      const playStart = performance.now()
      let sample = 0
      for (let f = 0; f < schedule.length; f++) {
        const wait = playStart + f * FRAME_MS - performance.now()
        if (wait > 0) await sleep(wait)
        const isTone = schedule[f] as boolean
        if (isTone && (f === 0 || !schedule[f - 1])) toneStarts.push(performance.now())
        pacat.stdin?.write(isTone ? toneChunk(sample) : Buffer.alloc(CHUNK_BYTES))
        if (isTone) sample += CHUNK_BYTES / 4
      }
      await sleep(500)
      pacat.stdin?.end()
      pacat.kill("SIGKILL")

      expect(toneStarts.length).toBe(BURSTS)
      const latencies = toneStarts.map((t0) => {
        const hit = arrivals.find((a) => a.audible && a.at >= t0)
        return hit ? hit.at - t0 : null
      })
      expect(latencies.every((l) => l !== null)).toBe(true)
      const measured = latencies.filter((l): l is number => l !== null)

      // DTX silence: one packet per SILENCE_INTERVAL_MS passes the gate; every audible packet passes.
      const span = (arrivals[arrivals.length - 1]!.at - arrivals[0]!.at) / 1000
      const audibleArrivals = arrivals.filter((a) => a.audible)
      const silentPerSec = (arrivals.length - audibleArrivals.length) / span
      // Gaps between audible packets within each tone's window: the tone plus 60 ms of pipeline lag.
      const TONE_WINDOW_MS = TONE_FRAMES * FRAME_MS + 60
      const inBurstGaps = toneStarts.flatMap((t0) => {
        const at = audibleArrivals.map((a) => a.at).filter((x) => x >= t0 && x <= t0 + TONE_WINDOW_MS)
        return at.slice(1).map((x, i) => x - at[i]!)
      })
      const inBurstMaxGapMs = Math.max(...inBurstGaps)
      const gaps = arrivals.slice(1).map((a, i) => a.at - arrivals[i]!.at)

      const report = {
        startupMs: Math.round(startupMs),
        firstPacketMs: Math.round(firstPacketMs),
        packets: arrivals.length,
        audiblePackets: audibleArrivals.length,
        silentPerSec: Math.round(silentPerSec * 10) / 10,
        medianGapMs: Math.round(median(gaps) * 100) / 100,
        inBurstMaxGapMs: Math.round(inBurstMaxGapMs * 100) / 100,
        latencyMsPerBurst: measured.map((l) => Math.round(l)),
        latencyMedianMs: Math.round(median(measured)),
        latencyMaxMs: Math.round(Math.max(...measured)),
      }
      console.log(JSON.stringify(report))

      expect(audibleArrivals.length).toBeGreaterThanOrEqual(Math.floor(0.9 * BURSTS * TONE_FRAMES))
      expect(silentPerSec).toBeLessThanOrEqual(3)
      expect(inBurstMaxGapMs).toBeLessThanOrEqual(25)
      expect(measured[0]).toBeLessThanOrEqual(100)
      expect(median(measured.slice(1))).toBeLessThanOrEqual(60)

      const socket = join(x11Dir, "pulse-101")
      running.stop()
      audio = null
      // Real timer: stop() reaps the capture first and pulseaudio on its exit; let those exits run before bun exits.
      await Bun.sleep(300)
      expect(existsSync(socket)).toBe(false)
    } finally {
      producer?.kill("SIGKILL")
      audio?.stop()
      holderProc.kill("SIGKILL")
      rmSync(root, { recursive: true, force: true })
    }
  }, 60_000)
})

describe("desktop audio lifecycle", () => {
  /** A stand-in for the pulse server or ffmpeg: `kill` exits it, as a real one would on SIGTERM. */
  class FakeChild extends EventEmitter {
    exitCode: number | null = null
    signalCode: string | null = null
    constructor(readonly command: string) {
      super()
    }
    kill(): boolean {
      this.exit(0)
      return true
    }
    exit(code: number): void {
      if (this.exitCode !== null) return
      this.exitCode = code
      this.emit("exit", code)
    }
  }

  /** Audio against fake processes: stub executables on PATH, and a "pulse server" that opens its socket on spawn. */
  const started = async () => {
    const root = mkdtempSync(join(tmpdir(), "kestrel-audio-fake-"))
    for (const name of ["pulseaudio", "ffmpeg"]) writeFileSync(join(root, name), "", { mode: 0o755 })
    const path = process.env.PATH
    process.env.PATH = root
    const children: FakeChild[] = []
    const errors: string[] = []
    const audio = await startDesktopAudio({
      display: ":101",
      x11Dir: root,
      spawn: (command) => {
        const child = new FakeChild(command)
        children.push(child)
        if (command.endsWith("pulseaudio")) writeFileSync(join(root, "pulse-101"), "")
        return child as unknown as ChildProcess
      },
      onError: (message) => errors.push(message),
    })
    process.env.PATH = path
    const captures = () => children.filter((c) => c.command.endsWith("ffmpeg"))
    const server = children.find((c) => c.command.endsWith("pulseaudio"))!
    return { root, audio: audio as DesktopAudio, captures, server, errors }
  }

  test("the capture runs only while something is subscribed", async () => {
    const { root, audio, captures, errors } = await started()
    try {
      expect(captures().length).toBe(0)
      const first = audio.subscribe(() => {})
      const second = audio.subscribe(() => {})
      expect(captures().length).toBe(1)
      first()
      expect(captures()[0]!.exitCode).toBeNull()
      second()
      expect(captures()[0]!.exitCode).toBe(0)
      audio.subscribe(() => {})
      expect(captures().length).toBe(2)
      // Stopping the capture on purpose is not a failure.
      expect(errors).toEqual([])
    } finally {
      audio.stop()
      rmSync(root, { recursive: true, force: true })
    }
  })

  test("a capture that dies reports an error and tears the audio down", async () => {
    const { root, audio, captures, server, errors } = await started()
    try {
      audio.subscribe(() => {})
      captures()[0]!.exit(1)
      expect(errors).toEqual(["audio capture exited with code 1"])
      expect(server.exitCode).toBe(0)
      expect(existsSync(join(root, "pulse-101"))).toBe(false)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test("a pulse server that dies reports an error once", async () => {
    const { root, audio, server, errors } = await started()
    try {
      audio.subscribe(() => {})
      server.exit(1)
      expect(errors).toEqual(["pulseaudio exited with code 1"])
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})

describe("silence gate", () => {
  const packet = (bytes: number): AudioPacket => ({ opus: new Uint8Array(bytes), timestamp: 0 })

  test("passes every audible packet", () => {
    const gate = createSilenceGate()
    for (let t = 0; t < 1000; t += 10) expect(gate(packet(160), t)).toBe(true)
  })

  test("passes a silent packet at once, then one per interval; a 3-byte packet is audible", () => {
    const gate = createSilenceGate()
    const passed: number[] = []
    for (let t = 0; t <= 1000; t += 10) if (gate(packet(1), t)) passed.push(t)
    expect(passed).toEqual([0, SILENCE_INTERVAL_MS, 2 * SILENCE_INTERVAL_MS])
    expect(gate(packet(3), 1010)).toBe(true)
  })
})
