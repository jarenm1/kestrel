import { describe, expect, test } from "bun:test"
import { Effect, Fiber, Layer } from "effect"
import type { DesktopStatus } from "@cloudagents/protocol"
import { Config, type ServerConfig } from "../config"
import { CoreService } from "../core/service"
import { DesktopError, DesktopManager, type DesktopSink } from "../desktop"
import { ActivityTrackerLive } from "../platform/tracker"
import { serveStream, type StreamSocket, type WsServices } from "../http/streams"

const config = {
  direct: null,
  relay: null,
  webrtc: { iceServers: [], turn: null, policy: "all", portRange: null, hostAddresses: [], denyPrivate: true },
} as unknown as ServerConfig

const running: DesktopStatus = {
  taskId: "task",
  state: "running",
  streaming: true,
  display: ":101",
  width: 2560,
  height: 1440,
  fps: 30,
  quality: "1080p30",
  error: null,
}

const view = (subscribe: (sink: DesktopSink) => Effect.Effect<Effect.Effect<void>, DesktopError>) => {
  const frames: Array<Record<string, unknown>> = []
  const waiters = new Set<() => void>()
  const wake = (): void => {
    for (const waiter of [...waiters]) waiter()
  }
  let onText: ((data: string) => void) | null = null
  const closed: Array<number | undefined> = []
  const closeListeners: Array<() => void> = []
  let isClosed = false
  const socket: StreamSocket = {
    sendText(data) {
      frames.push(JSON.parse(data))
      wake()
    },
    close(code) {
      closed.push(code)
      isClosed = true
      for (const listener of closeListeners.splice(0)) listener()
      wake()
    },
    onClose(listener) {
      if (isClosed) listener()
      else closeListeners.push(listener)
    },
    onText(listener) {
      onText = listener
      wake()
    },
  }
  const layer = Layer.mergeAll(
    Layer.succeed(Config, config),
    Layer.succeed(CoreService, { getTask: () => Effect.succeed({ id: "task" }) } as never),
    Layer.succeed(DesktopManager, {
      subscribe: (_id: string, sink: DesktopSink) =>
        subscribe(sink).pipe(Effect.tap(() => Effect.sync(wake))),
    } as never),
    ActivityTrackerLive,
  )
  const fiber = Effect.runFork(
    serveStream({ kind: "desktop", taskId: "task" }, "alice", socket).pipe(
      Effect.provide(layer as Layer.Layer<WsServices>),
    ),
  )
  const waitFor = (check: () => boolean): Promise<void> => {
    const { promise, resolve } = Promise.withResolvers<void>()
    if (check()) {
      resolve()
      return promise
    }
    const waiter = (): void => {
      if (!check()) return
      waiters.delete(waiter)
      resolve()
    }
    waiters.add(waiter)
    return promise
  }
  return {
    frames,
    closed,
    waitFor,
    textHandlerReady: () => onText !== null,
    send: (data: string) => onText?.(data),
    close: () => {
      socket.close()
      return Effect.runPromise(Fiber.await(fiber))
    },
  }
}

describe("desktop viewer stream", () => {
  test("a desktop that is stopped or failed is refused with a retryable rtc.unavailable", async () => {
    const viewer = view(() => Effect.fail(new DesktopError({ message: "desktop for task task failed" })))
    await viewer.waitFor(() => viewer.closed.length === 1)
    expect(viewer.frames).toEqual([
      { _tag: "rtc.unavailable", reason: "desktop for task task failed", retryable: true },
    ])
    expect(viewer.closed).toEqual([1011])
    await viewer.close()
  })

  test("a config request that arrives before the first config is answered, not dropped", async () => {
    let sink: DesktopSink | null = null
    const viewer = view((next) =>
      Effect.sync(() => {
        sink = next
        return Effect.void
      }),
    )
    await viewer.waitFor(() => sink !== null && viewer.textHandlerReady())
    viewer.send(JSON.stringify({ _tag: "rtc.config.request" }))
    // The listener runs on a forked fiber; let it reach the handler before the status arrives.
    await Promise.resolve()
    sink!.onStatus(running)
    await viewer.waitFor(() => viewer.frames.some((frame) => frame.taskId === "task" && frame.state === "running"))
    expect(viewer.frames.filter((frame) => frame._tag === "rtc.config")).toHaveLength(1)

    // A request while the current config is sent is answered with a fresh one.
    viewer.send(JSON.stringify({ _tag: "rtc.config.request" }))
    await viewer.waitFor(() => viewer.frames.filter((frame) => frame._tag === "rtc.config").length === 2)
    expect(viewer.frames.filter((frame) => frame._tag === "rtc.config")).toHaveLength(2)
    await viewer.close()
  })

  test("a desktop restart sends a fresh ICE config for the new session", async () => {
    let sink: DesktopSink | null = null
    const viewer = view((next) =>
      Effect.sync(() => {
        sink = next
        next.onStatus(running)
        return Effect.void
      }),
    )
    await viewer.waitFor(() => viewer.frames.filter((frame) => frame._tag === "rtc.config").length === 1)
    sink!.onStatus({ ...running, state: "stopped", display: null, streaming: false })
    sink!.onStatus({ ...running, state: "starting" })
    sink!.onStatus(running)
    await viewer.waitFor(() => viewer.frames.filter((frame) => frame._tag === "rtc.config").length === 2)
    expect(viewer.frames.filter((frame) => frame._tag === "rtc.config")).toHaveLength(2)
    viewer.close()
  })
})
