import { describe, expect, test } from "bun:test"
import { EventEmitter } from "node:events"
import type { WebSocket } from "ws"
import { wsStreamSocket } from "./socket"

const OPEN = 1
const CLOSING = 2

/** The parts of a `ws` socket the adapter reads and writes. */
class FakeSocket extends EventEmitter {
  readyState = OPEN
  sent: string[] = []
  closedWith: { code: number; reason: string } | null = null
  send(data: string): void {
    this.sent.push(data)
  }
  close(code: number, reason: string): void {
    this.readyState = CLOSING
    this.closedWith = { code, reason }
  }
}

describe("wsStreamSocket", () => {
  test("a socket closed at grant expiry stops inbound text and releases its listeners at once", () => {
    const ws = new FakeSocket()
    const stream = wsStreamSocket(ws as unknown as WebSocket)
    const inbound: string[] = []
    let released = 0
    stream.onText((text) => inbound.push(text))
    stream.onClose(() => released++)
    ws.emit("message", Buffer.from("live command"), false)
    stream.sendText("live event")

    stream.close(4401, "box token expired")
    expect(ws.closedWith).toEqual({ code: 4401, reason: "box token expired" })
    expect(released).toBe(1)

    ws.emit("message", Buffer.from("late command"), false)
    stream.sendText("late event")
    expect(inbound).toEqual(["live command"])
    expect(ws.sent).toEqual(["live event"])
  })

  test("inbound text is dropped while the socket is closing, before its close event arrives", () => {
    const ws = new FakeSocket()
    const stream = wsStreamSocket(ws as unknown as WebSocket)
    const inbound: string[] = []
    stream.onText((text) => inbound.push(text))
    ws.emit("message", Buffer.from("live command"), false)

    ws.readyState = CLOSING
    ws.emit("message", Buffer.from("while closing"), false)
    expect(inbound).toEqual(["live command"])
  })
})
