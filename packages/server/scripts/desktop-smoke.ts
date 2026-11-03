// Run with the desktop dependencies on PATH: bun packages/server/scripts/desktop-smoke.ts
// Starts a real isolated display, without connecting to a box, control plane or agent harness.
import assert from "node:assert/strict"
import { Effect } from "effect"
import { DesktopError, DesktopManager, DesktopManagerLive } from "../src/desktop"
import { desktopNamespace, sandboxSettingsOf, stopTaskHolder } from "../src/sandbox"

const holderSettings = sandboxSettingsOf({ sandbox: "off", sandboxPath: null, sandboxSslCertFile: null, systemd: null, sandboxPort: 0 })

const probe = Effect.gen(function* () {
  const desktop = yield* DesktopManager
  const taskId = `desktop-smoke-${process.pid}`
  yield* Effect.gen(function* () {
    const status = yield* desktop.start(taskId, {
      ipcNamespace: desktopNamespace(holderSettings, taskId).pipe(
        Effect.mapError((e) => new DesktopError({ message: e.message })),
      ),
      terminal: (display) => Effect.succeed({
        file: "xterm",
        args: ["-geometry", "60x15+20+20"],
        env: { ...process.env, DISPLAY: display } as Record<string, string>,
        cwd: process.cwd(),
      }),
    })
    assert.equal(status.state, "running")
    assert.ok(status.mime?.includes("avc1"), "desktop should publish H.264")
    const kinds = new Set<string>()
    const unsubscribe = yield* desktop.subscribe(taskId, {
      onStatus: () => {},
      onMedia: (_bytes, kind) => kinds.add(kind),
    })
    yield* Effect.gen(function* () {
      const screenshot = yield* desktop.screenshot(taskId, undefined, 0.25)
      assert.equal(Buffer.from(screenshot.subarray(0, 8)).toString("hex"), "89504e470d0a1a0a")
      yield* desktop.input(taskId, { _tag: "mouse.move", x: 123 / 2560, y: 234 / 1440 })
      const cursor = yield* desktop.cursor(taskId)
      assert.deepEqual(cursor, { x: 123, y: 234 })
      assert.ok(kinds.has("init"), "viewer should receive the initialization segment")
      assert.ok(kinds.has("key"), "viewer should receive a keyframe")
      console.log(`PASS ${status.display}: H.264 stream, PNG screenshot and pointer input`)
    }).pipe(Effect.ensuring(unsubscribe))
  }).pipe(Effect.ensuring(desktop.stopAll()), Effect.ensuring(Effect.sync(() => stopTaskHolder(taskId))))
  assert.equal(yield* desktop.activeCount(), 0)
})

await Effect.runPromise(probe.pipe(Effect.provide(DesktopManagerLive)))
