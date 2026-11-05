/**
 * Direct WebRTC data channel between a browser and a user box.
 *
 * The app POSTs an SDP offer to `Paths.webrtcOffer` on the box (authenticated with the box token) and gets the
 * box's answer back in the same response: signalling is one round trip, so both sides gather their ICE candidates
 * before the offer is sent. The channel then carries the relay frames (`RelayFrame`, `encodeBinary`) in both
 * directions, so the box serves the same handlers it serves over HTTP and WebSocket.
 *
 * SCTP caps a message at the size the peer advertised (64 KiB unless negotiated higher), so each message is split
 * into fragments of at most `RTC_FRAGMENT_BYTES` payload bytes. Each fragment is one binary channel message whose
 * first byte holds the flags below. A sender emits all fragments of one message back to back, and the channel is
 * ordered and reliable, so a receiver reassembles messages in arrival order.
 */

import { Schema } from "effect"

export const RTC_CHANNEL_LABEL = "kestrel-api"

/** STUN servers the box and the browser use to learn their server-reflexive candidates. */
export const RTC_ICE_SERVERS: readonly string[] = ["stun:stun.cloudflare.com:3478"]

/** Payload bytes per fragment, excluding the one-byte flags header. */
export const RTC_FRAGMENT_BYTES = 16 * 1024

/** Largest reassembled message a receiver accepts; a larger message closes the channel. */
export const RTC_MAX_MESSAGE_BYTES = 32 * 1024 * 1024

/**
 * Most fragments a receiver accepts for one message. Every fragment, even one with no payload, is held until its
 * message completes, so the count is bounded as well as the bytes.
 */
const RTC_MAX_MESSAGE_FRAGMENTS = Math.ceil(RTC_MAX_MESSAGE_BYTES / RTC_FRAGMENT_BYTES)

/** Fragment flags: the last fragment of a message, and whether the message is text (JSON) or binary. */
const FLAG_LAST = 0x01
const FLAG_TEXT = 0x02

/** Session description the app posts to the box: the browser's offer, with its candidates gathered. */
export const WebRtcOffer = Schema.Struct({
  type: Schema.Literal("offer"),
  sdp: Schema.String,
})
export type WebRtcOffer = typeof WebRtcOffer.Type

/** The box's answer to a `WebRtcOffer`, with its own candidates gathered. */
export const WebRtcAnswer = Schema.Struct({
  type: Schema.Literal("answer"),
  sdp: Schema.String,
})
export type WebRtcAnswer = typeof WebRtcAnswer.Type

export interface RtcMessage {
  readonly text: boolean
  readonly data: string | Uint8Array
}

/** Splits one message into channel frames: each is the flags byte followed by at most `RTC_FRAGMENT_BYTES` bytes. */
export const fragmentMessage = (message: RtcMessage): Uint8Array<ArrayBuffer>[] => {
  const bytes = typeof message.data === "string" ? new TextEncoder().encode(message.data) : message.data
  const text = message.text ? FLAG_TEXT : 0
  const count = Math.max(1, Math.ceil(bytes.byteLength / RTC_FRAGMENT_BYTES))
  const out: Uint8Array<ArrayBuffer>[] = []
  for (let i = 0; i < count; i++) {
    const payload = bytes.subarray(i * RTC_FRAGMENT_BYTES, (i + 1) * RTC_FRAGMENT_BYTES)
    const frame = new Uint8Array(1 + payload.byteLength)
    frame[0] = text | (i === count - 1 ? FLAG_LAST : 0)
    frame.set(payload, 1)
    out.push(frame)
  }
  return out
}

/**
 * Rebuilds messages from fragments in arrival order. `push` returns the message once its last fragment arrives,
 * null while it is incomplete, and throws when a message would exceed `RTC_MAX_MESSAGE_BYTES` or
 * `RTC_MAX_MESSAGE_FRAGMENTS`, or when a fragment is empty.
 */
export class RtcReassembler {
  private parts: Uint8Array[] = []
  private size = 0

  push(frame: Uint8Array): RtcMessage | null {
    if (frame.byteLength < 1) throw new Error("empty channel fragment")
    this.size += frame.byteLength - 1
    if (this.size > RTC_MAX_MESSAGE_BYTES) throw new Error("channel message is too large")
    if (this.parts.length >= RTC_MAX_MESSAGE_FRAGMENTS) throw new Error("channel message has too many fragments")
    this.parts.push(frame.subarray(1))
    const flags = frame[0] ?? 0
    if ((flags & FLAG_LAST) === 0) return null
    const data = new Uint8Array(this.size)
    let offset = 0
    for (const part of this.parts) {
      data.set(part, offset)
      offset += part.byteLength
    }
    const text = (flags & FLAG_TEXT) !== 0
    this.parts = []
    this.size = 0
    return { text, data: text ? new TextDecoder().decode(data) : data }
  }
}
