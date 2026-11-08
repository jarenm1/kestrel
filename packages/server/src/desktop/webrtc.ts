/**
 * One viewer's WebRTC session, negotiated over its authenticated desktop WebSocket (`http/streams.ts`): sendonly H.264
 * video and Opus audio from the box, and the `input` and `pointer` data channels from the viewer. Nothing here is on
 * the Kestrel control plane's path.
 */
import { createHmac } from "node:crypto"
import {
  MediaStreamTrack,
  RTCPeerConnection,
  RTCRtpCodecParameters,
  RTCRtpHeaderExtensionParameters,
  RtpHeader,
  RtpPacket,
  parseMessage,
  type Protocol,
  useFIR,
  useNACK,
  usePLI,
} from "werift"
import { type DesktopRtcIceServer, type DesktopRtcServerMessage } from "@cloudagents/protocol"
import { type H264Unit, MediaTap, RtpVideoSender } from "./rtp"

export interface WebRtcSettings {
  /** STUN/TURN servers given to the box and every viewer. Static TURN credentials are thus visible to the viewer. */
  readonly iceServers: ReadonlyArray<DesktopRtcIceServer>
  /** coturn-style `use-auth-secret`: the secret stays here, viewers get credentials minted per session. */
  readonly turn: { readonly urls: ReadonlyArray<string>; readonly secret: string } | null
  /** `relay`: viewers only ever send through TURN. The box still offers its own candidates for the relay to reach. */
  readonly policy: "all" | "relay"
  /** UDP ports for ICE, for a firewall to open. Null: any. */
  readonly portRange: readonly [number, number] | null
  /** Addresses ICE does not find on its own, such as a tailnet or WireGuard address, or loopback in tests. */
  readonly hostAddresses: ReadonlyArray<string>
  /** A shared managed box must not probe private networks on behalf of viewers. */
  readonly denyPrivate: boolean
}

/** Session credentials outlive any reasonable viewing; a viewer retrying on an old config asks for a new one (`rtc.config.request`). */
export const TURN_CREDENTIAL_TTL_S = 60 * 60
/** Peers a box carries; past it viewers are told to retry later. Each one spends box CPU on encryption. */
const MAX_PEERS = 16
/** A peer that has not connected by now is closed. Above the client's own timeout, so the client gives up first. */
const CONNECT_TIMEOUT_MS = 30_000
/**
 * Seconds the TCP/TLS connect of the control plane's relay may take; werift's default is eight. Managed allocations use
 * TLS/443 directly, without waiting for a failed UDP allocation first. Operator-configured TURN keeps the default.
 */
const TURN_TCP_CONNECT_TIMEOUT_S = 2
/** The control plane requires this endpoint in managed credentials; werift only uses the first TURN URL. */
const MANAGED_TURN_TLS = /^turns:(?:\[[^\]]+\]|[^:/?#]+):443\?transport=tcp$/i
const MAX_OFFER_CHARS = 64 * 1024
const INPUT_CHANNEL = "input"
const POINTER_CHANNEL = "pointer"
const PLAYOUT_DELAY_URI = "http://www.webrtc.org/experiments/rtp-hdrext/playout-delay"
/** Playout delay of 0 ms minimum and maximum (two 12-bit fields): the browser renders each frame on arrival. */
const PLAYOUT_DELAY_ZERO = Buffer.alloc(3)
/**
 * H.264 profile-level-id prefixes the box answers, in preference order: profile_idc and constraint flags, level ignored.
 * High 4:2:0 comes first (640c, 6400, f400), so a browser that offers it is answered with the stream the box encodes by
 * default; Constrained Baseline (42xx) is answered only when nothing else is offered, and makes the encoder Baseline.
 */
const H264_PROFILES: readonly { readonly prefix: string; readonly baselineOnly: boolean }[] = [
  { prefix: "640c", baselineOnly: false },
  { prefix: "6400", baselineOnly: false },
  { prefix: "f400", baselineOnly: false },
  { prefix: "42e0", baselineOnly: true },
  { prefix: "42c0", baselineOnly: true },
  { prefix: "4200", baselineOnly: true },
]

let peers = 0

/** The ICE servers one viewer may use: static ones, and short-lived credentials for the box's TURN, scoped to its thread. */
export const mintIceServers = (
  settings: WebRtcSettings,
  taskId: string,
  nowSeconds = Math.floor(Date.now() / 1000),
): DesktopRtcIceServer[] => {
  if (settings.turn === null) return [...settings.iceServers]
  const username = `${nowSeconds + TURN_CREDENTIAL_TTL_S}:${taskId}`
  const credential = createHmac("sha1", settings.turn.secret).update(username).digest("base64")
  return [...settings.iceServers, { urls: [...settings.turn.urls], username, credential }]
}

/**
 * The H.264 format to answer with, or null when the offer has no usable format. Only packetization-mode 1 qualifies, and
 * only a profile the box encodes: H264_PROFILES in preference order. `baselineOnly` marks Constrained Baseline, which the
 * encoder then stays on while this viewer is connected. The level is not compared, so a browser offering level 3.1 gets
 * the box's level 4.0 stream; the answer echoes the offered fmtp verbatim.
 */
export const pickH264Format = (sdp: string): { readonly fmtp: string; readonly baselineOnly: boolean } | null => {
  const formats: { rank: number; fmtp: string; baselineOnly: boolean }[] = []
  for (const [, payloadType] of sdp.matchAll(/^a=rtpmap:(\d+) H264\/90000/gim)) {
    const fmtp = new RegExp(`^a=fmtp:${payloadType} (.+?)\\s*$`, "m").exec(sdp)?.[1]
    if (fmtp === undefined || !/(^|;)\s*packetization-mode=1\b/.test(fmtp)) continue
    const prefix = /(^|;)\s*profile-level-id=([0-9a-f]{4})/i.exec(fmtp)?.[2]?.toLowerCase()
    const profile = H264_PROFILES.find((p) => p.prefix === prefix)
    if (profile !== undefined) formats.push({ rank: H264_PROFILES.indexOf(profile), fmtp, baselineOnly: profile.baselineOnly })
  }
  formats.sort((a, b) => a.rank - b.rank)
  const best = formats[0]
  return best === undefined ? null : { fmtp: best.fmtp, baselineOnly: best.baselineOnly }
}

/** The RTP header extension id the browser offered for playout delay, or null when it did not. */
const playoutDelayId = (sdp: string): number | null => {
  const id = new RegExp(`^a=extmap:(\\d+)(?:/\\S+)? ${PLAYOUT_DELAY_URI.replace(/[./]/g, "\\$&")}\\s*$`, "m").exec(sdp)?.[1]
  return id === undefined ? null : Number(id)
}

/** An IP address as its bytes: 4 for IPv4, 16 for IPv6. Null for anything else (a hostname, an mDNS name, garbage). */
const ipBytes = (address: string): number[] | null => {
  const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(address)
  if (v4 !== null) {
    const octets = v4.slice(1).map(Number)
    return octets.every((o) => o <= 255) ? octets : null
  }
  if (!address.includes(":")) return null
  // An IPv4 tail (::ffff:1.2.3.4) becomes two 16-bit groups before the groups are counted. Anchored on the colon, so a
  // longer number ending in dotted digits is not read as an address.
  let text = address
  const tail = /:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/.exec(text)
  if (tail !== null) {
    const bytes = ipBytes(tail[1]!)
    if (bytes === null) return null
    text = `${text.slice(0, tail.index)}:${((bytes[0]! << 8) | bytes[1]!).toString(16)}:${((bytes[2]! << 8) | bytes[3]!).toString(16)}`
  }
  const halves = text.split("::")
  if (halves.length > 2) return null
  const head = halves[0] === "" ? [] : halves[0]!.split(":")
  const rest = halves.length === 2 && halves[1] !== "" ? halves[1]!.split(":") : []
  const missing = 8 - head.length - rest.length
  if (halves.length === 2 ? missing < 1 : head.length !== 8) return null
  const all = [...head, ...Array<string>(halves.length === 2 ? missing : 0).fill("0"), ...rest]
  const bytes: number[] = []
  for (const group of all) {
    if (!/^[0-9a-f]{1,4}$/i.test(group)) return null
    const value = Number.parseInt(group, 16)
    bytes.push(value >> 8, value & 0xff)
  }
  return bytes
}

/**
 * The IPv4 address an IPv6 address carries, if it carries one: mapped (::ffff:a.b.c.d), compatible (::a.b.c.d), NAT64
 * (64:ff9b::a.b.c.d), and 6to4 (2002:AABB:CCDD::/48). Null for any other IPv6 address. Teredo (2001::/32) is not
 * decoded: its address is XOR-obfuscated, so it is judged as IPv6.
 */
const embeddedV4 = (bytes: number[]): number[] | null => {
  const zeros = (from: number, to: number) => bytes.slice(from, to).every((b) => b === 0)
  if (zeros(0, 10) && bytes[10] === 0xff && bytes[11] === 0xff) return bytes.slice(12)
  if (zeros(0, 12)) return bytes.slice(12)
  if (bytes[0] === 0x00 && bytes[1] === 0x64 && bytes[2] === 0xff && bytes[3] === 0x9b && zeros(4, 12)) return bytes.slice(12)
  if (bytes[0] === 0x20 && bytes[1] === 0x02) return bytes.slice(2, 6)
  return null
}

/**
 * Whether a viewer's candidate may be probed. Refused: unspecified, loopback, link-local, multicast, and the IPv4 "this
 * network" block, in both families. IPv4 written inside IPv6 is judged as the IPv4 address (see `embeddedV4`), so
 * ::ffff:169.254.169.254 is refused as the metadata address it is. With `denyPrivate`, private IPv4 and unique-local
 * IPv6 (fc00::/7) are refused too, in those forms as well. A candidate that is not an IP address is refused: werift
 * could not reach it anyway. Addresses the box was told to use pass, unless `denyPrivate`.
 */
export const isPeerAddressAllowed = (address: string, hostAddresses: ReadonlyArray<string>, denyPrivate = false): boolean => {
  const bytes = ipBytes(address)
  if (bytes === null) return false
  if (!denyPrivate && hostAddresses.includes(address)) return true
  const v4 = bytes.length === 4 ? bytes : embeddedV4(bytes)
  if (v4 !== null) return !isBlockedV4(v4) && !(denyPrivate && isPrivateV4(v4))
  if (denyPrivate && (bytes[0]! & 0xfe) === 0xfc) return false
  const linkLocal = bytes[0] === 0xfe && (bytes[1]! & 0xc0) === 0x80 // fe80::/10
  const multicast = bytes[0] === 0xff
  return !(linkLocal || multicast)
}

const isBlockedV4 = ([a, b]: number[]): boolean => a === 0 || a === 127 || (a === 169 && b === 254) || a! >= 224
const isPrivateV4 = ([a, b]: number[]): boolean =>
  a === 10 || (a === 172 && b! >= 16 && b! <= 31) || (a === 192 && b === 168) || (a === 100 && b! >= 64 && b! <= 127)

/**
 * werift's ICE falls back to a public Google STUN server when it is given none, and no setting turns that off. The box
 * must not reach out to anyone it was not told to, so that is cleared here, after the transports exist and before
 * `setLocalDescription` gathers. werift is pinned to an exact version; webrtc.test.ts holds this to the field.
 */
export const withoutDefaultStun = (pc: RTCPeerConnection, servers: ReadonlyArray<DesktopRtcIceServer>): void => {
  if (servers.some((s) => s.urls.some((u) => u.startsWith("stun")))) return
  for (const transport of pc.iceTransports) transport.connection.stunServer = undefined
}

/** Guard werift 0.26.0's request dispatch before it can respond, change roles, or create peer-reflexive pairs.
 * Its public iceFilterStunResponse hook runs after role conflict handling and does not authenticate requests.
 * The private hook is pinned by the live STUN tests; fail closed if a future werift changes it.
 */
export const guardIceRequests = (pc: RTCPeerConnection, settings: WebRtcSettings): void => {
  if (pc.iceTransports.length === 0) throw new Error("werift created no ICE transports")
  for (const transport of pc.iceTransports) {
    const connection = transport.connection
    const internal = connection as unknown as { ensureProtocol?: (protocol: Protocol) => void }
    const ensure = internal.ensureProtocol
    if (typeof ensure !== "function") throw new Error("werift ICE request guard unavailable")
    internal.ensureProtocol = function (protocol) {
      const event = protocol.onRequestReceived
      const dispatch = event.execute.bind(event)
      event.execute = (message, addr, data) => {
        if (!isPeerAddressAllowed(addr[0], settings.hostAddresses, settings.denyPrivate)) return
        const verified = parseMessage(data, Buffer.from(connection.localPassword, "utf8"))
        if (!verified || verified.getAttributeValue("USERNAME") !== `${connection.localUsername}:${connection.remoteUsername}`) return
        dispatch(verified, addr, data)
      }
      ensure.call(connection, protocol)
    }
  }
}

export interface DesktopRtcHandlers {
  readonly send: (message: DesktopRtcServerMessage) => void
  /** Raw JSON text from a data channel: `input` (everything but mouse.move) or `pointer` (mouse.move only). */
  readonly onInput: (raw: string, channel: "input" | "pointer") => void
  /** The viewer's needs changed (its payload is known, or its connection ended): the encoder's profile is re-picked now. */
  readonly profileChanged: () => void
  readonly debug: (message: string) => void
}

/** Viewer signaling, as the session takes it. */
export type DesktopRtcSignal =
  | { readonly _tag: "rtc.offer"; readonly sdp: string }
  | { readonly _tag: "rtc.candidate"; readonly candidate: string | null; readonly sdpMid: string | null; readonly sdpMLineIndex: number | null }
  | { readonly _tag: "rtc.close" }

interface Peer {
  readonly pc: RTCPeerConnection
  readonly sender: RtpVideoSender
  /** Writes one Opus packet at its RTP timestamp, or null when the answer carries no audio. */
  readonly audio: ((opus: Uint8Array, timestamp: number) => void) | null
  /** Constrained Baseline payload: the encoder stays on Baseline while this peer is connected. */
  readonly baselineOnly: boolean
  /** True once the peer is connected: nothing is sent before that. */
  live: boolean
  readonly connectTimer: NodeJS.Timeout
  readonly release: () => void
}

const realTimer = (run: () => void, ms: number): (() => void) => {
  const timer = setTimeout(run, ms)
  return () => clearTimeout(timer)
}

export class DesktopRtcSession {
  private peer: Peer | null = null
  private closed = false
  /** Signaling runs in order: a candidate that follows an offer needs that offer applied first. */
  private signaling: Promise<void> = Promise.resolve()

  /**
   * The stream's resolved ICE servers, set before it offers. Resolving them here instead would gate the answer on the
   * control plane; until they arrive, the peer uses the box's own configuration.
   */
  private relayServers: ReadonlyArray<DesktopRtcIceServer> | null = null
  private managedRelay = false

  constructor(
    private readonly settings: WebRtcSettings,
    private readonly taskId: string,
    private readonly tap: MediaTap,
    private readonly handlers: DesktopRtcHandlers,
  ) {}

  /**
   * The ICE servers the box's own peer uses: the box's configuration plus any managed TURN the viewer just received, so
   * a box without a candidate the viewer can reach still connects through both relays.
   */
  setIceServers(servers: ReadonlyArray<DesktopRtcIceServer>, managed: boolean): void {
    this.relayServers = servers
    this.managedRelay = managed
  }

  /** Signaling from the viewer. Never rejects: what goes wrong is told to the viewer, which can retry. */
  handle(message: DesktopRtcSignal): Promise<void> {
    this.signaling = this.signaling.then(() => this.process(message))
    return this.signaling
  }

  private async process(message: DesktopRtcSignal): Promise<void> {
    if (this.closed) return
    try {
      switch (message._tag) {
        case "rtc.offer":
          await this.answer(message.sdp)
          return
        case "rtc.candidate":
          if (this.peer !== null && message.candidate !== null) {
            try {
              await this.peer.pc.addIceCandidate({
                candidate: message.candidate,
                sdpMid: message.sdpMid ?? undefined,
                sdpMLineIndex: message.sdpMLineIndex ?? undefined,
              })
            } catch (e) {
              // A rejected trickle candidate does not invalidate the selected pair or the other candidates.
              this.handlers.debug(`webrtc candidate ignored: ${e instanceof Error ? e.message : String(e)}`)
            }
          }
          return
        case "rtc.close":
          this.closePeer()
          return
      }
    } catch (e) {
      this.handlers.debug(`webrtc ${message._tag} failed: ${e instanceof Error ? e.message : String(e)}`)
      // A live peer going away hands the viewer back to the WebSocket, as a dead connection does.
      this.lose()
      this.handlers.send({ _tag: "rtc.unavailable", reason: "negotiation failed", retryable: true })
    }
  }

  /** A unit from the encoder, after `tap` has recorded it. */
  push(unit: H264Unit): void {
    try {
      this.peer?.sender.push(unit)
    } catch (e) {
      this.handlers.debug(`webrtc sender failed: ${e instanceof Error ? e.message : String(e)}`)
      this.lose()
    }
  }

  /** One 10 ms Opus packet from the desktop's audio, at its RTP timestamp: a packet the gate dropped shows as a jump. */
  pushAudio(opus: Uint8Array, timestamp: number): void {
    const peer = this.peer
    if (peer === null || !peer.live || peer.audio === null) return
    try {
      peer.audio(opus, timestamp)
    } catch (e) {
      this.handlers.debug(`webrtc audio failed: ${e instanceof Error ? e.message : String(e)}`)
    }
  }

  get hasPeer(): boolean {
    return this.peer !== null
  }

  /** The connected viewer's payload is Constrained Baseline: the encoder must stay on Baseline while it is connected. */
  get baselineOnly(): boolean {
    return this.peer !== null && this.peer.baselineOnly
  }

  close(): void {
    this.closed = true
    this.closePeer()
  }

  private async answer(offer: string): Promise<void> {
    this.closePeer()
    if (offer.length > MAX_OFFER_CHARS) throw new Error("offer is too large")
    const picked = pickH264Format(offer)
    if (picked === null) {
      this.handlers.send({
        _tag: "rtc.unavailable",
        reason: "the browser offered no H.264 format the box can encode (High 4:2:0 or Constrained Baseline)",
        retryable: false,
      })
      return
    }
    const { fmtp, baselineOnly } = picked
    if (!/^m=video /m.test(offer)) throw new Error("offer has no video section")
    if (peers >= MAX_PEERS) {
      this.handlers.send({ _tag: "rtc.unavailable", reason: "this box is at its WebRTC viewer limit", retryable: true })
      return
    }
    const servers = this.relayServers ?? mintIceServers(this.settings, this.taskId)
    // Unlike browsers, werift 0.26 only uses the first TURN URL; its UDP fallback retries TCP on the same port,
    // not later URLs. Select the managed TLS/443 endpoint so blocked UDP/3478 cannot silently remove the box's relay.
    const tlsRelay = this.managedRelay
      ? servers.find((server) => server.urls.some((url) => MANAGED_TURN_TLS.test(url)))
      : undefined
    const peerServers = tlsRelay === undefined
      ? servers
      : [{ ...tlsRelay, urls: tlsRelay.urls.filter((url) => MANAGED_TURN_TLS.test(url)) }, ...servers]
    const playoutId = playoutDelayId(offer)
    // The track's source codec is the offered format. werift matches a remote H.264 codec by its exact profile-level-id,
    // so a browser's payload is only selected when the source names the same format.
    const encoded = new RTCRtpCodecParameters({ mimeType: "video/H264", clockRate: 90_000, parameters: fmtp })
    const opusCodec = new RTCRtpCodecParameters({ mimeType: "audio/opus", clockRate: 48_000, channels: 2 })
    const pc = new RTCPeerConnection({
      iceServers: peerServers.map((s) => ({ ...s, urls: [...s.urls] })),
      icePortRange: this.settings.portRange === null ? undefined : [this.settings.portRange[0], this.settings.portRange[1]],
      // The cap belongs to the control plane's relay, whose nearest location answers in milliseconds. An operator's own
      // TURN server may be far away or reached over TLS, so it keeps werift's default wait.
      iceTurnConnectTimeout: this.managedRelay ? TURN_TCP_CONNECT_TIMEOUT_S : undefined,
      iceAdditionalHostAddresses: [...this.settings.hostAddresses],
      iceFilterCandidatePair: (pair) => isPeerAddressAllowed(pair.remoteCandidate.host, this.settings.hostAddresses, this.settings.denyPrivate),
      codecs: {
        video: [
          new RTCRtpCodecParameters({
            mimeType: "video/H264",
            clockRate: 90_000,
            rtcpFeedback: [useNACK(), usePLI(), useFIR()],
            parameters: fmtp,
          }),
        ],
        audio: [opusCodec],
      },
      // Playout delay pins the browser's jitter buffer to zero: the box's pacing is the only buffer, so the viewer
      // shows each frame as it arrives instead of holding it for the browser's own target.
      headerExtensions: {
        video: playoutId === null ? [] : [new RTCRtpHeaderExtensionParameters({ id: playoutId, uri: PLAYOUT_DELAY_URI })],
      },
    })
    peers += 1
    let released = false
    const release = () => {
      if (!released) peers -= 1
      released = true
    }
    let connectTimer: NodeJS.Timeout | undefined
    try {
      const track = new MediaStreamTrack({ kind: "video", codec: encoded })
      const audioTrack = new MediaStreamTrack({ kind: "audio", codec: opusCodec })
      pc.onIceCandidate.subscribe((candidate) => {
        if (this.closed || !candidate) return
        const init = candidate.toJSON()
        this.handlers.send({
          _tag: "rtc.candidate",
          candidate: init.candidate ?? null,
          sdpMid: init.sdpMid ?? null,
          sdpMLineIndex: init.sdpMLineIndex ?? null,
        })
      })
      pc.onDataChannel.subscribe((channel) => {
        if (channel.label !== INPUT_CHANNEL && channel.label !== POINTER_CHANNEL) return
        const which = channel.label === INPUT_CHANNEL ? "input" : "pointer"
        channel.onMessage.subscribe((data) => {
          if (typeof data !== "string") return
          this.handlers.onInput(data, which)
        })
      })
      // Tracks go on before the offer is applied: werift matches the offered H.264 profile against a sender's track, so
      // a track attached after the offer would let an unrelated payload be chosen.
      pc.addTransceiver(track, { direction: "sendonly" })
      pc.addTransceiver(audioTrack, { direction: "sendonly" })
      await pc.setRemoteDescription({ type: "offer", sdp: offer })
      withoutDefaultStun(pc, servers)
      guardIceRequests(pc, this.settings)
      const videoTransceiver = pc.getTransceivers().find((t) => t.kind === "video")
      if (videoTransceiver === undefined) throw new Error("offer has no video section")
      await videoTransceiver.sender.replaceTrack(track)
      videoTransceiver.setDirection("sendonly")
      const audioTransceiver = pc.getTransceivers().find((t) => t.kind === "audio")
      let audio: Peer["audio"] = null
      if (audioTransceiver !== undefined) {
        await audioTransceiver.sender.replaceTrack(audioTrack)
        audioTransceiver.setDirection("sendonly")
        let audioSeq = Math.floor(Math.random() * 0x1_0000)
        audio = (opus, timestamp) => {
          audioSeq = (audioSeq + 1) & 0xffff
          const header = new RtpHeader({ sequenceNumber: audioSeq, timestamp, marker: false, payloadType: 0 })
          audioTrack.writeRtp(new RtpPacket(header, Buffer.from(opus.buffer, opus.byteOffset, opus.byteLength)))
        }
      }

      let sequence = Math.floor(Math.random() * 0x1_0000)
      const sender = new RtpVideoSender(
        this.tap,
        {
          write: (payload, marker, timestamp) => {
            sequence = (sequence + 1) & 0xffff
            const extensions = playoutId === null ? [] : [{ id: playoutId, payload: PLAYOUT_DELAY_ZERO }]
            const header = new RtpHeader({ sequenceNumber: sequence, timestamp, marker, payloadType: 0, extensions })
            track.writeRtp(new RtpPacket(header, Buffer.from(payload.buffer, payload.byteOffset, payload.byteLength)))
          },
          now: () => performance.now(),
          setTimer: realTimer,
        },
        this.handlers.debug,
        baselineOnly,
      )
      videoTransceiver.sender.onKeyFrameRequest.subscribe(() => sender.requestKeyframe())
      videoTransceiver.sender.onRtcp.subscribe((packet) => {
        if (packet.type !== 201 || !("reports" in packet)) return
        for (const report of packet.reports) sender.reportLoss(report.fractionLost / 256)
      })
      const timer = setTimeout(() => {
        if (this.peer?.pc === pc) this.lose()
      }, CONNECT_TIMEOUT_MS)
      connectTimer = timer
      const peer: Peer = { pc, sender, audio, live: false, connectTimer: timer, release, baselineOnly }
      pc.connectionStateChange.subscribe((state) => {
        if (this.peer !== peer) return
        if (state === "connected") {
          clearTimeout(timer)
          peer.live = true
          sender.start()
        } else if (state === "failed" || state === "closed") this.lose()
      })
      const answer = await pc.createAnswer()
      await pc.setLocalDescription(answer)
      this.peer = peer
      this.handlers.profileChanged()
      if (this.closed) {
        this.closePeer()
        return
      }
      this.handlers.send({ _tag: "rtc.answer", sdp: pc.localDescription?.sdp ?? "" })
      // Connected already: the browser's checks can beat the answer leaving this tick.
      if (pc.connectionState === "connected") {
        peer.live = true
        sender.start()
      }
    } catch (e) {
      clearTimeout(connectTimer)
      release()
      await pc.close().catch(() => {})
      throw e
    }
  }

  private lose(): void {
    if (this.peer === null) return
    this.closePeer()
  }

  private closePeer(): void {
    const peer = this.peer
    if (peer === null) return
    this.peer = null
    clearTimeout(peer.connectTimer)
    peer.sender.close()
    peer.release()
    void peer.pc.close().catch(() => {})
    this.handlers.profileChanged()
  }
}

export const activeRtcPeers = (): number => peers
