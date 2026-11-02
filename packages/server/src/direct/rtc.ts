import { Runtime, Effect } from "effect"
import { RTCPeerConnection, type RTCDataChannel } from "werift"
import {
  RTC_CHANNEL_LABEL,
  RTC_ICE_SERVERS,
  RtcReassembler,
  decodeFrame,
  encodeFrame,
  fragmentMessage,
  type RelayFrame,
  type RtcMessage,
  type WebRtcAnswer,
  type WebRtcOffer,
} from "@cloudagents/protocol"
import { CLOSE_NOT_FOUND, serveStream, streamRoute, type WsServices } from "../http/streams"
import { RelayStream } from "../relay/stream"
import { serveTunnelHttp, TUNNEL_ORIGIN, type TunnelIdentity } from "../tunnel"

export interface RtcDeps {
  /** The box's web handler; tunnelled requests reach it with the channel's identity. */
  readonly webHandler: (request: Request) => Promise<Response>
  readonly runtime: Runtime.Runtime<WsServices>
}

export interface RtcServer {
  /**
   * Answers a browser's offer for `identity`. The channel closes at `expiresAt` (epoch seconds), when the token that
   * opened it lapses. Resolves once this box's candidates are gathered, so the answer is complete. Resolves null when
   * the box already serves `MAX_CHANNELS` channels.
   */
  readonly answer: (identity: TunnelIdentity, offer: WebRtcOffer, expiresAt: number) => Promise<WebRtcAnswer | null>
  /** Closes every open channel and the streams on it. */
  readonly close: () => void
}

/** Channels one box serves at once; each holds a peer connection and its sockets. */
const MAX_CHANNELS = 16
/** A channel whose data channel has not opened this long after the answer is abandoned. */
const OPEN_TIMEOUT_MS = 30_000
const ICE_SERVERS = RTC_ICE_SERVERS.map((urls) => ({ urls }))

/** Runs the relay frame protocol over the browser's data channel, with the channel's identity. */
const serveChannel = (
  deps: RtcDeps,
  identity: TunnelIdentity,
  dc: RTCDataChannel,
  closeChannel: () => void,
): void => {
  const streams = new Map<number, RelayStream>()
  const reassembler = new RtcReassembler()

  const send = (data: string | Uint8Array): void => {
    if (dc.readyState !== "open") return
    for (const fragment of fragmentMessage({ text: typeof data === "string", data })) {
      dc.send(Buffer.from(fragment.buffer, fragment.byteOffset, fragment.byteLength))
    }
  }

  const dispatch = (frame: RelayFrame): void => {
    switch (frame.t) {
      case "http":
        void serveTunnelHttp(frame, deps.webHandler, identity, (reply) => send(encodeFrame(reply)))
        return
      case "ws-open": {
        const url = new URL(frame.path, TUNNEL_ORIGIN)
        const protocol = frame.headers["x-kestrel-preview-protocol"]?.split(",")[0]?.trim()
        const route = streamRoute(url.pathname, frame.path, protocol)
        if (route === null) {
          send(encodeFrame({ t: "ws-close", id: frame.id, code: CLOSE_NOT_FOUND, reason: "not found" }))
          return
        }
        const stream = new RelayStream(frame.id, send)
        streams.set(frame.id, stream)
        stream.onClose(() => streams.delete(frame.id))
        Runtime.runFork(deps.runtime)(serveStream(route, identity.user, stream))
        return
      }
      case "ws-text":
        streams.get(frame.id)?.receiveText(frame.data)
        return
      case "ws-close":
        streams.get(frame.id)?.receiveClose()
        return
      case "ping":
        send(encodeFrame({ t: "pong" }))
        return
      case "hello":
      case "http-res":
      case "pong":
        return
    }
  }

  dc.onmessage = (event) => {
    // Fragments are binary; a text message is not part of the protocol and closes the channel.
    if (!(event.data instanceof Uint8Array)) return closeChannel()
    let message: RtcMessage | null
    try {
      message = reassembler.push(event.data)
    } catch (err) {
      Effect.runSync(Effect.logWarning(`webrtc: ${err instanceof Error ? err.message : String(err)}`))
      return closeChannel()
    }
    // Binary messages would carry WebSocket binary payloads, which no local handler accepts (see relay/client.ts).
    if (message === null || !message.text || typeof message.data !== "string") return
    const frame = decodeFrame(message.data)
    if (frame === null) {
      Effect.runSync(Effect.logWarning("webrtc: dropped malformed frame"))
      return
    }
    dispatch(frame)
  }
  dc.onclose = () => {
    for (const stream of streams.values()) stream.receiveClose()
    streams.clear()
    closeChannel()
  }
}

export const makeRtcServer = (deps: RtcDeps): RtcServer => {
  const closers = new Set<() => void>()

  const answer = async (
    identity: TunnelIdentity,
    offer: WebRtcOffer,
    expiresAt: number,
  ): Promise<WebRtcAnswer | null> => {
    if (closers.size >= MAX_CHANNELS) return null
    const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS })
    let closed = false
    let opened = false
    let served = false
    const closeChannel = (): void => {
      if (closed) return
      closed = true
      closers.delete(closeChannel)
      clearTimeout(openTimer)
      clearTimeout(expiryTimer)
      void pc.close()
    }
    closers.add(closeChannel)

    pc.connectionStateChange.subscribe((state) => {
      if (state === "failed" || state === "closed") closeChannel()
    })
    pc.onDataChannel.subscribe((dc) => {
      // One channel per connection: a second one with the same label would be served beside the first.
      if (dc.label !== RTC_CHANNEL_LABEL || served) {
        dc.close()
        return
      }
      served = true
      dc.stateChanged.subscribe((state) => {
        if (state === "open") opened = true
      })
      serveChannel(deps, identity, dc, closeChannel)
    })
    const openTimer = setTimeout(() => {
      if (!opened) closeChannel()
    }, OPEN_TIMEOUT_MS)
    openTimer.unref()
    const expiryTimer = setTimeout(closeChannel, Math.max(0, expiresAt * 1000 - Date.now()))
    expiryTimer.unref()

    try {
      await pc.setRemoteDescription({ type: "offer", sdp: offer.sdp })
      await pc.setLocalDescription(await pc.createAnswer())
      const sdp = pc.localDescription?.sdp
      if (sdp === undefined) throw new Error("webrtc: no local description after answering")
      return { type: "answer", sdp }
    } catch (err) {
      closeChannel()
      throw err
    }
  }

  return {
    answer,
    close: () => {
      for (const close of [...closers]) close()
    },
  }
}
