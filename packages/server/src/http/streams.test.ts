import { describe, expect, test } from "bun:test"
import { Effect, Exit, Fiber, Layer, Runtime } from "effect"
import { decodeFrame, type ServerEvent } from "@cloudagents/protocol"
import { EventHub, EventHubLive } from "../core/events"
import { CoreService } from "../core/service"
import { ActivityTracker, ActivityTrackerLive } from "../platform/tracker"
import { RelayStream } from "../relay/stream"
import { serveStream, type WsServices } from "./streams"

const deleted: ServerEvent = { _tag: "task.deleted", taskId: "task", owner: "alice" }

const setup = async () => {
  const runtime = await Effect.runPromise(
    Effect.runtime<EventHub | ActivityTracker>().pipe(Effect.provide(Layer.merge(EventHubLive, ActivityTrackerLive))),
  )
  const hub = Runtime.runSync(runtime)(EventHub)
  const sent: string[] = []
  const stream = new RelayStream(7, (data) => sent.push(data))
  // The user-events route reads only the hub and the tracker.
  const fiber = Runtime.runFork(runtime as Runtime.Runtime<WsServices>)(serveStream({ kind: "user-events" }, "alice", stream))
  await Effect.runPromise(Effect.yieldNow())
  return { hub, stream, sent, fiber }
}

describe("serveStream over the relay", () => {
  test("acknowledges only after authorization and subscription", async () => {
    const authorized = Promise.withResolvers<void>()
    const runtime = await Effect.runPromise(Effect.runtime<EventHub | ActivityTracker | CoreService>().pipe(
      Effect.provide(Layer.mergeAll(EventHubLive, ActivityTrackerLive, Layer.succeed(CoreService, {
        getTask: () => Effect.promise(() => authorized.promise).pipe(Effect.as({ id: "task" })),
      } as never))),
    ))
    const hub = Runtime.runSync(runtime)(EventHub)
    const sent: string[] = []
    const acknowledged = Promise.withResolvers<void>()
    const stream = new RelayStream(7, (data) => {
      sent.push(data)
      acknowledged.resolve()
    })
    const fiber = Runtime.runFork(runtime as Runtime.Runtime<WsServices>)(serveStream({ kind: "events", taskId: "task" }, "alice", stream))
    await Effect.runPromise(Effect.yieldNow())
    hub.publish(deleted)
    expect(sent).toEqual([])
    authorized.resolve()
    await acknowledged.promise
    expect(sent.map(decodeFrame)).toEqual([{ t: "ws-text", id: 7, data: JSON.stringify({ _tag: "events.subscribed" }) }])
    hub.publish(deleted)
    expect(sent.map(decodeFrame)[1]).toEqual({ t: "ws-text", id: 7, data: JSON.stringify(deleted) })
    stream.receiveClose()
    await Effect.runPromise(Fiber.await(fiber))
  })
  test("delivers events to a RelayStream", async () => {
    const { hub, stream, sent, fiber } = await setup()
    hub.publish(deleted)
    expect(sent.map((frame) => decodeFrame(frame))).toEqual([
      { t: "ws-text", id: 7, data: JSON.stringify({ _tag: "events.subscribed" }) },
      { t: "ws-text", id: 7, data: JSON.stringify(deleted) },
    ])
    stream.receiveClose()
    expect(Exit.isSuccess(await Effect.runPromise(Fiber.await(fiber)))).toBe(true)
  })

  test("stops delivering once the browser leaves", async () => {
    const { hub, stream, sent, fiber } = await setup()
    stream.receiveClose()
    await Effect.runPromise(Fiber.await(fiber))
    hub.publish(deleted)
    expect(sent.map((frame) => decodeFrame(frame))).toEqual([
      { t: "ws-text", id: 7, data: JSON.stringify({ _tag: "events.subscribed" }) },
    ])
  })
})
