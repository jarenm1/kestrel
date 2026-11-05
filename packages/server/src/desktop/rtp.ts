/**
 * The desktop's H.264 as RTP: access units from the box's encoder (`flv.ts` demuxes them), packetized per RFC 6184
 * (single NAL unit packets and FU-A, packetization-mode 1), and sent paced to one viewer.
 *
 * All viewers share one encoder, which cannot make a keyframe on request. A joiner, or a viewer whose decoder lost
 * track, gets the current GOP again instead (see `RtpVideoSender`).
 */

/** Payload bytes per RTP packet: fits a 1280-byte path MTU with IP, UDP, SRTP, RTP and TURN overhead. */
export const RTP_PAYLOAD_BYTES = 1100
/** The H.264 RTP clock. */
const RTP_CLOCK_PER_MS = 90
/** Pacing rate on a clean path; the encoder itself tops out at 20 Mbit/s. */
const MAX_PACING_BPS = 100_000_000
const INITIAL_PACING_BPS = 50_000_000
/** Keeps a stream of the lowest quality moving on a poor path. */
const MIN_PACING_BPS = 4_000_000
/** Receiver-reported loss (0-1) that slows pacing, and the loss under which it recovers. */
const LOSS_HIGH = 0.05
const LOSS_LOW = 0.01
/** A frame after a quiet moment goes out at once up to this many bytes. Past it, packets wait their turn. */
const BURST_BYTES = 128 * 1024
const PACE_TICK_MS = 5
/** Past this much queued media the viewer cannot catch up: drop it and wait for a keyframe. */
const MAX_QUEUE_MS = 1000
/** A GOP over this is not replayed: the viewer waits for the next keyframe. */
const MAX_REPLAY_BYTES = 4 * 1024 * 1024
/** Browsers repeat PLI until a keyframe arrives; each replay already answers all of those. */
const REPLAY_INTERVAL_MS = 1000
/** Replays may take at most 1/REPLAY_BUDGET_SHARE of the pacing rate: a decoder in trouble is often on a path in trouble. */
const REPLAY_BUDGET_SHARE = 4
/** Replayed frames are spaced this far apart on the RTP clock, so the decoder takes them as fast as they arrive. */
const REPLAY_FRAME_TICKS = RTP_CLOCK_PER_MS

const NAL_TYPE_MASK = 0x1f
const NAL_AUD = 9
const NAL_FU_A = 28
const FU_START = 0x80
const FU_END = 0x40

/** AVCProfileIndication of Constrained Baseline (profile_idc 66). */
export const AVC_PROFILE_BASELINE = 66

/** One stream's parameter sets, the profile, and the size of the NAL length prefix in its access units. */
export interface AvcConfig {
  readonly profileIdc: number
  readonly nals: ReadonlyArray<Uint8Array>
  readonly lengthBytes: number
}

/** What the encoder produces, as the viewer's RTP side takes it. `au` is an AVCC access unit owned by the receiver. */
export type H264Unit =
  | { readonly kind: "config"; readonly config: AvcConfig }
  | { readonly kind: "key" | "delta"; readonly au: Uint8Array }

/** The SPS and PPS of an avcC record. */
export const parseAvcConfig = (avcc: Uint8Array): AvcConfig => {
  if (avcc.length < 7) throw new Error("H.264 avcC record is truncated")
  const nals: Uint8Array[] = []
  let at = 6
  const readSets = (count: number) => {
    for (let i = 0; i < count; i++) {
      if (at + 2 > avcc.length) throw new Error("H.264 avcC record is truncated")
      const size = (avcc[at]! << 8) | avcc[at + 1]!
      at += 2
      if (at + size > avcc.length) throw new Error("H.264 avcC record is truncated")
      nals.push(avcc.subarray(at, at + size))
      at += size
    }
  }
  readSets(avcc[5]! & 0x1f)
  if (at >= avcc.length) throw new Error("H.264 avcC record is truncated")
  const ppsCount = avcc[at]!
  at += 1
  readSets(ppsCount)
  return { profileIdc: avcc[1]!, nals, lengthBytes: (avcc[4]! & 0x03) + 1 }
}

/** The NAL units of an AVCC access unit, without the delimiters a packet stream does not need. */
export const sampleNals = (sample: Uint8Array, lengthBytes: number): Uint8Array[] => {
  const nals: Uint8Array[] = []
  let at = 0
  while (at + lengthBytes <= sample.length) {
    let size = 0
    for (let i = 0; i < lengthBytes; i++) size = size * 256 + sample[at + i]!
    at += lengthBytes
    if (size === 0 || at + size > sample.length) throw new Error("H.264 sample has a bad NAL length")
    const nal = sample.subarray(at, at + size)
    if ((nal[0]! & NAL_TYPE_MASK) !== NAL_AUD) nals.push(nal)
    at += size
  }
  return nals
}

export interface RtpPayload {
  readonly payload: Uint8Array
  /** Last packet of the access unit. */
  readonly marker: boolean
}

/** One access unit as RTP payloads, in order. */
export const packetizeH264 = (nals: ReadonlyArray<Uint8Array>, maxPayload = RTP_PAYLOAD_BYTES): RtpPayload[] => {
  const packets: RtpPayload[] = []
  nals.forEach((nal, index) => {
    const lastNal = index === nals.length - 1
    if (nal.length <= maxPayload) {
      packets.push({ payload: nal, marker: lastNal })
      return
    }
    const header = nal[0]!
    const chunk = maxPayload - 2
    for (let at = 1; at < nal.length; at += chunk) {
      const end = Math.min(at + chunk, nal.length)
      const payload = new Uint8Array(end - at + 2)
      payload[0] = (header & 0xe0) | NAL_FU_A
      payload[1] = (at === 1 ? FU_START : 0) | (end === nal.length ? FU_END : 0) | (header & NAL_TYPE_MASK)
      payload.set(nal.subarray(at, end), 2)
      packets.push({ payload, marker: lastNal && end === nal.length })
    }
  })
  return packets
}

/** What one viewer needs to catch up: the stream's parameter sets and the access units of the current GOP. */
export class MediaTap {
  config: AvcConfig | null = null
  /** Keyframe first; null until a keyframe, or once it would be over MAX_REPLAY_BYTES. */
  gop: Uint8Array[] | null = null
  gopBytes = 0

  push(unit: H264Unit): void {
    if (unit.kind === "config") {
      this.config = unit.config
      this.gop = null
      this.gopBytes = 0
      return
    }
    if (unit.kind === "key") {
      this.gop = [unit.au]
      this.gopBytes = unit.au.length
      return
    }
    if (this.gop === null) return
    this.gopBytes += unit.au.length
    if (this.gopBytes > MAX_REPLAY_BYTES) {
      this.gop = null
      this.gopBytes = 0
      return
    }
    this.gop.push(unit.au)
  }
}

interface QueuedPacket extends RtpPayload {
  readonly timestamp: number
}

/** What a sender needs from its world; real time and a real peer connection outside tests. */
export interface RtpOutput {
  readonly write: (payload: Uint8Array, marker: boolean, timestamp: number) => void
  readonly now: () => number
  readonly setTimer: (run: () => void, ms: number) => () => void
}

/**
 * One viewer's video: turns the encoder's access units into paced RTP. Timestamps follow when a frame is sent rather
 * than when it was captured, because the stream is variable-rate and any encoder delay should not look like network
 * jitter to the browser's playout. Nothing is sent until `start`; the first thing sent is then a keyframe, from the
 * replayed GOP or else the next one the encoder makes.
 */
export class RtpVideoSender {
  private started = false
  /** Deltas are useless to the decoder until a keyframe arrives. */
  private awaitingKey = true
  private readonly queue: QueuedPacket[] = []
  private queueHead = 0
  private queuedBytes = 0
  private tokens = BURST_BYTES
  private refilledAt: number
  private rateBps = INITIAL_PACING_BPS
  private cancelTimer: (() => void) | null = null
  private timestamp = 0
  private readonly epoch: number
  private nextReplayAt = Number.NEGATIVE_INFINITY

  constructor(
    private readonly tap: MediaTap,
    private readonly output: RtpOutput,
    private readonly debug: (message: string) => void,
    /** The viewer's payload is Constrained Baseline: a High GOP left in the tap by an earlier encoder is not replayed to it. */
    private readonly baselineOnly: boolean,
  ) {
    this.epoch = output.now()
    this.refilledAt = this.epoch
  }

  /** The peer is connected: brings the viewer to live. */
  start(): void {
    if (this.started) return
    this.started = true
    this.replay()
  }

  /** A unit from the encoder, already recorded in the tap. */
  push(unit: H264Unit): void {
    if (unit.kind === "config") {
      this.awaitingKey = true
      return
    }
    if (!this.started) return
    if (unit.kind === "key") this.awaitingKey = false
    if (this.awaitingKey) return
    this.enqueueFrame(unit.au, unit.kind === "key", this.liveTimestamp())
    this.drain()
    if (this.queuedMs() > MAX_QUEUE_MS) {
      this.debug(`webrtc viewer over ${MAX_QUEUE_MS} ms behind at ${Math.round(this.rateBps / 1e6)} Mbit/s; dropping to the next keyframe`)
      this.clearQueue()
      this.awaitingKey = true
    }
  }

  /** The browser's decoder needs a keyframe (PLI or FIR). */
  requestKeyframe(): void {
    if (this.started) this.replay()
  }

  /** A receiver report: fraction of packets lost (0-1) since the last one. */
  reportLoss(fraction: number): void {
    if (fraction > LOSS_HIGH) this.rateBps = Math.max(MIN_PACING_BPS, this.rateBps * 0.8)
    else if (fraction < LOSS_LOW) this.rateBps = Math.min(MAX_PACING_BPS, this.rateBps * 1.05)
  }

  get pacingBps(): number {
    return this.rateBps
  }

  close(): void {
    this.cancelTimer?.()
    this.cancelTimer = null
    this.clearQueue()
    this.started = false
  }

  private replay(): void {
    const now = this.output.now()
    if (now < this.nextReplayAt) return
    const gop = this.tap.gop
    const config = this.tap.config
    // Without a GOP, the next keyframe does it. A Baseline-only viewer also waits for one from a Baseline stream.
    if (gop === null || config === null || (this.baselineOnly && config.profileIdc !== AVC_PROFILE_BASELINE)) return
    const sendMs = (this.tap.gopBytes * 8000) / this.rateBps
    this.nextReplayAt = now + Math.max(REPLAY_INTERVAL_MS, sendMs * REPLAY_BUDGET_SHARE)
    this.clearQueue()
    this.awaitingKey = false
    gop.forEach((au, index) => {
      this.timestamp = (index === 0 ? this.liveTimestamp() : this.timestamp + REPLAY_FRAME_TICKS) % 2 ** 32
      this.enqueueFrame(au, index === 0, this.timestamp)
    })
    this.drain()
  }

  /** The send clock, never going back past a replay that ran ahead of it. */
  private liveTimestamp(): number {
    const clock = Math.round((this.output.now() - this.epoch) * RTP_CLOCK_PER_MS) % 2 ** 32
    const next = clock > this.timestamp ? clock : (this.timestamp + 1) % 2 ** 32
    this.timestamp = next
    return next
  }

  private enqueueFrame(au: Uint8Array, keyframe: boolean, timestamp: number): void {
    const config = this.tap.config
    if (config === null) return
    const nals = sampleNals(au, config.lengthBytes)
    // The encoder's stream has its parameter sets out of band; RTP has to carry them before every keyframe.
    const unit = keyframe ? [...config.nals, ...nals] : nals
    for (const packet of packetizeH264(unit)) {
      this.queue.push({ ...packet, timestamp })
      this.queuedBytes += packet.payload.length
    }
  }

  private drain(): void {
    const now = this.output.now()
    this.tokens = Math.min(BURST_BYTES, this.tokens + ((now - this.refilledAt) * this.rateBps) / 8000)
    this.refilledAt = now
    while (this.queueHead < this.queue.length && this.tokens > 0) {
      const packet = this.queue[this.queueHead]!
      this.queueHead += 1
      this.tokens -= packet.payload.length
      this.queuedBytes -= packet.payload.length
      this.output.write(packet.payload, packet.marker, packet.timestamp)
    }
    if (this.queueHead === this.queue.length) {
      this.queue.length = 0
      this.queueHead = 0
      return
    }
    if (this.cancelTimer === null) {
      this.cancelTimer = this.output.setTimer(() => {
        this.cancelTimer = null
        this.drain()
      }, PACE_TICK_MS)
    }
  }

  private queuedMs(): number {
    return (this.queuedBytes * 8000) / this.rateBps
  }

  private clearQueue(): void {
    this.queue.length = 0
    this.queueHead = 0
    this.queuedBytes = 0
    this.cancelTimer?.()
    this.cancelTimer = null
  }
}
