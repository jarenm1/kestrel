import { expect, test } from "bun:test"
import { createSocket } from "node:dgram"
import { Effect, Fiber, Layer } from "effect"
import { RTCPeerConnection, RTCRtpCodecParameters, useNACK, usePLI } from "werift"
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

/** A STUN server that answers every binding request with the same mapped address, so a gathered srflx candidate names it. */
const stunServer = (mapped: { address: string; port: number }) => {
  const socket = createSocket("udp4")
  socket.on("message", (data, rinfo) => {
    if (data.length < 20 || data.readUInt16BE(0) !== 0x0001) return
    const [a, b, c, d] = mapped.address.split(".").map(Number)
    const address = (((a! << 24) | (b! << 16) | (c! << 8) | d!) ^ 0x2112a442) >>> 0
    const attribute = Buffer.alloc(12)
    attribute.writeUInt16BE(0x0020, 0)
    attribute.writeUInt16BE(8, 2)
    attribute[5] = 0x01
    attribute.writeUInt16BE(mapped.port ^ 0x2112, 6)
    attribute.writeUInt32BE(address, 8)
    const header = Buffer.alloc(20)
    header.writeUInt16BE(0x0101, 0)
    header.writeUInt16BE(attribute.length, 2)
    header.writeUInt32BE(0x2112a442, 4)
    data.copy(header, 8, 8, 20)
    socket.send(Buffer.concat([header, attribute]), rinfo.port, rinfo.address)
  })
  return socket
}

interface Frame {
  _tag?: string
  candidate?: string | null
  iceServers?: { urls: string[] }[]
  iceTransportPolicy?: string
}

test("an offer's peer takes the managed ICE servers the config delivered", async () => {
  const mapped = { address: "203.0.113.7", port: 9999 }
  const stun = stunServer(mapped)
  await new Promise<void>((resolve) => stun.bind(0, "127.0.0.1", resolve))
  const stunPort = stun.address().port
  const managed = [
    { urls: [`stun:127.0.0.1:${stunPort}`] },
    { urls: ["turn:relay.invalid:3478?transport=udp"], username: "managed", credential: "temporary" },
  ]
  const provider = Bun.serve({
    port: 0,
    fetch: () => Response.json({ iceServers: managed, expiresAt: Date.now() + 3_600_000 }),
  })
  const config = {
    direct: { controlUrl: provider.url.href, boxId: "box", boxSecret: "secret", managed: true }, relay: null,
    webrtc: { iceServers: [], turn: null, policy: "all", portRange: null, hostAddresses: [], denyPrivate: true },
  } as unknown as ServerConfig
  const frames: Frame[] = []
  const configured = Promise.withResolvers<void>()
  const relayed = Promise.withResolvers<string>()
  const answered = Promise.withResolvers<void>()
  const closed: (() => void)[] = []
  let onText: ((data: string) => void) | null = null
  const socket: StreamSocket = {
    sendText(data) {
      const frame = JSON.parse(data) as Frame
      frames.push(frame)
      if (frame._tag === "rtc.config") configured.resolve()
      if (frame._tag === "rtc.answer") answered.resolve()
      if (frame._tag === "rtc.candidate" && typeof frame.candidate === "string") {
        if (frame.candidate.includes(` ${mapped.address} ${mapped.port} typ srflx `)) relayed.resolve(frame.candidate)
      }
    },
    close() { for (const listener of closed.splice(0)) listener() },
    onClose(listener) { closed.push(listener) },
    onText(listener) { onText = listener },
  }
  const subscribed = Promise.withResolvers<DesktopSink>()
  const layer = Layer.mergeAll(
    Layer.succeed(Config, config),
    Layer.succeed(CoreService, { getTask: () => Effect.succeed({ id: "task" }) } as never),
    Layer.succeed(DesktopManager, {
      subscribe: (_id: string, sink: DesktopSink) => Effect.sync(() => {
        subscribed.resolve(sink)
        sink.onStatus(running)
        return Effect.void
      }),
      refreshProfile: () => Effect.void,
    } as never),
    ActivityTrackerLive,
  )
  const fiber = Effect.runFork(serveStream({ kind: "desktop", taskId: "task" }, "alice", socket).pipe(Effect.provide(layer as Layer.Layer<WsServices>)))
  const browser = new RTCPeerConnection({
    iceServers: [],
    iceAdditionalHostAddresses: ["127.0.0.1"],
    codecs: {
      video: [new RTCRtpCodecParameters({
        mimeType: "video/H264",
        clockRate: 90_000,
        rtcpFeedback: [useNACK(), usePLI()],
        parameters: "packetization-mode=1;profile-level-id=42e028",
      })],
    },
  })
  try {
    await subscribed.promise
    await configured.promise
    expect(frames[0]).toEqual({ _tag: "rtc.config", iceServers: managed, iceTransportPolicy: "all" })
    browser.addTransceiver("video", { direction: "recvonly" })
    await browser.setLocalDescription(await browser.createOffer())
    onText!(JSON.stringify({ _tag: "rtc.offer", sdp: browser.localDescription!.sdp }))
    const candidate = await relayed.promise
    await answered.promise
    // Only the managed list carries a STUN server here, so a candidate naming it proves the peer got that list.
    expect(candidate).toContain("typ srflx")
    expect(frames.filter((frame) => frame._tag === "rtc.answer")).toHaveLength(1)
  } finally {
    await browser.close().catch(() => {})
    socket.close()
    await Effect.runPromise(Fiber.interrupt(fiber))
    provider.stop(true)
    stun.close()
  }
}, 20_000)
