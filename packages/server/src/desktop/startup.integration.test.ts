import { expect, test } from "bun:test"
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Effect } from "effect"
import type { DesktopStatus } from "@cloudagents/protocol"
import { DesktopError, DesktopManager, DesktopManagerLive, type DesktopSink } from "./manager"
import { desktopNamespace, sandboxSettingsOf, stopTaskHolder } from "../sandbox"

/** The sandbox settings of the task namespace holder (level off: a bwrap holder). */
const holderSettings = sandboxSettingsOf({ sandbox: "off", sandboxPath: null, sandboxSslCertFile: null, systemd: null, sandboxPort: 0 })

// Opt in on a Linux machine with the desktop tools installed and a writable /tmp/.X11-unix.
test.skipIf(process.env.KESTREL_DESKTOP_INTEGRATION !== "1")("an initialized hardware attempt survives the startup deadline", async () => {
  const ffmpeg = Bun.which("ffmpeg")
  const shell = Bun.which("sh")
  if (!ffmpeg || !shell) throw new Error("ffmpeg and sh must be on PATH")
  const dir = mkdtempSync(join(tmpdir(), "kestrel-encoder-ready-"))
  const pidFile = join(dir, "encoder-pid")
  const wrapper = join(dir, "ffmpeg")
  const quote = (s: string) => `'${s.replaceAll("'", "'\\''")}'`
  // Produce a real FLV stream in place of hardware encoding; this does not claim to test a GPU.
  writeFileSync(wrapper, `#!${shell}\ncase " $* " in\n  *" h264_nvenc "*) echo $$ > ${quote(pidFile)}; exec ${quote(ffmpeg)} -hide_banner -loglevel error -re -f lavfi -i testsrc=size=320x240:rate=10 -c:v libx264 -preset ultrafast -tune zerolatency -pix_fmt yuv420p -f flv -flush_packets 1 pipe:1 ;;\nesac\nexec ${quote(ffmpeg)} "$@"\n`)
  chmodSync(wrapper, 0o755)
  const originalPath = process.env.PATH
  process.env.PATH = `${dir}:${originalPath ?? ""}`
  try {
    const program = Effect.gen(function* () {
      const desktop = yield* DesktopManager
      yield* Effect.gen(function* () {
        const status = yield* desktop.start("encoder-ready-test", {
          ipcNamespace: desktopNamespace(holderSettings, "encoder-ready-test").pipe(
            Effect.mapError((e) => new DesktopError({ message: e.message })),
          ),
          terminal: (display) => Effect.succeed({ file: "xterm", args: [], env: { ...process.env, DISPLAY: display } as Record<string, string>, cwd: process.cwd() }),
        })
        expect(status.state).toBe("running")
        const pid = Number(readFileSync(pidFile, "utf8"))
        yield* Effect.sleep("6 seconds")
        expect((yield* desktop.status("encoder-ready-test")).state).toBe("running")
        expect(() => process.kill(pid, 0)).not.toThrow()
      }).pipe(Effect.ensuring(desktop.stopAll()), Effect.ensuring(Effect.sync(() => stopTaskHolder("encoder-ready-test"))))
    })
    await Effect.runPromise(program.pipe(Effect.provide(DesktopManagerLive)))
  } finally {
    process.env.PATH = originalPath
    rmSync(dir, { recursive: true, force: true })
  }
}, 20_000)

test.skipIf(process.env.KESTREL_DESKTOP_INTEGRATION !== "1")("a stalled NVENC process is killed and desktop startup falls back to x264", async () => {
  const ffmpeg = Bun.which("ffmpeg")
  const shell = Bun.which("sh")
  const sleep = Bun.which("sleep")
  if (!ffmpeg || !shell || !sleep) throw new Error("ffmpeg, sh and sleep must be on PATH")
  const dir = mkdtempSync(join(tmpdir(), "kestrel-encoder-test-"))
  const pidFile = join(dir, "stalled-pid")
  const wrapper = join(dir, "ffmpeg")
  const quote = (s: string) => `'${s.replaceAll("'", "'\\''")}'`
  writeFileSync(wrapper, `#!${shell}\ncase " $* " in\n  *" h264_nvenc "*) trap '' TERM; echo $$ > ${quote(pidFile)}; while :; do ${quote(sleep)} 1; done ;;\nesac\nexec ${quote(ffmpeg)} "$@"\n`)
  chmodSync(wrapper, 0o755)
  const originalPath = process.env.PATH
  process.env.PATH = `${dir}:${originalPath ?? ""}`
  try {
    const started = Date.now()
    const program = Effect.gen(function* () {
      const desktop = yield* DesktopManager
      yield* Effect.gen(function* () {
        const status = yield* desktop.start("encoder-timeout-test", {
          ipcNamespace: desktopNamespace(holderSettings, "encoder-timeout-test").pipe(
            Effect.mapError((e) => new DesktopError({ message: e.message })),
          ),
          terminal: (display) => Effect.succeed({ file: "xterm", args: [], env: { ...process.env, DISPLAY: display } as Record<string, string>, cwd: process.cwd() }),
        })
        expect(status.state).toBe("running")
        expect(Date.now() - started).toBeLessThan(18_000)
        const png = yield* desktop.screenshot("encoder-timeout-test", undefined, 0.25)
        expect(Buffer.from(png.subarray(0, 8)).toString("hex")).toBe("89504e470d0a1a0a")
      }).pipe(Effect.ensuring(desktop.stopAll()), Effect.ensuring(Effect.sync(() => stopTaskHolder("encoder-timeout-test"))))
    })
    await Effect.runPromise(program.pipe(Effect.provide(DesktopManagerLive)))
    const pid = Number(readFileSync(pidFile, "utf8"))
    // The helper and encoder share a process group. Give SIGKILL/reaping time to finish.
    let alive = true
    for (let attempt = 0; attempt < 30 && alive; attempt++) {
      await Bun.sleep(100)
      try {
        const stat = readFileSync(`/proc/${pid}/stat`, "utf8")
        alive = !/^\d+ \(.*\) Z /.test(stat)
      } catch { alive = false }
    }
    expect(alive).toBe(false)
  } finally {
    process.env.PATH = originalPath
    rmSync(dir, { recursive: true, force: true })
  }
}, 30_000)

// Real time is the subject here: the encoder's 15 s linger is production timing, so a fake clock would not exercise it.
test.skipIf(process.env.KESTREL_DESKTOP_INTEGRATION !== "1")("a watcher sees streaming turn off when the live encoder lingers out", async () => {
  const taskId = "linger-streaming-test"
  const program = Effect.gen(function* () {
    const desktop = yield* DesktopManager
    const seen: DesktopStatus[] = []
    const unwatch = yield* desktop.watchStatus((status) => seen.push(status))
    yield* Effect.gen(function* () {
      const status = yield* desktop.start(taskId, {
        ipcNamespace: desktopNamespace(holderSettings, taskId).pipe(
          Effect.mapError((e) => new DesktopError({ message: e.message })),
        ),
        terminal: (display) => Effect.succeed({ file: "xterm", args: [], env: { ...process.env, DISPLAY: display } as Record<string, string>, cwd: process.cwd() }),
      })
      expect(status.streaming).toBe(true)
      const deadline = Date.now() + 40_000
      while (!seen.some((s) => s.state === "running" && s.streaming === false)) {
        if (Date.now() > deadline) {
          throw new Error(`streaming never flipped off: ${JSON.stringify(seen.map((s) => [s.state, s.streaming]))}`)
        }
        yield* Effect.sleep(100)
      }
    }).pipe(Effect.ensuring(desktop.stopAll()), Effect.ensuring(Effect.sync(() => stopTaskHolder(taskId))))
    yield* unwatch
  })
  await Effect.runPromise(program.pipe(Effect.provide(DesktopManagerLive)))
}, 45_000)

test.skipIf(process.env.KESTREL_DESKTOP_INTEGRATION !== "1")("a watcher sees streaming turn off when a viewerless encoder exits", async () => {
  const ffmpeg = Bun.which("ffmpeg")
  const shell = Bun.which("sh")
  if (!ffmpeg || !shell) throw new Error("ffmpeg and sh must be on PATH")
  const dir = mkdtempSync(join(tmpdir(), "kestrel-encoder-exit-"))
  const pidFile = join(dir, "encoder-pid")
  const wrapper = join(dir, "ffmpeg")
  const quote = (s: string) => `'${s.replaceAll("'", "'\\''")}'`
  // Record the live encoder's pid so the test can kill it: NVENC where it works, libx264 otherwise (a failed NVENC
  // attempt is overwritten by the libx264 fallback). The wrapper `exec`s the real ffmpeg, so the pid is the encoder's.
  writeFileSync(wrapper, `#!${shell}\ncase " $* " in\n  *" libx264 "*|*" h264_nvenc "*) echo $$ > ${quote(pidFile)} ;;\nesac\nexec ${quote(ffmpeg)} "$@"\n`)
  chmodSync(wrapper, 0o755)
  const originalPath = process.env.PATH
  process.env.PATH = `${dir}:${originalPath ?? ""}`
  const taskId = "encoder-exit-streaming-test"
  try {
    const program = Effect.gen(function* () {
      const desktop = yield* DesktopManager
      const seen: DesktopStatus[] = []
      const unwatch = yield* desktop.watchStatus((status) => seen.push(status))
      yield* Effect.gen(function* () {
        const status = yield* desktop.start(taskId, {
          ipcNamespace: desktopNamespace(holderSettings, taskId).pipe(
            Effect.mapError((e) => new DesktopError({ message: e.message })),
          ),
          terminal: (display) => Effect.succeed({ file: "xterm", args: [], env: { ...process.env, DISPLAY: display } as Record<string, string>, cwd: process.cwd() }),
        })
        expect(status.streaming).toBe(true)
        // The encoder dies inside the 15 s linger, with no viewer attached: nothing restarts it.
        const pid = Number(readFileSync(pidFile, "utf8"))
        seen.length = 0
        process.kill(pid, "SIGKILL")
        const deadline = Date.now() + 5_000
        while (!seen.some((s) => s.state === "running" && s.streaming === false)) {
          if (Date.now() > deadline) {
            throw new Error(`streaming stayed on after the encoder exited: ${JSON.stringify(seen.map((s) => [s.state, s.streaming]))}`)
          }
          yield* Effect.sleep(100)
        }
        expect((yield* desktop.status(taskId)).streaming).toBe(false)
      }).pipe(Effect.ensuring(desktop.stopAll()), Effect.ensuring(Effect.sync(() => stopTaskHolder(taskId))))
      yield* unwatch
    })
    await Effect.runPromise(program.pipe(Effect.provide(DesktopManagerLive)))
  } finally {
    process.env.PATH = originalPath
    rmSync(dir, { recursive: true, force: true })
  }
}, 30_000)

test.skipIf(process.env.KESTREL_DESKTOP_INTEGRATION !== "1")("a failed session refuses a viewer instead of parking it", async () => {
  const taskId = "failed-attach-test"
  const originalPath = process.env.PATH
  const restore = Effect.sync(() => {
    process.env.PATH = originalPath
    stopTaskHolder(taskId)
  })
  const program = Effect.gen(function* () {
    const desktop = yield* DesktopManager
    // No desktop tools on PATH: the boot fails and the session stays in the map as `failed`.
    process.env.PATH = ""
    const started = yield* Effect.either(
      desktop.start(taskId, {
        ipcNamespace: desktopNamespace(holderSettings, taskId).pipe(
          Effect.mapError((e) => new DesktopError({ message: e.message })),
        ),
        terminal: (display) => Effect.succeed({ file: "xterm", args: [], env: { ...process.env, DISPLAY: display } as Record<string, string>, cwd: process.cwd() }),
      }),
    )
    process.env.PATH = originalPath
    expect(started._tag).toBe("Left")

    const status = yield* desktop.status(taskId)
    expect(status.state).toBe("failed")
    expect(status.display).toBeNull()
    expect(status.streaming).toBe(false)

    const sink: DesktopSink = { baselineOnly: false, onStatus: () => {}, onMedia: () => {}, onAudio: () => {} }
    const subscribed = yield* Effect.either(desktop.subscribe(taskId, sink))
    expect(subscribed._tag).toBe("Left")
  }).pipe(Effect.ensuring(restore))
  await Effect.runPromise(program.pipe(Effect.provide(DesktopManagerLive)))
}, 30_000)
