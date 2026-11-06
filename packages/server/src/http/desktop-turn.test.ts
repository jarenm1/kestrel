import { expect, test } from "bun:test"
import { Effect, Fiber, Layer } from "effect"
import { type DesktopStatus } from "@cloudagents/protocol"
import { Config, type ServerConfig } from "../config"
import { CoreService } from "../core/service"
import { DesktopManager, type DesktopSink } from "../desktop"
import { ActivityTrackerLive } from "../platform/tracker"
import { serveStream, type StreamSocket, type WsServices } from "./streams"

const running: DesktopStatus = {
  taskId: "task", state: "running", display: ":1", width: 1280, height: 720,
  fps: 30, quality: "1080p30", error: null,
}

test("slow TURN configuration precedes queued status changes and cannot write after disconnect", async () => {
  const requested = Promise.withResolvers<void>()
  const release = Promise.withResolvers<void>()
  const provider = Bun.serve({
    port: 0,
    async fetch() {
      requested.resolve()
      await release.promise
      return Response.json({
        iceServers: [{ urls: ["turns:turn.example:443?transport=tcp"], username: "viewer", credential: "temporary" }],
        expiresAt: Date.now() + 3_600_000,
      })
    },
  })
  const config = {
    direct: { controlUrl: provider.url.href, boxId: "box", boxSecret: "secret", managed: true }, relay: null,
    webrtc: { iceServers: [], turn: null, policy: "all", portRange: null, hostAddresses: [], denyPrivate: true },
  } as unknown as ServerConfig
  const frames: unknown[] = []
  const finished = Promise.withResolvers<void>()
  const subscribed = Promise.withResolvers<DesktopSink>()
  const closed: (() => void)[] = []
  const socket: StreamSocket = {
    sendText(data) {
      const frame = JSON.parse(data)
      frames.push(frame)
      if (frame.state === "stopped") finished.resolve()
    },
    close() { for (const listener of closed.splice(0)) listener() },
    onClose(listener) { closed.push(listener) },
    onText() {},
  }
  const layer = Layer.mergeAll(
    Layer.succeed(Config, config),
    Layer.succeed(CoreService, { getTask: () => Effect.succeed({ id: "task" }) } as never),
    Layer.succeed(DesktopManager, {
      subscribe: (_id: string, sink: DesktopSink) => Effect.sync(() => {
        subscribed.resolve(sink)
        sink.onStatus(running)
        return Effect.void
      }),
    } as never),
    ActivityTrackerLive,
  )
  const fiber = Effect.runFork(serveStream({ kind: "desktop", taskId: "task" }, "alice", socket).pipe(Effect.provide(layer as Layer.Layer<WsServices>)))
  try {
    const sink = await subscribed.promise
    await requested.promise
    sink.onStatus({ ...running, state: "stopped", display: null })
    expect(frames).toEqual([])
    release.resolve()
    await finished.promise
    expect(frames).toEqual([
      { _tag: "rtc.config", iceServers: [{ urls: ["turns:turn.example:443?transport=tcp"], username: "viewer", credential: "temporary" }], iceTransportPolicy: "all" },
      running,
      { ...running, state: "stopped", display: null },
    ])
    // This restart queues configuration, but disconnect wins before the queue's next microtask.
    sink.onStatus(running)
    socket.close()
    await Effect.runPromise(Fiber.join(fiber))
    await Promise.resolve()
    expect(frames).toHaveLength(3)
  } finally {
    release.resolve()
    socket.close()
    await Effect.runPromise(Fiber.interrupt(fiber))
    provider.stop(true)
  }
})
