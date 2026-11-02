import { expect, test } from "bun:test"
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Effect } from "effect"
import { DesktopManager, DesktopManagerLive } from "./manager"

// Opt in on a Linux machine with the desktop tools installed and a writable /tmp/.X11-unix.
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
          ipcNamespace: Effect.succeed(null),
          terminal: (display) => Effect.succeed({ file: "xterm", args: [], env: { ...process.env, DISPLAY: display } as Record<string, string>, cwd: process.cwd() }),
        })
        expect(status.state).toBe("running")
        expect(status.mime).toContain("avc1")
        expect(Date.now() - started).toBeLessThan(18_000)
        const png = yield* desktop.screenshot("encoder-timeout-test", undefined, 0.25)
        expect(Buffer.from(png.subarray(0, 8)).toString("hex")).toBe("89504e470d0a1a0a")
      }).pipe(Effect.ensuring(desktop.stopAll()))
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
