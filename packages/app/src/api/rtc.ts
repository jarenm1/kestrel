import { Effect, Schema } from "effect"
import {
  Paths,
  RTC_CHANNEL_LABEL,
  RTC_ICE_SERVERS,
  RtcReassembler,
  WebRtcAnswer,
  decodeFrame,
  encodeFrame,
  fragmentMessage,
  fromBase64,
  toBase64,
  type RelayFrame,
  type RtcMessage,
} from "@cloudagents/protocol"

/** Candidate gathering waits this long at most; the offer goes out with the candidates gathered by then. */
const GATHER_TIMEOUT_MS = 5_000
/** A channel whose data channel does not open within this long is abandoned. */
const OPEN_TIMEOUT_MS = 10_000
/** After a box refuses or drops its channel, calls go over HTTP for this long before another attempt. */
const RETRY_AFTER_MS = 60_000

export interface ChannelReply {
  readonly status: number
  readonly body: string
}

interface Waiter {
  readonly resolve: (reply: ChannelReply) => void
  readonly reject: (error: Error) => void
}

/** A request the channel could not send. The box never received the whole message, so it did not run it. */
export class ChannelUnsent extends Error {
  readonly unsent = true
}

/**
 * One box's data channel. Requests go over it as the box's HTTP handler would receive them: the box already knows the
 * caller's identity from the signed offer, so requests carry no token. The channel is alive from the moment it opens
 * until it closes; a request still waiting when it closes fails, like an HTTP request whose connection dropped.
 */
export class BoxChannel {
  private readonly pc: RTCPeerConnection
  private readonly dc: RTCDataChannel
  private readonly onLost: () => void
  private readonly reassembler = new RtcReassembler()
  private readonly waiters = new Map<number, Waiter>()
  private nextId = 1
  private alive = true

  constructor(pc: RTCPeerConnection, dc: RTCDataChannel, onLost: () => void) {
    this.pc = pc
    this.dc = dc
    this.onLost = onLost
    dc.onmessage = (event) => {
      this.receive(event.data)
    }
    dc.onclose = () => {
      this.lose("direct channel closed")
    }
    pc.onconnectionstatechange = () => {
      if (pc.connectionState === "failed" || pc.connectionState === "closed") this.lose("direct channel failed")
    }
  }

  request(method: string, path: string, body: unknown): Promise<ChannelReply> {
    const id = this.nextId++
    const payload = body === undefined ? undefined : toBase64(new TextEncoder().encode(JSON.stringify(body)))
    const frame: RelayFrame = {
      t: "http",
      id,
      method,
      path,
      headers: body === undefined ? {} : { "content-type": "application/json" },
      ...(payload === undefined ? {} : { body: payload }),
    }
    const { promise, resolve, reject } = Promise.withResolvers<ChannelReply>()
    if (!this.alive) {
      reject(new Error("direct channel closed"))
      return promise
    }
    this.waiters.set(id, { resolve, reject })
    try {
      for (const fragment of fragmentMessage({ text: true, data: encodeFrame(frame) })) this.dc.send(fragment)
    } catch (err) {
      // Some fragments may have left, but the box cannot complete a message without the last one: the request never ran.
      const reason = err instanceof Error ? err.message : String(err)
      this.waiters.delete(id)
      reject(new ChannelUnsent(reason))
      this.lose(reason)
    }
    return promise
  }

  close(): void {
    this.lose("direct channel closed")
  }

  private receive(data: unknown): void {
    // Every box message is a binary fragment; a text message is not part of the protocol.
    if (!(data instanceof ArrayBuffer)) return this.lose("direct channel sent a text message")
    let message: RtcMessage | null
    try {
      message = this.reassembler.push(new Uint8Array(data))
    } catch (err) {
      return this.lose(err instanceof Error ? err.message : String(err))
    }
    if (message === null || !message.text || typeof message.data !== "string") return
    const frame = decodeFrame(message.data)
    if (frame?.t !== "http-res") return
    const waiter = this.waiters.get(frame.id)
    if (waiter === undefined) return
    this.waiters.delete(frame.id)
    const body = frame.body === undefined ? "" : new TextDecoder().decode(fromBase64(frame.body))
    waiter.resolve({ status: frame.status, body })
  }

  private lose(reason: string): void {
    if (!this.alive) return
    this.alive = false
    for (const waiter of this.waiters.values()) waiter.reject(new Error(reason))
    this.waiters.clear()
    this.onLost()
    this.pc.close()
  }
}

/** Resolves once candidate gathering completes, or after `GATHER_TIMEOUT_MS` with the candidates gathered so far. */
const gathered = (pc: RTCPeerConnection): Promise<void> => {
  const { promise, resolve } = Promise.withResolvers<void>()
  const done = (): void => {
    if (pc.iceGatheringState !== "complete") return
    clearTimeout(timer)
    pc.removeEventListener("icegatheringstatechange", done)
    resolve()
  }
  const timer = setTimeout(() => {
    pc.removeEventListener("icegatheringstatechange", done)
    resolve()
  }, GATHER_TIMEOUT_MS)
  pc.addEventListener("icegatheringstatechange", done)
  done()
  return promise
}

const opened = (dc: RTCDataChannel): Promise<void> => {
  const { promise, resolve, reject } = Promise.withResolvers<void>()
  const timer = setTimeout(() => {
    reject(new Error("direct channel did not open"))
  }, OPEN_TIMEOUT_MS)
  dc.onopen = () => {
    clearTimeout(timer)
    resolve()
  }
  return promise
}

/** Offers a channel to the box at `url`, authenticated with the box token, and resolves once it is open. */
async function connect(url: string, token: string, onLost: () => void): Promise<BoxChannel> {
  const pc = new RTCPeerConnection({ iceServers: RTC_ICE_SERVERS.map((urls) => ({ urls })) })
  try {
    const dc = pc.createDataChannel(RTC_CHANNEL_LABEL)
    dc.binaryType = "arraybuffer"
    await pc.setLocalDescription(await pc.createOffer())
    await gathered(pc)
    const local = pc.localDescription
    if (local === null) throw new Error("no local description")
    const res = await fetch(url + Paths.webrtcOffer, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ type: "offer", sdp: local.sdp }),
    })
    if (!res.ok) throw new Error(`box refused the channel with ${res.status}`)
    const answer = await Effect.runPromise(Schema.decodeUnknown(WebRtcAnswer)(await res.json()))
    await pc.setRemoteDescription({ type: "answer", sdp: answer.sdp })
    await opened(dc)
    return new BoxChannel(pc, dc, onLost)
  } catch (err) {
    pc.close()
    throw err
  }
}

const channels = new Map<string, BoxChannel>()
const connecting = new Set<string>()
const retryAt = new Map<string, number>()
/** Bumped by `closeChannels`, so a connect started under an earlier session never installs its channel. */
let generation = 0

/**
 * Closes every channel and forgets pending retries. Called when the session ends: a channel opened with one user's
 * token must not serve the next user who signs in on the same page.
 */
export function closeChannels(): void {
  generation++
  for (const channel of [...channels.values()]) channel.close()
  channels.clear()
  connecting.clear()
  retryAt.clear()
}

/**
 * The open data channel to a box, or null while there is none, so the call goes over HTTP. A missing channel starts
 * connecting in the background; a box that refused or dropped one is not tried again for `RETRY_AFTER_MS`.
 */
export function channelFor(boxId: string, url: string, token: string): BoxChannel | null {
  const open = channels.get(boxId)
  if (open !== undefined) return open
  if (connecting.has(boxId) || Date.now() < (retryAt.get(boxId) ?? 0)) return null
  const session = generation
  const current = (): boolean => session === generation
  connecting.add(boxId)
  connect(url, token, () => {
    if (!current()) return
    channels.delete(boxId)
    retryAt.set(boxId, Date.now() + RETRY_AFTER_MS)
  })
    .then((channel) => {
      if (!current()) return channel.close()
      channels.set(boxId, channel)
    })
    .catch(() => {
      if (current()) retryAt.set(boxId, Date.now() + RETRY_AFTER_MS)
    })
    .finally(() => {
      if (current()) connecting.delete(boxId)
    })
  return null
}
