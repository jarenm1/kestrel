import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import {
  type DesktopRtcBoxDiagnostics,
  type DesktopRtcClientMessage,
  type DesktopRtcServerMessage,
} from "@cloudagents/protocol"
import {
  CONFIG_MAX_AGE_MS,
  CONNECT_TIMEOUT_MS,
  DISCONNECT_GRACE_MS,
  DesktopRtc,
  STATS_EVERY_MS,
  RETRY_MAX_MS,
  measure,
  retryDelay,
  type Counters,
  type RtcState,
  type RtcStats,
} from "./webrtc"
import { diagnosticSummary, type RtcDiagnostics } from "./diagnostics"

interface Timer {
  id: number
  at: number
  every: number | null
  fn: () => void
}

interface FakeClock {
  api: {
    setTimeout: (fn: () => void, ms: number) => number
    setInterval: (fn: () => void, ms: number) => number
    clearTimeout: (id: number) => void
    clearInterval: (id: number) => void
  }
  advance(ms: number): void
}

/** Replaces `window`'s timers with a clock that only moves when `advance` is called. */
function fakeWindow(): FakeClock {
  let now = 0
  let nextId = 1
  const timers = new Map<number, Timer>()
  const add = (fn: () => void, ms: number, every: number | null): number => {
    const id = nextId++
    timers.set(id, { id, at: now + ms, every, fn })
    return id
  }
  const drop = (id: number) => {
    timers.delete(id)
  }
  return {
    api: {
      setTimeout: (fn: () => void, ms: number) => add(fn, ms, null),
      setInterval: (fn: () => void, ms: number) => add(fn, ms, ms),
      clearTimeout: drop,
      clearInterval: drop,
    },
    advance(ms: number) {
      const end = now + ms
      for (;;) {
        let next: Timer | null = null
        for (const t of timers.values()) if (t.at <= end && (next === null || t.at < next.at)) next = t
        if (next === null) break
        now = next.at
        if (next.every === null) timers.delete(next.id)
        else next.at += next.every
        next.fn()
      }
      now = end
    },
  }
}

class FakeChannel {
  readyState = "connecting"
  sent: string[] = []
  onopen: (() => void) | null = null
  onmessage: ((ev: { data: unknown }) => void) | null = null

  constructor(
    readonly label: string,
    readonly init: RTCDataChannelInit | undefined,
  ) {}

  open(): void {
    this.readyState = "open"
    this.onopen?.()
  }

  send(data: string): void {
    this.sent.push(data)
  }

  close(): void {
    this.readyState = "closed"
  }
}

class FakePeer {
  static all: FakePeer[] = []
  connectionState = "new"
  iceGatheringState = "new"
  localDescription: { sdp: string } | null = null
  remote: unknown = null
  remoteCandidates: unknown[] = []
  transceivers: { kind: string; direction: string }[] = []
  channels: FakeChannel[] = []
  stats = new Map<string, Record<string, unknown>>()
  closed = false
  ontrack: ((ev: unknown) => void) | null = null
  onicecandidate: ((ev: unknown) => void) | null = null
  onicecandidateerror: ((ev: unknown) => void) | null = null
  onicegatheringstatechange: (() => void) | null = null
  onconnectionstatechange: (() => void) | null = null

  constructor(readonly config: unknown) {
    FakePeer.all.push(this)
  }

  addTransceiver(kind: string, init: { direction: string }): void {
    this.transceivers.push({ kind, direction: init.direction })
  }

  createDataChannel(label: string, init?: RTCDataChannelInit): FakeChannel {
    const channel = new FakeChannel(label, init)
    this.channels.push(channel)
    return channel
  }

  async createOffer(): Promise<{ type: string; sdp: string }> {
    return { type: "offer", sdp: `offer-${FakePeer.all.indexOf(this)}` }
  }

  /** Gathering starts here: one candidate, then the end-of-candidates marker. */
  async setLocalDescription(d: { sdp: string }): Promise<void> {
    this.localDescription = { sdp: d.sdp }
    this.onicecandidate?.({ candidate: { candidate: "local-1", sdpMid: "0", sdpMLineIndex: 0 } })
    this.onicecandidate?.({ candidate: null })
  }

  async setRemoteDescription(d: unknown): Promise<void> {
    this.remote = d
  }

  async addIceCandidate(c: unknown): Promise<void> {
    this.remoteCandidates.push(c)
  }

  async getStats(): Promise<Map<string, Record<string, unknown>>> {
    return this.stats
  }

  close(): void {
    this.closed = true
  }

  set(state: string): void {
    this.connectionState = state
    this.onconnectionstatechange?.()
  }

  gather(state: string): void {
    this.iceGatheringState = state
    this.onicegatheringstatechange?.()
  }

  failIce(error: { errorCode: number; url: string; address?: string; port?: number; errorText?: string }): void {
    this.onicecandidateerror?.(error)
  }

  emitTrack(kind: string): void {
    this.ontrack?.({ track: { kind }, receiver: {} })
  }

  channel(label: string): FakeChannel {
    const channel = this.channels.find((c) => c.label === label)
    if (!channel) throw new Error(`no channel ${label}`)
    return channel
  }
}

class FakeStream {
  tracks: unknown[] = []
  addTrack(track: unknown): void {
    this.tracks.push(track)
  }
}

const g = globalThis as unknown as Record<string, unknown>
let clock: FakeClock
let video: HTMLVideoElement

beforeEach(() => {
  FakePeer.all = []
  clock = fakeWindow()
  g.window = clock.api
  g.RTCPeerConnection = FakePeer
  g.MediaStream = FakeStream
  video = { srcObject: null, play: () => Promise.resolve() } as unknown as HTMLVideoElement
})

afterEach(() => {
  delete g.window
  delete g.RTCPeerConnection
  delete g.MediaStream
})

function harness() {
  const sent: DesktopRtcClientMessage[] = []
  const states: RtcState[] = []
  const stats: RtcStats[] = []
  const audio: boolean[] = []
  const diagnostics: RtcDiagnostics[] = []
  const rtc = new DesktopRtc(video, {
    send: (m) => sent.push(m),
    onState: (s) => states.push(s),
    onStats: (s) => stats.push(s),
    onDiagnostics: (d) => diagnostics.push(d),
    onAudio: (a) => audio.push(a),
  })
  return { rtc, sent, states, stats, audio, diagnostics }
}

/** Lets the fake peer's promise chains run. */
async function settle(): Promise<void> {
  for (let i = 0; i < 10; i++) await Promise.resolve()
}

const config: DesktopRtcServerMessage = { _tag: "rtc.config", iceServers: [], iceTransportPolicy: "all" }
const turnConfig: DesktopRtcServerMessage = {
  _tag: "rtc.config",
  iceServers: [{ urls: ["turn:turn.example?transport=udp"], username: "viewer", credential: "secret" }],
  iceTransportPolicy: "all",
}
const unavailable = (retryable: boolean): DesktopRtcServerMessage => ({
  _tag: "rtc.unavailable",
  reason: "viewer limit",
  retryable,
})

/** Offers, is answered, and comes live. */
async function live(rtc: DesktopRtc): Promise<FakePeer> {
  rtc.handle(config)
  await settle()
  rtc.handle({ _tag: "rtc.answer", sdp: "answer" })
  await settle()
  const peer = FakePeer.all[FakePeer.all.length - 1]!
  peer.set("connected")
  return peer
}

describe("signaling", () => {
  test("config starts an offer with recvonly audio and video and both data channels", async () => {
    const h = harness()
    h.rtc.handle(config)
    await settle()
    const peer = FakePeer.all[0]!
    expect(peer.transceivers).toEqual([
      { kind: "video", direction: "recvonly" },
      { kind: "audio", direction: "recvonly" },
    ])
    expect(peer.channel("input").init).toEqual({ ordered: true })
    expect(peer.channel("pointer").init).toEqual({ ordered: false, maxRetransmits: 0 })
    expect(h.sent.map((m) => m._tag)).toEqual(["rtc.offer", "rtc.candidate", "rtc.candidate"])
    expect(h.sent[0]).toEqual({ _tag: "rtc.offer", sdp: "offer-0" })
    expect(h.states).toEqual(["connecting"])
  })

  test("answer and remote candidates apply; connected is live; media and audio arrive", async () => {
    const h = harness()
    const peer = await live(h.rtc)
    expect(peer.remote).toEqual({ type: "answer", sdp: "answer" })
    h.rtc.handle({ _tag: "rtc.candidate", candidate: "remote-1", sdpMid: "0", sdpMLineIndex: 0 })
    h.rtc.handle({ _tag: "rtc.candidate", candidate: null, sdpMid: null, sdpMLineIndex: null })
    await settle()
    expect(peer.remoteCandidates).toEqual([{ candidate: "remote-1", sdpMid: "0", sdpMLineIndex: 0 }])
    expect(h.states).toEqual(["connecting", "live"])
    peer.emitTrack("video")
    peer.emitTrack("audio")
    expect(h.audio).toEqual([true])
  })

  test("candidates arriving before the answer are held until it is applied", async () => {
    const h = harness()
    h.rtc.handle(config)
    await settle()
    h.rtc.handle({ _tag: "rtc.candidate", candidate: "early", sdpMid: "0", sdpMLineIndex: 0 })
    const peer = FakePeer.all[0]!
    expect(peer.remoteCandidates).toEqual([])
    h.rtc.handle({ _tag: "rtc.answer", sdp: "answer" })
    await settle()
    expect(peer.remoteCandidates).toEqual([{ candidate: "early", sdpMid: "0", sdpMLineIndex: 0 }])
  })
})

describe("refusal and retry", () => {
  test("a retryable refusal re-offers after the first retry delay", async () => {
    const h = harness()
    h.rtc.handle(turnConfig)
    await settle()
    h.rtc.handle(unavailable(true))
    expect(FakePeer.all[0]!.closed).toBe(true)
    expect(h.states.at(-1)).toBe("retrying")
    clock.advance(retryDelay(0) - 1)
    expect(FakePeer.all.length).toBe(1)
    clock.advance(1)
    await settle()
    expect(FakePeer.all.length).toBe(2)
    expect(h.sent.filter((m) => m._tag === "rtc.offer").length).toBe(2)
    // A refusal sends no rtc.close: the box has no session.
    expect(h.sent.some((m) => m._tag === "rtc.close")).toBe(false)
  })

  test("a TURN-less refusal asks for a new config instead of re-offering", async () => {
    const h = harness()
    h.rtc.handle(config)
    await settle()
    h.rtc.handle(unavailable(true))
    clock.advance(retryDelay(0))
    expect(h.sent.at(-1)).toEqual({ _tag: "rtc.config.request" })
    expect(FakePeer.all.length).toBe(1)
  })

  test("a non-retryable refusal is unsupported and does not retry", async () => {
    const h = harness()
    h.rtc.handle(config)
    await settle()
    h.rtc.handle(unavailable(false))
    clock.advance(RETRY_MAX_MS * 4)
    expect(FakePeer.all.length).toBe(1)
    expect(h.states.at(-1)).toBe("unsupported")
  })

  test("retry delay doubles from 1 s and stops at 30 s", () => {
    expect([0, 1, 2, 3, 4, 5, 6].map(retryDelay)).toEqual([1_000, 2_000, 4_000, 8_000, 16_000, 30_000, 30_000])
  })

  test("the state stays retrying across attempts until one goes live", async () => {
    const h = harness()
    const peer = await live(h.rtc)
    peer.set("failed")
    clock.advance(retryDelay(0))
    expect(h.sent.at(-1)).toEqual({ _tag: "rtc.config.request" })
    h.rtc.handle(config)
    await settle()
    expect(FakePeer.all.length).toBe(2)
    expect(h.states.at(-1)).toBe("retrying")
    FakePeer.all[1]!.set("connected")
    expect(h.states.at(-1)).toBe("live")
  })

  test("a retry with a stale config asks for a new one, keeps its backoff, and offers with the answer", async () => {
    const h = harness()
    const peer = await live(h.rtc)
    clock.advance(CONFIG_MAX_AGE_MS)
    peer.set("failed")
    clock.advance(retryDelay(0))
    expect(h.sent.at(-1)).toEqual({ _tag: "rtc.config.request" })
    expect(FakePeer.all.length).toBe(1)
    const turn: DesktopRtcServerMessage = {
      _tag: "rtc.config",
      iceServers: [{ urls: ["turn:turn.example"], username: "new", credential: "new" }],
      iceTransportPolicy: "all",
    }
    h.rtc.handle(turn)
    await settle()
    expect(FakePeer.all.length).toBe(2)
    expect(FakePeer.all[1]!.config).toMatchObject({
      iceServers: [{ urls: ["turn:turn.example"], username: "new", credential: "new" }],
    })
    expect(h.states.at(-1)).toBe("retrying")
    // The refreshed config keeps the attempt count: the next failure backs off further and refreshes again.
    FakePeer.all[1]!.set("failed")
    clock.advance(retryDelay(1) - 1)
    expect(h.sent.filter((m) => m._tag === "rtc.config.request").length).toBe(1)
    clock.advance(1)
    expect(h.sent.filter((m) => m._tag === "rtc.config.request").length).toBe(2)
    expect(FakePeer.all.length).toBe(2)
    h.rtc.handle(turn)
    await settle()
    expect(FakePeer.all.length).toBe(3)
  })

  test("a retry with a stale config still offers when the box does not answer", async () => {
    const h = harness()
    const peer = await live(h.rtc)
    clock.advance(CONFIG_MAX_AGE_MS)
    peer.set("failed")
    clock.advance(retryDelay(0) + CONNECT_TIMEOUT_MS)
    await settle()
    expect(FakePeer.all.length).toBe(2)
  })

  test("a connect timeout fails the attempt, closes the box's session, and retries", async () => {
    const h = harness()
    h.rtc.handle(config)
    await settle()
    clock.advance(CONNECT_TIMEOUT_MS)
    expect(h.sent.at(-1)).toEqual({ _tag: "rtc.close" })
    expect(h.states.at(-1)).toBe("retrying")
    clock.advance(retryDelay(0))
    expect(h.sent.at(-1)).toEqual({ _tag: "rtc.config.request" })
    // The box does not answer: the old config is used so the session cannot stall.
    clock.advance(CONNECT_TIMEOUT_MS)
    await settle()
    expect(FakePeer.all.length).toBe(2)
  })

  test("a failed peer connection retries", async () => {
    const h = harness()
    const peer = await live(h.rtc)
    peer.set("failed")
    expect(peer.closed).toBe(true)
    expect(h.sent.at(-1)).toEqual({ _tag: "rtc.close" })
    expect(h.states.at(-1)).toBe("retrying")
  })

  test("a new config while live restarts the session", async () => {
    const h = harness()
    await live(h.rtc)
    h.rtc.handle(config)
    await settle()
    expect(FakePeer.all.length).toBe(2)
    expect(FakePeer.all[0]!.closed).toBe(true)
  })
})

describe("liveness", () => {
  test("a disconnect shorter than the grace period is ridden out", async () => {
    const h = harness()
    const peer = await live(h.rtc)
    peer.set("disconnected")
    clock.advance(DISCONNECT_GRACE_MS - 1)
    expect(h.states.at(-1)).toBe("live")
    peer.set("connected")
    clock.advance(DISCONNECT_GRACE_MS)
    expect(h.states.at(-1)).toBe("live")
  })

  test("a disconnect past the grace period fails the attempt", async () => {
    const h = harness()
    const peer = await live(h.rtc)
    peer.set("disconnected")
    clock.advance(DISCONNECT_GRACE_MS)
    expect(h.states.at(-1)).toBe("retrying")
    expect(peer.closed).toBe(true)
  })

  test("a started video stream that stops decoding and receiving packets fails the session", async () => {
    const h = harness()
    const peer = await live(h.rtc)
    const sampleVideo = async (decoded: number): Promise<void> => {
      peer.stats.set("video", { type: "inbound-rtp", kind: "video", framesDecoded: decoded, lastPacketReceivedTimestamp: decoded })
      clock.advance(STATS_EVERY_MS)
      await settle()
    }
    for (let i = 1; i <= 5; i++) await sampleVideo(i)
    expect(h.states.at(-1)).toBe("live")
    // Three silent one-second samples sit inside PATH_SILENCE_MS (3.5 s); the fourth passes it.
    for (let i = 0; i < 3; i++) await sampleVideo(5)
    expect(h.states.at(-1)).toBe("live")
    await sampleVideo(5)
    expect(h.states.at(-1)).toBe("retrying")
    expect(peer.closed).toBe(true)
  })

  test("a video stream that never started decoding is not judged dead", async () => {
    const h = harness()
    const peer = await live(h.rtc)
    for (let i = 0; i < 10; i++) {
      peer.stats.set("video", { type: "inbound-rtp", kind: "video", framesDecoded: 0, lastPacketReceivedTimestamp: 0 })
      clock.advance(STATS_EVERY_MS)
      await settle()
    }
    expect(h.states.at(-1)).toBe("live")
  })
})

describe("input", () => {
  test("sendInput is false until the input channel opens, then sends JSON", async () => {
    const h = harness()
    const peer = await live(h.rtc)
    const message = { _tag: "text" as const, text: "a" }
    expect(h.rtc.sendInput(message)).toBe(false)
    peer.channel("input").open()
    expect(h.rtc.sendInput(message)).toBe(true)
    expect(peer.channel("input").sent).toEqual([JSON.stringify(message)])
  })

  test("pointer moves use the pointer channel once open, and fall back to input before", async () => {
    const h = harness()
    const peer = await live(h.rtc)
    const move = { _tag: "mouse.move" as const, x: 0.5, y: 0.5 }
    peer.channel("input").open()
    expect(h.rtc.sendInput(move, true)).toBe(true)
    expect(peer.channel("input").sent.length).toBe(1)
    peer.channel("pointer").open()
    expect(h.rtc.sendInput(move, true)).toBe(true)
    expect(peer.channel("pointer").sent).toEqual([JSON.stringify(move)])
    expect(peer.channel("input").sent.length).toBe(1)
  })

  test("close sends rtc.close once and stops retries", async () => {
    const h = harness()
    const peer = await live(h.rtc)
    h.rtc.close()
    expect(peer.closed).toBe(true)
    expect(h.sent.filter((m) => m._tag === "rtc.close").length).toBe(1)
    expect(h.states.at(-1)).toBe("idle")
    clock.advance(RETRY_MAX_MS * 2)
    expect(FakePeer.all.length).toBe(1)
  })
})

describe("diagnostics", () => {
  test("the first snapshot waits for a config", () => {
    const h = harness()
    expect(h.diagnostics).toHaveLength(1)
    expect(h.diagnostics[0]).toEqual({
      attempt: 0,
      config: "waiting",
      turnServers: 0,
      viewerRelayCandidates: 0,
      viewerGathering: "unknown",
      connection: "unknown",
      selectedPair: null,
      videoBytes: null,
      videoPackets: null,
      framesDecoded: null,
      lastFailure: null,
      iceErrors: [],
      box: null,
    })
  })

  test("a box summary before the first config is kept for the first attempt", async () => {
    const h = harness()
    const box: DesktopRtcBoxDiagnostics = {
      turnSource: "managed",
      turnStatus: "unavailable",
      gathering: "idle",
      relayCandidates: 0,
      connection: "new",
      failure: "turn-credentials",
    }
    h.rtc.handle({ _tag: "rtc.diagnostics", diagnostics: box })
    expect(h.diagnostics.at(-1)!.box).toEqual(box)
    h.rtc.handle(turnConfig)
    await settle()
    expect(h.diagnostics.at(-1)!.attempt).toBe(1)
    expect(h.diagnostics.at(-1)!.box).toEqual(box)
  })

  test("turnServers counts credential-bearing TURN entries, not URLs", async () => {
    const h = harness()
    h.rtc.handle({
      _tag: "rtc.config",
      iceServers: [
        { urls: ["turn:one.example?transport=udp", "turns:two.example?transport=tcp"], username: "u", credential: "c" },
        { urls: ["stun:stun.example"] },
        { urls: ["turn:no-auth.example"] },
        { urls: ["turn:partial.example"], username: "u" },
      ],
      iceTransportPolicy: "all",
    })
    await settle()
    expect(h.diagnostics.at(-1)!.turnServers).toBe(1)
    expect(h.diagnostics.at(-1)!.config).toBe("ready")
  })

  test("the attempt counter counts negotiations, not retry backoff", async () => {
    const h = harness()
    const peer = await live(h.rtc)
    expect(h.diagnostics.at(-1)!.attempt).toBe(1)
    peer.set("failed")
    expect(h.diagnostics.at(-1)!.attempt).toBe(1)
    clock.advance(retryDelay(0))
    h.rtc.handle(turnConfig)
    await settle()
    expect(h.diagnostics.at(-1)!.attempt).toBe(2)
  })

  test("a retry shows its previous failure during backoff, then clears it for the new attempt", async () => {
    const h = harness()
    h.rtc.handle(turnConfig)
    await settle()
    FakePeer.all[0]!.set("failed")
    // scheduleRetry publishes before the timer: the cause stays visible while waiting.
    expect(diagnosticSummary(h.diagnostics.at(-1)!)).toBe("WebRTC did not connect. Candidate gathering alone does not prove a working path.")
    clock.advance(retryDelay(0))
    await settle()
    expect(h.diagnostics.at(-1)!.lastFailure).toBeNull()
    expect(h.diagnostics.at(-1)!.config).toBe("refreshing")
    expect(diagnosticSummary(h.diagnostics.at(-1)!)).toBe("Refreshing connection settings before retrying.")
    h.rtc.handle(turnConfig)
    await settle()
    expect(h.diagnostics.at(-1)!.config).toBe("ready")
    expect(diagnosticSummary(h.diagnostics.at(-1)!)).toBe("Gathering candidates and negotiating the connection.")
  })

  test("inbound video and the selected pair are monitored during negotiation", async () => {
    const h = harness()
    h.rtc.handle(config)
    await settle()
    const peer = FakePeer.all[0]!
    peer.stats.set("v", {
      type: "inbound-rtp",
      kind: "video",
      bytesReceived: 1_000,
      packetsReceived: 8,
      framesDecoded: 2,
    })
    peer.stats.set("pair", {
      id: "pair",
      type: "candidate-pair",
      state: "succeeded",
      nominated: true,
      localCandidateId: "L",
      remoteCandidateId: "R",
      currentRoundTripTime: 0.05,
    })
    peer.stats.set("L", { id: "L", type: "local-candidate", candidateType: "host", protocol: "udp" })
    peer.stats.set("R", { id: "R", type: "remote-candidate", candidateType: "relay", protocol: "udp" })
    clock.advance(STATS_EVERY_MS)
    await settle()
    const diagnostics = h.diagnostics.at(-1)!
    expect(diagnostics.connection).toBe("new")
    expect(diagnostics.framesDecoded).toBe(2)
    expect(diagnostics.videoBytes).toBe(1_000)
    expect(diagnostics.videoPackets).toBe(8)
    expect(diagnostics.selectedPair).toEqual({ local: "host", remote: "relay", protocol: "udp", relayProtocol: "unknown" })
    // A relay on either end is a relay path, even when only the box's candidate is relayed.
    expect(h.stats.at(-1)?.path).toBe("relay")
  })

  test("media counters are unknown until reported, and explicit zeros are kept", async () => {
    const h = harness()
    h.rtc.handle(config)
    await settle()
    const peer = FakePeer.all[0]!
    clock.advance(STATS_EVERY_MS)
    await settle()
    expect(h.diagnostics.at(-1)!.videoBytes).toBeNull()
    expect(h.diagnostics.at(-1)!.videoPackets).toBeNull()
    expect(h.diagnostics.at(-1)!.framesDecoded).toBeNull()
    peer.stats.set("v", {
      type: "inbound-rtp",
      mediaType: "video",
      bytesReceived: 0,
      packetsReceived: 0,
      framesDecoded: 0,
    })
    clock.advance(STATS_EVERY_MS)
    await settle()
    const reported = h.diagnostics.at(-1)!
    expect(reported.videoBytes).toBe(0)
    expect(reported.videoPackets).toBe(0)
    expect(reported.framesDecoded).toBe(0)
  })

  test("gathering and connection states come from the peer connection", async () => {
    const h = harness()
    h.rtc.handle(config)
    await settle()
    const peer = FakePeer.all[0]!
    peer.gather("gathering")
    expect(h.diagnostics.at(-1)!.viewerGathering).toBe("gathering")
    expect(h.diagnostics.at(-1)!.connection).toBe("new")
    peer.gather("complete")
    expect(h.diagnostics.at(-1)!.viewerGathering).toBe("complete")
  })

  test("box snapshots are copied, kept through backoff, and cleared for a new attempt", async () => {
    const h = harness()
    const peer = await live(h.rtc)
    const box: DesktopRtcBoxDiagnostics = {
      turnSource: "managed",
      turnStatus: "configured",
      gathering: "complete",
      relayCandidates: 2,
      connection: "connected",
      failure: null,
    }
    h.rtc.handle({ _tag: "rtc.diagnostics", diagnostics: box })
    expect(h.diagnostics.at(-1)!.box).toEqual(box)
    expect(h.diagnostics.at(-1)!.box).not.toBe(box)
    peer.set("failed")
    expect(h.diagnostics.at(-1)!.box).toEqual(box)
    expect(h.diagnostics.at(-1)!.lastFailure).toBe("connection")
    // A late snapshot cannot overwrite the failed attempt's evidence: no peer connection owns it.
    h.rtc.handle({
      _tag: "rtc.diagnostics",
      diagnostics: { ...box, connection: "failed", failure: "connection-timeout" },
    })
    expect(h.diagnostics.at(-1)!.box).toEqual(box)
    clock.advance(retryDelay(0))
    h.rtc.handle(turnConfig)
    await settle()
    const next = h.diagnostics.at(-1)!
    expect(next.attempt).toBe(2)
    expect(next.box).toBeNull()
    expect(next.lastFailure).toBeNull()
  })

  test("a box summary sent just before a config belongs to the new attempt", async () => {
    const h = harness()
    const peer = await live(h.rtc)
    peer.set("failed")
    clock.advance(retryDelay(0))
    expect(h.sent.at(-1)).toEqual({ _tag: "rtc.config.request" })
    const box: DesktopRtcBoxDiagnostics = {
      turnSource: "managed",
      turnStatus: "configured",
      gathering: "idle",
      relayCandidates: 0,
      connection: "new",
      failure: "turn-credentials",
    }
    h.rtc.handle({ _tag: "rtc.diagnostics", diagnostics: box })
    expect(h.diagnostics.at(-1)!.box).toEqual(box)
    h.rtc.handle(turnConfig)
    await settle()
    const next = h.diagnostics.at(-1)!
    expect(next.attempt).toBe(2)
    expect(next.box).toEqual(box)
  })

  test("candidate errors keep only numeric codes and scheme/transport, unique and bounded", async () => {
    const h = harness()
    const peer = await live(h.rtc)
    peer.failIce({
      errorCode: 701,
      url: "turn:relay.example:3478?transport=udp",
      address: "198.51.100.4",
      port: 3478,
      errorText: "secret failure",
    })
    peer.failIce({ errorCode: 701, url: "turn:relay.example:3478?transport=udp", address: "198.51.100.4" })
    peer.failIce({ errorCode: 701, url: "turn:relay.example:3478?transport=tcp" })
    peer.failIce({ errorCode: 702, url: "stun:stun.example" })
    peer.failIce({ errorCode: 703, url: "turns:secure.example?transport=tcp" })
    peer.failIce({ errorCode: 704, url: "turn:extra.example" })
    const diagnostics = h.diagnostics.at(-1)!
    expect(diagnostics.iceErrors).toEqual([
      { code: 701, transport: "turn-udp" },
      { code: 701, transport: "turn-tcp" },
      { code: 702, transport: "stun" },
      { code: 703, transport: "turn-tls" },
    ])
    const text = JSON.stringify(diagnostics)
    for (const leaked of ["198.51.100.4", "relay.example", "stun.example", "secure.example", "secret failure"]) {
      expect(text).not.toContain(leaked)
    }
  })

  test("a TURN-less failure refreshes credentials after its backoff", async () => {
    const h = harness()
    const peer = await live(h.rtc)
    const settled = h.diagnostics.at(-1)!
    peer.set("failed")
    const failed = h.diagnostics.at(-1)!
    expect(failed.config).toBe("ready")
    expect(failed.connection).toBe("failed")
    expect(failed.lastFailure).toBe("connection")
    expect(failed.attempt).toBe(settled.attempt)
    clock.advance(retryDelay(0) - 1)
    expect(h.sent.some((m) => m._tag === "rtc.config.request")).toBe(false)
    clock.advance(1)
    expect(h.sent.at(-1)).toEqual({ _tag: "rtc.config.request" })
    expect(h.diagnostics.at(-1)!.config).toBe("refreshing")
    expect(FakePeer.all.length).toBe(1)
  })

  test("refreshed credentials are used and the session recovers live", async () => {
    const h = harness()
    const peer = await live(h.rtc)
    peer.set("failed")
    clock.advance(retryDelay(0))
    const fresh: DesktopRtcServerMessage = {
      _tag: "rtc.config",
      iceServers: [{ urls: ["turns:fresh.example?transport=tcp"], username: "fresh", credential: "fresh-secret" }],
      iceTransportPolicy: "all",
    }
    h.rtc.handle(fresh)
    await settle()
    expect(FakePeer.all.length).toBe(2)
    expect(FakePeer.all[1]!.config).toMatchObject({
      iceServers: [{ urls: ["turns:fresh.example?transport=tcp"], username: "fresh" }],
    })
    expect(h.diagnostics.at(-1)!.turnServers).toBe(1)
    expect(h.diagnostics.at(-1)!.config).toBe("ready")
    h.rtc.handle({ _tag: "rtc.answer", sdp: "answer" })
    await settle()
    const second = FakePeer.all[1]!
    second.set("connected")
    second.emitTrack("video")
    second.stats.set("v", {
      type: "inbound-rtp",
      kind: "video",
      bytesReceived: 2_048,
      packetsReceived: 20,
      framesDecoded: 7,
    })
    clock.advance(STATS_EVERY_MS)
    await settle()
    expect(h.states.at(-1)).toBe("live")
    expect(h.diagnostics.at(-1)!.videoBytes).toBe(2_048)
    // The new attempt is described by its own evidence; the earlier failure was visible during its backoff.
    expect(h.diagnostics.at(-1)!.lastFailure).toBeNull()
  })

  test("repeated failures keep the exponential backoff", async () => {
    const h = harness()
    const first = await live(h.rtc)
    first.set("failed")
    clock.advance(retryDelay(0))
    h.rtc.handle(turnConfig)
    await settle()
    FakePeer.all[1]!.set("failed")
    clock.advance(retryDelay(1) - 1)
    expect(h.sent.filter((m) => m._tag === "rtc.config.request").length).toBe(1)
    clock.advance(1)
    expect(h.sent.filter((m) => m._tag === "rtc.config.request").length).toBe(2)
  })

  test("a config arriving after the fallback deadline does not reset consecutive-failure backoff", async () => {
    const h = harness()
    const first = await live(h.rtc)
    first.set("failed")
    clock.advance(retryDelay(0))
    clock.advance(CONNECT_TIMEOUT_MS)
    await settle()
    FakePeer.all.at(-1)!.set("failed")
    // The earlier refresh finally arrives while a later failed attempt is backing off.
    h.rtc.handle(turnConfig)
    await settle()
    FakePeer.all.at(-1)!.set("failed")
    const requested = h.sent.filter((message) => message._tag === "rtc.config.request").length
    clock.advance(retryDelay(2) - 1)
    expect(h.sent.filter((message) => message._tag === "rtc.config.request").length).toBe(requested)
    clock.advance(1)
    expect(h.sent.filter((message) => message._tag === "rtc.config.request").length).toBe(requested + 1)
  })

  test("a hung sample from a replaced peer cannot stop the new peer's diagnostics", async () => {
    const h = harness()
    const first = await live(h.rtc)
    const pending = Promise.withResolvers<Map<string, Record<string, unknown>>>()
    first.getStats = () => pending.promise
    clock.advance(STATS_EVERY_MS)
    first.set("failed")
    clock.advance(retryDelay(0))
    h.rtc.handle(turnConfig)
    await settle()
    const next = FakePeer.all.at(-1)!
    next.stats.set("video", { type: "inbound-rtp", kind: "video", bytesReceived: 123_456, packetsReceived: 70, framesDecoded: 7 })
    try {
      clock.advance(STATS_EVERY_MS)
      await settle()
      expect(h.diagnostics.at(-1)!.videoBytes).toBe(123_456)
      pending.resolve(new Map([["old", { type: "inbound-rtp", kind: "video", bytesReceived: 99, framesDecoded: 1 }]]))
      await settle()
      expect(h.diagnostics.at(-1)!.videoBytes).toBe(123_456)
    } finally {
      pending.resolve(new Map())
      h.rtc.close()
      await settle()
    }
  })

  test("rejected peer configuration reports negotiation failure and recovers with fresh settings", async () => {
    const h = harness()
    g.RTCPeerConnection = class {
      constructor() { throw new Error("invalid ICE configuration with private details") }
    }
    h.rtc.handle(config)
    expect(h.diagnostics.at(-1)!.lastFailure).toBe("negotiation")
    clock.advance(retryDelay(0))
    expect(h.sent.at(-1)).toEqual({ _tag: "rtc.config.request" })
    g.RTCPeerConnection = FakePeer
    h.rtc.handle(turnConfig)
    await settle()
    FakePeer.all.at(-1)!.set("connected")
    expect(h.diagnostics.at(-1)!.connection).toBe("connected")
  })

  test("a stats snapshot from a dropped attempt is ignored", async () => {
    const h = harness()
    const peer = await live(h.rtc)
    const gates: Array<(report: Map<string, Record<string, unknown>>) => void> = []
    peer.getStats = () => {
      const { promise, resolve } = Promise.withResolvers<Map<string, Record<string, unknown>>>()
      gates.push(resolve)
      return promise
    }
    clock.advance(STATS_EVERY_MS)
    const samples = h.stats.length
    const snapshots = h.diagnostics.length
    h.rtc.close()
    gates[0]!(new Map([["v", { type: "inbound-rtp", kind: "video", bytesReceived: 9, framesDecoded: 9 }]]))
    await settle()
    expect(h.stats.length).toBe(samples)
    expect(h.diagnostics.length).toBe(snapshots)
  })

  test("a closed session never requests a config", async () => {
    const h = harness()
    const peer = await live(h.rtc)
    peer.set("failed")
    h.rtc.close()
    clock.advance(RETRY_MAX_MS * 4)
    expect(h.sent.some((m) => m._tag === "rtc.config.request")).toBe(false)
    expect(FakePeer.all.length).toBe(1)
  })

  test("a rejected video.play is a playback failure, not a disconnect", async () => {
    video = { srcObject: null, play: () => Promise.reject(new Error("blocked")) } as unknown as HTMLVideoElement
    const h = harness()
    const peer = await live(h.rtc)
    peer.emitTrack("video")
    await settle()
    expect(h.diagnostics.at(-1)!.lastFailure).toBe("playback")
    expect(h.states.at(-1)).toBe("live")
  })

  test("a play() aborted by teardown keeps the connection failure", async () => {
    const aborts: Array<(reason: unknown) => void> = []
    video = {
      srcObject: null,
      play: () => {
        const { promise, reject } = Promise.withResolvers<void>()
        aborts.push(reject)
        return promise
      },
    } as unknown as HTMLVideoElement
    const h = harness()
    const peer = await live(h.rtc)
    peer.emitTrack("video")
    expect(aborts).toHaveLength(1)
    peer.set("failed")
    expect(h.diagnostics.at(-1)!.lastFailure).toBe("connection")
    aborts[0]!({ name: "AbortError" })
    await settle()
    expect(h.diagnostics.at(-1)!.lastFailure).toBe("connection")
  })
})

describe("measure", () => {
  const base = (): Record<string, Record<string, unknown>> => ({
    v: { type: "inbound-rtp", kind: "video", framesPerSecond: 30, framesDecoded: 20, totalDecodeTime: 0.3 },
    pair: {
      id: "pair",
      type: "candidate-pair",
      state: "succeeded",
      nominated: true,
      localCandidateId: "L",
      currentRoundTripTime: 0.02,
    },
    L: { id: "L", type: "local-candidate", candidateType: "relay" },
  })
  const reports = (entries: Record<string, Record<string, unknown>>) =>
    Object.values(entries)

  test("fps, rtt, and relay path come from the report", () => {
    const { stats, counters } = measure(reports(base()), null)
    expect(stats).toEqual({ fps: 30, decodeMs: null, jitterMs: null, rttMs: 20, path: "relay" })
    expect(counters).toEqual({ frames: 20, decodeS: 0.3, emitted: 0, jitterS: 0 })
  })

  test("decode and jitter are the change since the previous sample", () => {
    const prev: Counters = { frames: 10, decodeS: 0.1, emitted: 10, jitterS: 0.05 }
    const entries = base()
    entries.v = {
      ...entries.v!,
      jitterBufferEmittedCount: 20,
      jitterBufferDelay: 0.15,
    }
    const { stats } = measure(reports(entries), prev)
    expect(stats.decodeMs).toBeCloseTo(20)
    expect(stats.jitterMs).toBeCloseTo(10)
  })

  test("a direct candidate pair needs both ends known and non-relay", () => {
    const entries = base()
    entries.pair!.remoteCandidateId = "R"
    entries.L = { id: "L", type: "local-candidate", candidateType: "host", protocol: "udp" }
    entries.R = { id: "R", type: "remote-candidate", candidateType: "srflx", protocol: "udp" }
    expect(measure(reports(entries), null).stats.path).toBe("direct")
  })

  test("a missing remote candidate is not confidently labelled direct", () => {
    const entries = base()
    entries.L = { id: "L", type: "local-candidate", candidateType: "host" }
    expect(measure(reports(entries), null).stats.path).toBeNull()
  })

  test("a relay remote candidate alone labels the path as relay", () => {
    const entries = base()
    entries.pair!.remoteCandidateId = "R"
    entries.L = { id: "L", type: "local-candidate", candidateType: "host", protocol: "udp" }
    entries.R = { id: "R", type: "remote-candidate", candidateType: "relay", protocol: "udp" }
    expect(measure(reports(entries), null).stats.path).toBe("relay")
  })
})
