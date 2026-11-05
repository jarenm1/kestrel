import {
  type DesktopInput,
  type DesktopRtcClientMessage,
  type DesktopRtcServerMessage,
} from "@cloudagents/protocol"

/** Connection attempt budget: a session that does not go live in this long is failed and retried. */
export const CONNECT_TIMEOUT_MS = 15_000
/** A browser takes seconds to call a dead path disconnected; the grace period rides out brief blips. */
export const DISCONNECT_GRACE_MS = 4_000
/** Without a decoded frame or a new packet for this long on a started video stream, the data path is dead. */
export const PATH_SILENCE_MS = 3_500
export const RETRY_MIN_MS = 1_000
export const RETRY_MAX_MS = 30_000
export const STATS_EVERY_MS = 1_000
/** Half the box's TURN credential lifetime: a retry with a config older than this asks the box for a new one first. */
export const CONFIG_MAX_AGE_MS = 30 * 60 * 1_000

/**
 * `unsupported`: the box cannot serve this session (a non-retryable refusal, or no WebRTC in this browser); nothing
 * retries until the box sends a new config. `retrying`: a retryable refusal or a failed attempt, until a later attempt
 * goes live; a new offer follows after `retryDelay`.
 */
export type RtcState = "idle" | "connecting" | "live" | "retrying" | "unsupported"
export type RtcPath = "direct" | "relay"

export interface RtcStats {
  /** Frames the decoder is presenting per second. */
  fps: number | null
  /** Mean decode time per frame over the last sample. */
  decodeMs: number | null
  /** Mean jitter-buffer delay per frame over the last sample. */
  jitterMs: number | null
  rttMs: number | null
  path: RtcPath | null
}

/** Wait before the next offer after `attempt` (0-based) consecutive refusals or failures: 1 s, doubling to 30 s. There is no other path for the media. */
export function retryDelay(attempt: number): number {
  return Math.min(RETRY_MAX_MS, RETRY_MIN_MS * 2 ** attempt)
}

type Report = Record<string, unknown>

function num(value: unknown): number | null {
  return typeof value === "number" ? value : null
}

/** Cumulative decoder and jitter-buffer counters; the stats line shows the change between samples. */
export interface Counters {
  frames: number
  decodeS: number
  emitted: number
  jitterS: number
}

/** Turns a `getStats()` report into the stats line. `prev` is the previous sample's counters, or null. */
export function measure(reports: Report[], prev: Counters | null): { stats: RtcStats; counters: Counters | null } {
  const inbound = reports.find((r) => r.type === "inbound-rtp" && r.kind === "video")
  const pair = reports.find(
    (r) => r.type === "candidate-pair" && r.state === "succeeded" && (r.nominated === true || r.selected === true),
  )
  const local = pair ? reports.find((r) => r.type === "local-candidate" && r.id === pair.localCandidateId) : undefined
  const rtt = pair ? num(pair.currentRoundTripTime) : null

  const stats: RtcStats = {
    fps: inbound ? num(inbound.framesPerSecond) : null,
    decodeMs: null,
    jitterMs: null,
    rttMs: rtt === null ? null : rtt * 1000,
    path: local ? (local.candidateType === "relay" ? "relay" : "direct") : null,
  }
  if (!inbound) return { stats, counters: null }

  const counters: Counters = {
    frames: num(inbound.framesDecoded) ?? 0,
    decodeS: num(inbound.totalDecodeTime) ?? 0,
    emitted: num(inbound.jitterBufferEmittedCount) ?? 0,
    jitterS: num(inbound.jitterBufferDelay) ?? 0,
  }
  if (prev) {
    const frames = counters.frames - prev.frames
    if (frames > 0) stats.decodeMs = ((counters.decodeS - prev.decodeS) / frames) * 1000
    const emitted = counters.emitted - prev.emitted
    if (emitted > 0) stats.jitterMs = ((counters.jitterS - prev.jitterS) / emitted) * 1000
  }
  return { stats, counters }
}

/** Ask the receiver to hold no jitter buffer, where the browser exposes the hints. */
function lowLatency(receiver: RTCRtpReceiver): void {
  const hints = receiver as RTCRtpReceiver & { jitterBufferTarget?: number; playoutDelayHint?: number }
  if ("jitterBufferTarget" in receiver) hints.jitterBufferTarget = 0
  if ("playoutDelayHint" in receiver) hints.playoutDelayHint = 0
}

export interface DesktopRtcHandlers {
  /** Signaling to the box over the desktop WebSocket. */
  send(message: DesktopRtcClientMessage): void
  onState(state: RtcState): void
  onStats(stats: RtcStats): void
  /** Whether the stream carries audio; false until the audio track arrives. */
  onAudio(available: boolean): void
}

type Timer = "config" | "connect" | "grace" | "retry" | "stats"

interface Config {
  iceServers: RTCIceServer[]
  iceTransportPolicy: RTCIceTransportPolicy
}

/**
 * One viewer's WebRTC session to a desktop. The box's config starts an offer; the answer and candidates complete it.
 * Video and audio arrive on `video`'s stream; input goes over the `input` (reliable) and `pointer` (unreliable)
 * data channels. The session is torn down and re-offered on refusal, failure, or a new config.
 */
export class DesktopRtc {
  private config: Config | null = null
  /** The config is past CONFIG_MAX_AGE_MS, so its TURN credentials may be about to expire. */
  private configStale = false
  /** The next config answers this session's `rtc.config.request`: a retry goes on, not a new desktop. */
  private refreshing = false
  private pc: RTCPeerConnection | null = null
  private input: RTCDataChannel | null = null
  private pointer: RTCDataChannel | null = null
  private state: RtcState = "idle"
  private attempts = 0
  private closed = false
  private offered = false
  private remoteSet = false
  /** Local candidates produced before the offer went out; sent right after it. */
  private localQueue: DesktopRtcClientMessage[] = []
  /** Remote candidates that arrived before the answer was applied. */
  private remoteQueue: RTCIceCandidateInit[] = []
  private timers: Partial<Record<Timer, number>> = {}
  /** Dead-path tracking for the inbound video stream; reset per connection. */
  private pathDecoded = 0
  private pathPacketAt: number | null = null
  private pathSilent = 0
  private counters: Counters | null = null

  constructor(
    private video: HTMLVideoElement,
    private handlers: DesktopRtcHandlers,
  ) {}

  /** Applies a message from the box. */
  handle(message: DesktopRtcServerMessage): void {
    if (this.closed) return
    switch (message._tag) {
      case "rtc.config":
        this.config = {
          iceServers: message.iceServers.map((s) => ({ ...s, urls: [...s.urls] })),
          iceTransportPolicy: message.iceTransportPolicy,
        }
        this.configStale = false
        this.arm("config", CONFIG_MAX_AGE_MS, () => {
          this.configStale = true
        })
        if (!this.refreshing) this.attempts = 0
        this.refreshing = false
        this.negotiate()
        return
      case "rtc.answer":
        void this.answer(message.sdp)
        return
      case "rtc.candidate":
        this.remoteCandidate(message)
        return
      case "rtc.unavailable":
        this.declined(message.retryable)
        return
    }
  }

  /** Sends `input` as JSON on the reliable channel, or on the pointer channel when `pointer` is set. */
  sendInput(message: DesktopInput, pointer = false): boolean {
    const channel = pointer && this.pointer?.readyState === "open" ? this.pointer : this.input
    if (!channel || channel.readyState !== "open") return false
    channel.send(JSON.stringify(message))
    return true
  }

  /** Ends the session and sends `rtc.close` if one was open. */
  close(): void {
    if (this.closed) return
    this.drop(true)
    this.closed = true
    this.clear("retry")
    this.clear("config")
    this.setState("idle")
  }

  private setState(state: RtcState): void {
    if (state === this.state) return
    this.state = state
    this.handlers.onState(state)
  }

  private negotiate(): void {
    const config = this.config
    if (!config || this.closed) return
    this.drop(false)
    this.clear("retry")
    if (typeof RTCPeerConnection === "undefined") {
      this.setState("unsupported")
      return
    }

    const pc = new RTCPeerConnection({ iceServers: config.iceServers, iceTransportPolicy: config.iceTransportPolicy })
    this.pc = pc
    const stream = new MediaStream()
    pc.addTransceiver("video", { direction: "recvonly" })
    pc.addTransceiver("audio", { direction: "recvonly" })

    const input = pc.createDataChannel("input", { ordered: true })
    this.input = input
    this.pointer = pc.createDataChannel("pointer", { ordered: false, maxRetransmits: 0 })

    pc.ontrack = (ev) => {
      lowLatency(ev.receiver)
      stream.addTrack(ev.track)
      if (this.video.srcObject !== stream) this.video.srcObject = stream
      if (ev.track.kind === "audio") this.handlers.onAudio(true)
      void this.video.play().catch(() => {})
    }
    pc.onicecandidate = (ev) => {
      const c = ev.candidate
      this.localCandidate({
        _tag: "rtc.candidate",
        candidate: c ? c.candidate : null,
        sdpMid: c ? c.sdpMid : null,
        sdpMLineIndex: c ? c.sdpMLineIndex : null,
      })
    }
    pc.onconnectionstatechange = () => this.connection(pc.connectionState)

    // After a failure the state stays `retrying` until an attempt goes live, so the viewer is told once, not on and off.
    this.setState(this.attempts > 0 ? "retrying" : "connecting")
    this.arm("connect", CONNECT_TIMEOUT_MS, () => this.fail())
    void this.offer(pc)
  }

  private async offer(pc: RTCPeerConnection): Promise<void> {
    try {
      await pc.setLocalDescription(await pc.createOffer())
      if (this.pc !== pc) return
      const sdp = pc.localDescription?.sdp
      if (!sdp) throw new Error("no local description")
      this.handlers.send({ _tag: "rtc.offer", sdp })
      this.offered = true
      for (const message of this.localQueue) this.handlers.send(message)
      this.localQueue = []
    } catch {
      if (this.pc === pc) this.fail()
    }
  }

  private async answer(sdp: string): Promise<void> {
    const pc = this.pc
    if (!pc) return
    try {
      await pc.setRemoteDescription({ type: "answer", sdp })
      if (this.pc !== pc) return
      this.remoteSet = true
      const queued = this.remoteQueue
      this.remoteQueue = []
      for (const candidate of queued) await pc.addIceCandidate(candidate).catch(() => {})
    } catch {
      if (this.pc === pc) this.fail()
    }
  }

  private remoteCandidate(message: { candidate: string | null; sdpMid: string | null; sdpMLineIndex: number | null }): void {
    // A null candidate is the box's end-of-candidates marker; the browser needs no call for it.
    if (message.candidate === null || !this.pc) return
    const init: RTCIceCandidateInit = {
      candidate: message.candidate,
      sdpMid: message.sdpMid,
      sdpMLineIndex: message.sdpMLineIndex,
    }
    if (!this.remoteSet) {
      this.remoteQueue.push(init)
      return
    }
    void this.pc.addIceCandidate(init).catch(() => {})
  }

  private localCandidate(message: DesktopRtcClientMessage): void {
    if (this.offered) this.handlers.send(message)
    else this.localQueue.push(message)
  }

  private connection(state: RTCPeerConnectionState): void {
    switch (state) {
      case "connected":
        this.clear("connect")
        this.clear("grace")
        this.attempts = 0
        this.setState("live")
        this.arm("stats", STATS_EVERY_MS, () => void this.sample(), true)
        return
      case "disconnected":
        this.arm("grace", DISCONNECT_GRACE_MS, () => this.fail())
        return
      case "failed":
        this.fail()
        return
    }
  }

  /**
   * Counts stats samples with no newly decoded frame and no new packet on a started video stream. Past
   * PATH_SILENCE_MS the data path is dead even if ICE still reports connected.
   */
  private watchPath(inbound: Report | undefined): void {
    if (!inbound) return
    const decoded = num(inbound.framesDecoded) ?? 0
    const packetAt = num(inbound.lastPacketReceivedTimestamp)
    if (decoded > this.pathDecoded || (packetAt !== null && packetAt !== this.pathPacketAt)) this.pathSilent = 0
    else this.pathSilent++
    this.pathDecoded = decoded
    this.pathPacketAt = packetAt
    if (decoded > 0 && this.pathSilent * STATS_EVERY_MS > PATH_SILENCE_MS) this.fail()
  }

  private async sample(): Promise<void> {
    const pc = this.pc
    if (!pc) return
    const report = await pc.getStats()
    if (this.pc !== pc) return
    const reports: Report[] = []
    report.forEach((r) => reports.push(r as Report))
    const result = measure(reports, this.counters)
    this.counters = result.counters
    this.handlers.onStats(result.stats)
    this.watchPath(reports.find((r) => r.type === "inbound-rtp" && r.kind === "video"))
  }

  /** A refusal by the box: no session exists on its side, so nothing is closed. */
  private declined(retryable: boolean): void {
    this.drop(false)
    if (!retryable) {
      this.setState("unsupported")
      return
    }
    this.scheduleRetry()
  }

  /** A failed attempt (timeout, dead path, failed negotiation): close the box's session, then retry. */
  private fail(): void {
    if (this.closed) return
    this.drop(true)
    this.scheduleRetry()
  }

  private scheduleRetry(): void {
    this.setState("retrying")
    this.arm("retry", retryDelay(this.attempts), () => this.retry())
    this.attempts++
  }

  /** The next offer, after fetching a new config if this one is old. The offer goes out anyway if no answer comes. */
  private retry(): void {
    if (!this.configStale) {
      this.negotiate()
      return
    }
    this.refreshing = true
    this.handlers.send({ _tag: "rtc.config.request" })
    this.arm("retry", CONNECT_TIMEOUT_MS, () => this.negotiate())
  }

  /** Tears down the peer connection. `sendClose` tells the box to end its side of the session. */
  private drop(sendClose: boolean): void {
    const pc = this.pc
    if (!pc) return
    for (const timer of ["connect", "grace", "stats"] as const) this.clear(timer)
    this.input?.close()
    this.pointer?.close()
    this.input = null
    this.pointer = null
    this.pc = null
    pc.onconnectionstatechange = null
    pc.ontrack = null
    pc.onicecandidate = null
    pc.close()
    this.offered = false
    this.remoteSet = false
    this.localQueue = []
    this.remoteQueue = []
    this.pathDecoded = 0
    this.pathPacketAt = null
    this.pathSilent = 0
    this.counters = null
    this.video.srcObject = null
    this.handlers.onAudio(false)
    if (sendClose) this.handlers.send({ _tag: "rtc.close" })
  }

  private arm(timer: Timer, ms: number, fn: () => void, repeat = false): void {
    this.clear(timer)
    this.timers[timer] = repeat ? window.setInterval(fn, ms) : window.setTimeout(fn, ms)
  }

  private clear(timer: Timer): void {
    const id = this.timers[timer]
    if (id !== undefined) window.clearTimeout(id)
    delete this.timers[timer]
  }
}
