import { describe, expect, test } from "bun:test"
import { CREDENTIALS_HEADER, decodeFrame, type RelayFrame } from "@cloudagents/protocol"
import { Effect } from "effect"
import type { CredentialStoreShape } from "../credentials"
import type { RelayStream } from "./stream"
import { makeRelayDispatcher } from "./client"

const store: CredentialStoreShape = {
  get: () => Effect.succeed(null),
  set: () => Effect.void,
}

const credentials = JSON.stringify({ user: "alice" })

const httpFrame = (id: number, path = "/api/tasks/t1/messages"): Extract<RelayFrame, { t: "http" }> => ({
  t: "http",
  id,
  method: "POST",
  path,
  headers: {},
})

describe("relay dispatcher", () => {
  test("a retried http frame runs once and answers once", async () => {
    let calls = 0
    const sent: RelayFrame[] = []
    const answered = new Map<number, () => void>()
    const replyFor = (id: number) => {
      const pending = Promise.withResolvers<void>()
      answered.set(id, pending.resolve)
      return pending.promise
    }
    const dispatcher = makeRelayDispatcher({
      send: (data) => {
        if (typeof data !== "string") return
        const frame = decodeFrame(data)
        if (frame === null) return
        sent.push(frame)
        if (frame.t === "http-res") answered.get(frame.id)?.()
      },
      store,
      handle: async () => {
        calls += 1
        return new Response("ok")
      },
      runStream: () => undefined,
    })

    const firstReply = replyFor(7)
    dispatcher.dispatch(httpFrame(7))
    dispatcher.dispatch(httpFrame(7))
    await firstReply

    expect(calls).toBe(1)
    const replies = sent.filter((frame): frame is Extract<RelayFrame, { t: "http-res" }> => frame.t === "http-res")
    expect(replies).toHaveLength(1)
    expect(replies[0]?.id).toBe(7)

    // Suppression is in-flight only: once the first request answered, a Hub that restarts ids at 1 can reuse id 7
    // for the same or a different request and it must be served.
    const finishedRetry = replyFor(7)
    dispatcher.dispatch(httpFrame(7))
    await finishedRetry
    expect(calls).toBe(2)

    const reusedReply = replyFor(7)
    dispatcher.dispatch(httpFrame(7, "/api/tasks/t1/other"))
    await reusedReply
    expect(calls).toBe(3)

    // A different request id still runs.
    const secondReply = replyFor(8)
    dispatcher.dispatch(httpFrame(8))
    await secondReply
    expect(calls).toBe(4)
  })

  test("a duplicate ws-open keeps the live stream instead of orphaning a replacement", () => {
    const streams: RelayStream[] = []
    const sent: RelayFrame[] = []
    const dispatcher = makeRelayDispatcher({
      send: (data) => {
        if (typeof data !== "string") return
        const frame = decodeFrame(data)
        if (frame !== null) sent.push(frame)
      },
      store,
      handle: async () => new Response("ok"),
      runStream: (_route, _user, socket) => void streams.push(socket),
    })
    const open: Extract<RelayFrame, { t: "ws-open" }> = {
      t: "ws-open",
      id: 9,
      path: "/api/tasks/t1/events",
      headers: { [CREDENTIALS_HEADER]: credentials },
    }

    dispatcher.dispatch(open)
    dispatcher.dispatch(open)
    expect(streams).toHaveLength(1)
    expect(sent.filter((frame) => frame.t === "ws-close")).toHaveLength(0)

    // Once the browser (or the relay) closes it, the id can be opened again.
    streams[0]!.receiveClose()
    dispatcher.dispatch(open)
    expect(streams).toHaveLength(2)
  })

  test("a reused ws-open id for a different path replaces the stale stream", () => {
    const streams: RelayStream[] = []
    const dispatcher = makeRelayDispatcher({
      send: () => undefined,
      store,
      handle: async () => new Response("ok"),
      runStream: (_route, _user, socket) => void streams.push(socket),
    })
    const open = (path: string): Extract<RelayFrame, { t: "ws-open" }> => ({
      t: "ws-open",
      id: 9,
      path,
      headers: { [CREDENTIALS_HEADER]: credentials },
    })

    dispatcher.dispatch(open("/api/tasks/t1/events"))
    expect(streams).toHaveLength(1)
    // Same path is a retry and stays a no-op.
    dispatcher.dispatch(open("/api/tasks/t1/events"))
    expect(streams).toHaveLength(1)
    // A reused id with a different path is a new stream: the old one is closed and replaced.
    dispatcher.dispatch(open("/api/tasks/t2/events"))
    expect(streams).toHaveLength(2)
  })

  test("closing the connection closes every tunnelled stream", () => {
    const streams: RelayStream[] = []
    const sent: RelayFrame[] = []
    const dispatcher = makeRelayDispatcher({
      send: (data) => {
        if (typeof data !== "string") return
        const frame = decodeFrame(data)
        if (frame !== null) sent.push(frame)
      },
      store,
      handle: async () => new Response("ok"),
      runStream: (_route, _user, socket) => void streams.push(socket),
    })
    dispatcher.dispatch({
      t: "ws-open",
      id: 1,
      path: "/api/tasks/t1/events",
      headers: { [CREDENTIALS_HEADER]: credentials },
    })
    dispatcher.close()
    // The connection is gone, so the stream is closed locally: no close frame is echoed and no message is delivered.
    dispatcher.dispatch({ t: "ws-text", id: 1, data: "late" })
    streams[0]!.sendText("late")
    expect(sent).toHaveLength(0)
  })
})
