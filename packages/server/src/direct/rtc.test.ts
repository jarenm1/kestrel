import { describe, expect, test } from "bun:test"
import { Runtime } from "effect"
import { RTCPeerConnection, type RTCDataChannel } from "werift"
import {
  BOX_USER_HEADER,
  RTC_CHANNEL_LABEL,
  RtcReassembler,
  decodeFrame,
  encodeFrame,
  fragmentMessage,
  type RelayFrame,
} from "@cloudagents/protocol"
import type { WsServices } from "../http/streams"
import type { BoxActivitySink } from "./box-activity"
import { makeRtcServer } from "./rtc"

/** Answers each request with the identity the channel carried, as the box's web handler sees it. */
const webHandler = async (request: Request): Promise<Response> =>
  Response.json({ user: request.headers.get(BOX_USER_HEADER) })

const nowSeconds = (): number => Math.floor(Date.now() / 1000)

/** A browser-side channel: sends relay frames and collects the box's replies by id. */
class Browser {
  private readonly reassembler = new RtcReassembler()
  private readonly replies = new Map<number, (frame: RelayFrame) => void>()
  private readonly pongs: Array<() => void> = []
  private nextId = 1

  constructor(readonly dc: RTCDataChannel) {
    dc.onmessage = (event) => {
      const message = this.reassembler.push(event.data as Uint8Array)
      if (message === null || typeof message.data !== "string") return
      const frame = decodeFrame(message.data)
      if (frame?.t === "http-res") this.replies.get(frame.id)?.(frame)
      if (frame?.t === "pong") this.pongs.shift()?.()
    }
  }

  private sendFrame(frame: RelayFrame): void {
    const encoded = encodeFrame(frame)
    for (const fragment of fragmentMessage({ text: true, data: encoded })) {
      this.dc.send(Buffer.from(fragment.buffer, fragment.byteOffset, fragment.byteLength))
    }
  }

  /** Sends one GET /whoami and resolves with the reply. */
  whoami(): Promise<RelayFrame> {
    const id = this.nextId++
    const { promise, resolve } = Promise.withResolvers<RelayFrame>()
    this.replies.set(id, resolve)
    this.sendFrame({ t: "http", id, method: "GET", path: "/whoami", headers: {} })
    return promise
  }

  /** Sends a keepalive and resolves with the box's pong. */
  ping(): Promise<void> {
    const { promise, resolve } = Promise.withResolvers<void>()
    this.pongs.push(resolve)
    this.sendFrame({ t: "ping" })
    return promise
  }
}

/** One browser connection with its channel; the box answers the offer for `expiresAt` (epoch seconds). */
async function dial(expiresAt: number, activity?: BoxActivitySink): Promise<{ pc: RTCPeerConnection; dc: RTCDataChannel }> {
  // The channel's streams are never opened here, so the runtime's services are unused.
  const runtime = Runtime.defaultRuntime as Runtime.Runtime<WsServices>
  const server = makeRtcServer({ webHandler, runtime, activity })
  const pc = new RTCPeerConnection({ iceServers: [] })
  const dc = pc.createDataChannel(RTC_CHANNEL_LABEL)
  await pc.setLocalDescription(await pc.createOffer())
  const sdp = pc.localDescription?.sdp
  if (!sdp) throw new Error("no local description")
  const answer = await server.answer({ user: "alice", dev: false }, { type: "offer", sdp }, expiresAt)
  if (answer === null) throw new Error("box refused the offer")
  await pc.setRemoteDescription({ type: "answer", sdp: answer.sdp })
  return { pc, dc }
}

/** Resolves once `dc` reaches `state`; a channel already there resolves at once. */
function untilState(dc: RTCDataChannel, state: "open" | "closed"): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<void>()
  if (dc.readyState === state) resolve()
  else dc.stateChanged.subscribe((next) => next === state && resolve())
  return promise
}

describe("direct channel", () => {
  test("serves requests with the token's identity and closes when the token lapses", async () => {
    // Real clock on purpose: the box closes the channel with a timer set from the token's epoch-seconds expiry.
    const { pc, dc } = await dial(nowSeconds() + 2)
    await untilState(dc, "open")
    const reply = await new Browser(dc).whoami()
    if (reply.t !== "http-res") throw new Error("expected an http reply")
    expect(reply.status).toBe(200)
    expect(JSON.parse(Buffer.from(reply.body ?? "", "base64").toString())).toEqual({ user: "alice" })
    await untilState(dc, "closed")
    await pc.close()
  })

  test("each request on an open channel is activity, but a keepalive is not", async () => {
    const logins: string[] = []
    const { pc, dc } = await dial(nowSeconds() + 30, { record: (login) => void logins.push(login) })
    await untilState(dc, "open")
    const browser = new Browser(dc)

    await browser.whoami()
    expect(logins).toEqual(["alice"])

    await browser.ping()
    expect(logins).toEqual(["alice"])

    await browser.whoami()
    expect(logins).toEqual(["alice", "alice"])
    await pc.close()
  })
})
