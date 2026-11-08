import {
  type DesktopInput,
  type DesktopRtcBoxDiagnostics,
  type DesktopRtcClientMessage,
  type DesktopRtcServerMessage,
} from "@cloudagents/protocol"
import type { CandidateKind, IceTransport, RtcDiagnostics, RtcFailure } from "./diagnostics"

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
type IceError = RtcDiagnostics["iceErrors"][number]

function num(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null
}

/** Cumulative decoder and jitter-buffer counters; the stats line shows the change between samples. */
export interface Counters {
  frames: number
  decodeS: number
  emitted: number
  jitterS: number
}

const candidateKinds: Record<string, CandidateKind> = { host: "host", srflx: "srflx", prflx: "prflx", relay: "relay" }
const transports: Record<string, IceTransport> = { udp: "udp", tcp: "tcp", tls: "tls" }

function candidateKind(value: unknown): CandidateKind {
  return typeof value === "string" && Object.hasOwn(candidateKinds, value) ? candidateKinds[value]! : "unknown"
}

function transport(value: unknown): IceTransport {
  return typeof value === "string" && Object.hasOwn(transports, value) ? transports[value]! : "unknown"
}

/** The nominated or selected succeeded pair, reduced to candidate kinds, protocol, and relay protocol. */
function pairDetails(reports: Report[]): { info: NonNullable<RtcDiagnostics["selectedPair"]>; rtt: number | null } | null {
  const pair = reports.find(
    (r) => r.type === "candidate-pair" && r.state === "succeeded" && (r.nominated === true || r.selected === true),
  )
  if (!pair) return null
  const local = reports.find((r) => r.type === "local-candidate" && r.id === pair.localCandidateId)
  const remote = reports.find((r) => r.type === "remote-candidate" && r.id === pair.remoteCandidateId)
  return {
    info: {
      local: candidateKind(local?.candidateType),
      remote: candidateKind(remote?.candidateType),
      protocol: transport(local?.protocol ?? remote?.protocol),
      relayProtocol: local?.candidateType === "relay" ? transport(local?.relayProtocol) : "unknown",
    },
    rtt: num(pair.currentRoundTripTime),
  }
}

/** The scheme of a server URL, or null. Never keeps the URL itself. */
function urlScheme(url: unknown): string | null {
  if (typeof url !== "string") return null
  const match = /^([a-z][a-z0-9+.-]*):/i.exec(url)
  return match ? match[1]!.toLowerCase() : null
}

/** ICE server entries that carry TURN URLs and credentials: the box's managed or local relay configuration. */
function turnServerCount(servers: RTCIceServer[]): number {
  let count = 0
  for (const server of servers) {
    const urls = Array.isArray(server.urls) ? server.urls : [server.urls]
    const turn = urls.some((url) => {
      const scheme = urlScheme(url)
      return scheme === "turn" || scheme === "turns"
    })
    const authenticated =
      typeof server.username === "string" &&
      server.username.length > 0 &&
      typeof server.credential === "string" &&
      server.credential.length > 0
    if (turn && authenticated) count++
  }
  return count
}

/** Only the URL's scheme and TURN transport: no host, address, or credentials reach diagnostics. */
function iceErrorTransport(url: unknown): IceError["transport"] {
  const scheme = urlScheme(url)
  if (scheme === "stun") return "stun"
  if (scheme === "turns") return "turn-tls"
  if (scheme !== "turn") return "unknown"
  const match = typeof url === "string" ? /[?&]transport=([^&]*)/i.exec(url) : null
  return match?.[1]?.toLowerCase() === "tcp" ? "turn-tcp" : "turn-udp"
}

interface InboundEvidence {
  bytes: number | null
  packets: number | null
  frames: number | null
}

interface ReportEvidence {
  stats: RtcStats
  counters: Counters | null
  pair: RtcDiagnostics["selectedPair"]
  inbound: InboundEvidence
  video: Report | undefined
}

/** Extracts media counters, the selected pair, and inbound video evidence from a browser stats report. */
export function measure(reports: Report[], prev: Counters | null): ReportEvidence {
  const inbound = reports.find(
    (r) => r.type === "inbound-rtp" && (r.kind === "video" || r.mediaType === "video"),
  )
  const pair = pairDetails(reports)
  // A relay on either end is a relay path; `direct` needs both ends known and non-relay, never a guess.
  let path: RtcPath | null = null
  if (pair && (pair.info.local === "relay" || pair.info.remote === "relay")) path = "relay"
  else if (pair && pair.info.local !== "unknown" && pair.info.remote !== "unknown") path = "direct"
  const stats: RtcStats = {
    fps: inbound ? num(inbound.framesPerSecond) : null,
    decodeMs: null,
    jitterMs: null,
    rttMs: pair && pair.rtt !== null ? pair.rtt * 1000 : null,
    path,
  }
  // Missing metadata is unknown, not zero: an unreported counter must not look like received-but-undecodable video.
  const evidence: ReportEvidence = {
    stats,
    counters: null,
    pair: pair?.info ?? null,
    inbound: {
      bytes: num(inbound?.bytesReceived),
      packets: num(inbound?.packetsReceived),
      frames: num(inbound?.framesDecoded),
    },
    video: inbound,
  }
  if (!inbound) return evidence

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
  evidence.counters = counters
  return evidence
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
  /** Redacted connection evidence for a bug report; every call is a fresh, copied snapshot. */
  onDiagnostics(diagnostics: RtcDiagnostics): void
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
  /** Diagnostics belong to one negotiation; this counts them 1-based and does not follow the retry backoff. */
  private negotiations = 0
  private turnServers = 0
  private relayCandidates = 0
  private gathering: RTCIceGatheringState | "unknown" = "unknown"
  private connectionState: RTCPeerConnectionState | "unknown" = "unknown"
  private selectedPairInfo: RtcDiagnostics["selectedPair"] = null
  private inbound: InboundEvidence = { bytes: null, packets: null, frames: null }
  private lastFailure: RtcFailure | null = null
  private iceErrors: IceError[] = []
  private box: DesktopRtcBoxDiagnostics | null = null
  /** A box summary received for the config being resolved: it belongs to the attempt that config starts. */
  private pendingBox: DesktopRtcBoxDiagnostics | null = null
  /** At most one sample per peer; a hung sample from an old peer must not block a replacement. */
  private sampling: RTCPeerConnection | null = null

  constructor(
    private video: HTMLVideoElement,
    private handlers: DesktopRtcHandlers,
  ) {
    this.handlers.onDiagnostics(this.diagnostics())
  }

  /** Applies a message from the box. */
  handle(message: DesktopRtcServerMessage): void {
    if (this.closed) return
    switch (message._tag) {
      case "rtc.config": {
        // Only a successful connection resets consecutive-failure backoff. A late refresh is not a new session,
        // even if the bounded wait has already fallen back to the old settings.
        this.config = {
          iceServers: message.iceServers.map((s) => ({ ...s, urls: [...s.urls] })),
          iceTransportPolicy: message.iceTransportPolicy,
        }
        this.turnServers = turnServerCount(this.config.iceServers)
        this.configStale = false
        this.arm("config", CONFIG_MAX_AGE_MS, () => {
          this.configStale = true
        })
        this.refreshing = false
        this.negotiate()
        return
      }
      case "rtc.answer":
        void this.answer(message.sdp)
        return
      case "rtc.candidate":
        this.remoteCandidate(message)
        return
      case "rtc.diagnostics":
        this.boxDiagnostics(message.diagnostics)
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
    this.resetAttempt()
    if (this.pendingBox) {
      this.box = this.pendingBox
      this.pendingBox = null
    }
    if (typeof RTCPeerConnection === "undefined") {
      this.lastFailure = "unsupported"
      this.setState("unsupported")
      this.emitDiagnostics()
      return
    }
    this.negotiations++

    let pc: RTCPeerConnection
    try {
      pc = new RTCPeerConnection({ iceServers: config.iceServers, iceTransportPolicy: config.iceTransportPolicy })
    } catch {
      this.lastFailure = "negotiation"
      this.scheduleRetry(true)
      return
    }
    this.pc = pc
    this.gathering = pc.iceGatheringState
    this.connectionState = pc.connectionState
    const stream = new MediaStream()
    pc.addTransceiver("video", { direction: "recvonly" })
    pc.addTransceiver("audio", { direction: "recvonly" })

    const input = pc.createDataChannel("input", { ordered: true })
    this.input = input
    this.pointer = pc.createDataChannel("pointer", { ordered: false, maxRetransmits: 0 })

    pc.ontrack = (ev) => {
      if (this.pc !== pc) return
      lowLatency(ev.receiver)
      stream.addTrack(ev.track)
      if (this.video.srcObject !== stream) this.video.srcObject = stream
      if (ev.track.kind === "audio") this.handlers.onAudio(true)
      void this.video.play().catch((error: unknown) => {
        // Resetting srcObject during teardown aborts a pending play(); that is not a playback failure, and a stale
        // promise from a replaced peer or stream must not overwrite the attempt's connection evidence.
        if (this.closed || this.pc !== pc || this.video.srcObject !== stream) return
        if (typeof error === "object" && error !== null && "name" in error && error.name === "AbortError") return
        this.lastFailure = "playback"
        this.emitDiagnostics()
      })
    }
    pc.onicecandidate = (ev) => {
      if (this.pc !== pc) return
      const c = ev.candidate
      const relay =
        c !== null && (c.type === "relay" || /(?:^|\s)typ\s+relay(?:\s|$)/.test(c.candidate))
      if (relay) this.relayCandidates++
      if (relay || pc.iceGatheringState !== this.gathering) {
        this.gathering = pc.iceGatheringState
        this.emitDiagnostics()
      }
      this.localCandidate({
        _tag: "rtc.candidate",
        candidate: c ? c.candidate : null,
        sdpMid: c ? c.sdpMid : null,
        sdpMLineIndex: c ? c.sdpMLineIndex : null,
      })
    }
    pc.onicecandidateerror = (ev) => {
      if (this.pc === pc) this.candidateError(ev)
    }
    pc.onicegatheringstatechange = () => {
      if (this.pc !== pc) return
      this.gathering = pc.iceGatheringState
      this.emitDiagnostics()
    }
    pc.onconnectionstatechange = () => {
      if (this.pc === pc) this.connection(pc.connectionState)
    }

    // After a failure the state stays `retrying` until an attempt goes live, so the viewer is told once, not on and off.
    this.setState(this.attempts > 0 ? "retrying" : "connecting")
    this.arm("connect", CONNECT_TIMEOUT_MS, () => this.fail("timeout"))
    this.arm("stats", STATS_EVERY_MS, () => void this.sample(), true)
    this.emitDiagnostics()
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
      if (this.pc === pc) this.fail("negotiation")
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
      if (this.pc === pc) this.fail("negotiation")
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
    this.connectionState = state
    switch (state) {
      case "connected":
        this.clear("connect")
        this.clear("grace")
        this.attempts = 0
        this.setState("live")
        this.arm("stats", STATS_EVERY_MS, () => void this.sample(), true)
        break
      case "disconnected":
        this.arm("grace", DISCONNECT_GRACE_MS, () => this.fail("connection"))
        break
      case "failed":
        this.fail("connection")
        return
    }
    this.emitDiagnostics()
  }

  /**
   * Counts stats samples with no newly decoded frame and no new packet on a started video stream. Past
   * PATH_SILENCE_MS the data path is dead even if ICE still reports connected.
   */
  private watchPath(inbound: Report | undefined): void {
    if (!inbound || this.state !== "live") return
    const decoded = num(inbound.framesDecoded) ?? 0
    const packetAt = num(inbound.lastPacketReceivedTimestamp)
    if (decoded > this.pathDecoded || (packetAt !== null && packetAt !== this.pathPacketAt)) this.pathSilent = 0
    else this.pathSilent++
    this.pathDecoded = decoded
    this.pathPacketAt = packetAt
    if (decoded > 0 && this.pathSilent * STATS_EVERY_MS > PATH_SILENCE_MS) this.fail("video-stalled")
  }

  private async sample(): Promise<void> {
    const pc = this.pc
    if (!pc || this.sampling === pc) return
    this.sampling = pc
    try {
      const report = await pc.getStats()
      // A dropped or replaced peer connection must not publish evidence for the attempt that replaced it.
      if (this.pc !== pc || this.closed) return
      const reports: Report[] = []
      report.forEach((r) => reports.push(r as Report))
      const evidence = measure(reports, this.counters)
      this.counters = evidence.counters
      this.handlers.onStats(evidence.stats)
      this.selectedPairInfo = evidence.pair
      this.inbound = evidence.inbound
      this.watchPath(evidence.video)
      this.emitDiagnostics()
    } catch {
      // A rejected sample is not a failed connection; the next tick tries again.
    } finally {
      if (this.sampling === pc) this.sampling = null
    }
  }

  /** A refusal by the box: no session exists on its side, so nothing is closed. */
  private declined(retryable: boolean): void {
    this.lastFailure = retryable ? "refused" : "unsupported"
    this.drop(false)
    if (!retryable) {
      this.pendingBox = null
      this.setState("unsupported")
      this.emitDiagnostics()
      return
    }
    // A viewer-limit refusal can re-offer with the config in hand; a config with no usable relay must be replaced.
    const refresh = this.turnServers === 0
    // The same config keeps the box's session summary; a refetched config brings its own.
    if (refresh) this.pendingBox = null
    this.scheduleRetry(refresh)
  }

  /** A failed attempt (timeout, dead path, failed negotiation): close the box's session, then retry. */
  private fail(failure: RtcFailure): void {
    if (this.closed || !this.pc) return
    this.lastFailure = failure
    this.pendingBox = null
    this.drop(true)
    this.scheduleRetry(true)
  }

  private scheduleRetry(refresh: boolean): void {
    this.setState("retrying")
    this.arm("retry", retryDelay(this.attempts), () => this.retry(refresh))
    this.attempts++
    this.emitDiagnostics()
  }

  /** The next attempt, after fetching fresh credentials when this one failed or the config aged out. */
  private retry(refresh: boolean): void {
    if (this.closed) return
    // The backoff already published the previous failure; it must not describe the attempt now starting.
    this.lastFailure = null
    if (!refresh && !this.configStale) {
      this.negotiate()
      return
    }
    this.refreshing = true
    this.handlers.send({ _tag: "rtc.config.request" })
    this.emitDiagnostics()
    // A box that never answers must not stall the session: fall back to the old config after the connect budget.
    this.arm("retry", CONNECT_TIMEOUT_MS, () => {
      if (this.closed) return
      this.refreshing = false
      this.negotiate()
    })
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
    pc.onicecandidateerror = null
    pc.onicegatheringstatechange = null
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

  /** Evidence belongs to one attempt; a new peer connection starts clean but keeps the attempt number. */
  private resetAttempt(): void {
    this.lastFailure = null
    this.relayCandidates = 0
    this.gathering = "unknown"
    this.connectionState = "unknown"
    this.selectedPairInfo = null
    this.inbound = { bytes: null, packets: null, frames: null }
    this.iceErrors = []
    this.box = null
  }

  /** A box summary is sent for the config it describes, sometimes before that config and with no peer yet. */
  private boxDiagnostics(box: DesktopRtcBoxDiagnostics): void {
    // Without a peer or a pending refresh, this can only be a late summary for an attempt already torn down.
    if (!this.pc && !this.refreshing && this.config !== null) return
    const copy = { ...box }
    this.pendingBox = copy
    this.box = copy
    this.emitDiagnostics()
  }

  /** Keeps the numeric code and the URL's scheme/transport only: no address, port, credentials, or error text. */
  private candidateError(ev: RTCPeerConnectionIceErrorEvent): void {
    const code = ev.errorCode
    if (typeof code !== "number" || !Number.isFinite(code)) return
    const error: IceError = { code: Math.trunc(code), transport: iceErrorTransport(ev.url) }
    if (this.iceErrors.length >= 4) return
    if (this.iceErrors.some((e) => e.code === error.code && e.transport === error.transport)) return
    this.iceErrors.push(error)
    this.emitDiagnostics()
  }

  private diagnostics(): RtcDiagnostics {
    let config: RtcDiagnostics["config"] = "ready"
    if (this.refreshing) config = "refreshing"
    else if (this.config === null) config = "waiting"
    return {
      attempt: this.negotiations,
      config,
      turnServers: this.turnServers,
      viewerRelayCandidates: this.relayCandidates,
      viewerGathering: this.gathering,
      connection: this.connectionState,
      selectedPair: this.selectedPairInfo ? { ...this.selectedPairInfo } : null,
      videoBytes: this.inbound.bytes,
      videoPackets: this.inbound.packets,
      framesDecoded: this.inbound.frames,
      lastFailure: this.lastFailure,
      iceErrors: this.iceErrors.map((error) => ({ ...error })),
      box: this.box ? { ...this.box } : null,
    }
  }

  /** Every call copies its arrays and objects, so a consumer can hold the snapshot past the next sample. */
  private emitDiagnostics(): void {
    if (this.closed) return
    this.handlers.onDiagnostics(this.diagnostics())
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
