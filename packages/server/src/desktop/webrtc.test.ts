import { afterEach, describe, expect, test } from "bun:test"
import { createHash, createHmac } from "node:crypto"
import { createSocket } from "node:dgram"
import type { Socket } from "node:net"
import { createServer as createTlsServer, createSecureContext } from "node:tls"
import { classes, createSelfSignedCertificate, Message, methods, parseMessage, RTCPeerConnection, RTCRtpCodecParameters, useNACK, usePLI } from "werift"
import type { DesktopRtcServerMessage } from "@cloudagents/protocol"
import { MediaTap } from "./rtp"
import {
  DesktopRtcSession,
  TURN_CREDENTIAL_TTL_S,
  activeRtcPeers,
  isPeerAddressAllowed,
  mintIceServers,
  withoutDefaultStun,
  pickH264Format,
  type WebRtcSettings,
} from "./webrtc"

const settings: WebRtcSettings = { iceServers: [], turn: null, policy: "all", portRange: null, hostAddresses: ["127.0.0.1"], denyPrivate: false }

const SDP = (lines: readonly string[]) => [...lines, ""].join("\r\n")

describe("pickH264Format", () => {
  test("takes the first Constrained Baseline format offered, skipping packetization-mode 0, and echoes it verbatim", () => {
    const sdp = SDP([
      "a=rtpmap:102 H264/90000",
      "a=fmtp:102 packetization-mode=0;profile-level-id=42e028",
      "a=rtpmap:103 H264/90000",
      "a=fmtp:103 level-asymmetry-allowed=1;packetization-mode=1;profile-level-id=42e028",
      "a=rtpmap:104 H264/90000",
      "a=fmtp:104 level-asymmetry-allowed=1;packetization-mode=1;profile-level-id=42c034",
    ])
    expect(pickH264Format(sdp)).toEqual({
      fmtp: "level-asymmetry-allowed=1;packetization-mode=1;profile-level-id=42e028",
      baselineOnly: true,
    })
  })

  test("skips a format the box cannot encode, such as High 10, for the next", () => {
    expect(
      pickH264Format(
        SDP(["a=rtpmap:96 H264/90000", "a=fmtp:96 packetization-mode=1;profile-level-id=6e001f", "a=rtpmap:97 H264/90000", "a=fmtp:97 packetization-mode=1;profile-level-id=42e028"]),
      ),
    ).toEqual({ fmtp: "packetization-mode=1;profile-level-id=42e028", baselineOnly: true })
  })

  test("ignores level: Constrained Baseline at 3.1 or 4.0 matches, and the offered fmtp is echoed", () => {
    for (const id of ["42e028", "42e01f", "42c034"]) {
      const fmtp = `packetization-mode=1;profile-level-id=${id}`
      expect(pickH264Format(SDP(["a=rtpmap:96 H264/90000", `a=fmtp:96 ${fmtp}`]))).toEqual({ fmtp, baselineOnly: true })
    }
  })

  test("accepts plain Baseline (4200xx); Main (4d00xx) is not in the box's list", () => {
    expect(pickH264Format(SDP(["a=rtpmap:96 H264/90000", "a=fmtp:96 packetization-mode=1;profile-level-id=42001f"]))).toEqual({
      fmtp: "packetization-mode=1;profile-level-id=42001f",
      baselineOnly: true,
    })
    const sdp = SDP([
      "a=rtpmap:96 H264/90000",
      "a=fmtp:96 packetization-mode=1;profile-level-id=4d0028",
      "a=rtpmap:97 H264/90000",
      "a=fmtp:97 packetization-mode=1;profile-level-id=42001f",
    ])
    expect(pickH264Format(sdp)).toEqual({ fmtp: "packetization-mode=1;profile-level-id=42001f", baselineOnly: true })
  })

  test("prefers a 42e0 (Constrained Baseline) payload over 42c0 and 4200", () => {
    const sdp = SDP([
      "a=rtpmap:96 H264/90000",
      "a=fmtp:96 packetization-mode=1;profile-level-id=42001f",
      "a=rtpmap:97 H264/90000",
      "a=fmtp:97 packetization-mode=1;profile-level-id=42c028",
      "a=rtpmap:98 H264/90000",
      "a=fmtp:98 packetization-mode=1;profile-level-id=42e01f",
    ])
    expect(pickH264Format(sdp)).toEqual({ fmtp: "packetization-mode=1;profile-level-id=42e01f", baselineOnly: true })
  })

  test("prefers the High group (640c, then 6400) over any Baseline payload, so the encoder stays High", () => {
    const sdp = SDP([
      "a=rtpmap:96 H264/90000",
      "a=fmtp:96 packetization-mode=1;profile-level-id=42e01f",
      "a=rtpmap:97 H264/90000",
      "a=fmtp:97 packetization-mode=1;profile-level-id=640028",
      "a=rtpmap:98 H264/90000",
      "a=fmtp:98 packetization-mode=1;profile-level-id=640c28",
    ])
    expect(pickH264Format(sdp)).toEqual({ fmtp: "packetization-mode=1;profile-level-id=640c28", baselineOnly: false })
    expect(
      pickH264Format(SDP(["a=rtpmap:96 H264/90000", "a=fmtp:96 packetization-mode=1;profile-level-id=640028", "a=rtpmap:97 H264/90000", "a=fmtp:97 packetization-mode=1;profile-level-id=42e01f"])),
    ).toEqual({ fmtp: "packetization-mode=1;profile-level-id=640028", baselineOnly: false })
  })

  test("accepts High 4:4:4 Predictive (f400) after the High group; it is answered High, not Baseline", () => {
    expect(pickH264Format(SDP(["a=rtpmap:96 H264/90000", "a=fmtp:96 packetization-mode=1;profile-level-id=f4001f"]))).toEqual({
      fmtp: "packetization-mode=1;profile-level-id=f4001f",
      baselineOnly: false,
    })
  })

  test("refuses a profile outside the box's list, such as Main, High 10 or High 4:2:2", () => {
    for (const id of ["4d0028", "6e001f", "7a001f"]) {
      expect(pickH264Format(SDP(["a=rtpmap:96 H264/90000", `a=fmtp:96 packetization-mode=1;profile-level-id=${id}`]))).toBeNull()
    }
  })

  test("refuses packetization-mode 0 and an fmtp with no profile, which RFC 6184 reads as Baseline", () => {
    expect(pickH264Format(SDP(["a=rtpmap:97 H264/90000", "a=fmtp:97 packetization-mode=0;profile-level-id=42e028"]))).toBeNull()
    expect(pickH264Format(SDP(["a=rtpmap:96 H264/90000", "a=fmtp:96 packetization-mode=1"]))).toBeNull()
  })

  test("is null without a usable H.264 format", () => {
    expect(pickH264Format(SDP(["a=rtpmap:96 VP8/90000"]))).toBeNull()
  })
})

describe("mintIceServers", () => {
  test("leaves the secret on the box and scopes short-lived credentials to the thread", () => {
    const secret = "the-box-secret"
    const servers = mintIceServers(
      { ...settings, iceServers: [{ urls: ["stun:stun.example:3478"] }], turn: { urls: ["turn:turn.example:3478"], secret } },
      "thread-1",
      1000,
    )
    expect(JSON.stringify(servers)).not.toContain(secret)
    const turn = servers[1]!
    expect(turn.urls).toEqual(["turn:turn.example:3478"])
    expect(turn.username).toBe(`${1000 + TURN_CREDENTIAL_TTL_S}:thread-1`)
    expect(turn.credential).toBe(createHmac("sha1", secret).update(turn.username!).digest("base64"))
  })

  test("assumes no server at all when none is configured", () => {
    expect(mintIceServers(settings, "thread-1")).toEqual([])
  })
})

describe("isPeerAddressAllowed", () => {
  test("keeps a viewer's candidates off the box's own loopback and metadata addresses", () => {
    for (const address of ["127.0.0.1", "127.8.9.10", "169.254.169.254", "0.0.0.0", "0.1.2.3", "::", "::1", "fe80::1"]) {
      expect(isPeerAddressAllowed(address, [])).toBe(false)
    }
    for (const address of ["192.168.1.2", "100.64.0.5", "8.8.8.8", "2001:db8::1", "2606:4700::1111"]) {
      expect(isPeerAddressAllowed(address, [])).toBe(true)
    }
  })

  test("refuses the same addresses written in other forms", () => {
    for (const address of [
      "::ffff:169.254.169.254",
      "::ffff:127.0.0.1",
      "0:0:0:0:0:ffff:a9fe:a9fe",
      "::ffff:a9fe:a9fe",
      "fe80::1",
      "febf::1",
      "0000:0000:0000:0000:0000:0000:0000:0001",
      "::0:0",
    ]) {
      expect(isPeerAddressAllowed(address, [])).toBe(false)
    }
  })

  test("refuses what is not an IP address, and keeps mapped public addresses", () => {
    for (const address of ["host.local", "1.2.3", "1.2.3.256", "::g", "1:2:3:4:5:6:7:8:9", "1::2::3"]) {
      expect(isPeerAddressAllowed(address, [])).toBe(false)
    }
    expect(isPeerAddressAllowed("::ffff:8.8.8.8", [])).toBe(true)
    expect(isPeerAddressAllowed("febf::1", [])).toBe(false)
    expect(isPeerAddressAllowed("fec0::1", [])).toBe(true)
  })

  test("allows what the box was told to use", () => {
    expect(isPeerAddressAllowed("127.0.0.1", ["127.0.0.1"])).toBe(true)
  })

  test("managed boxes reject private, mapped, and explicitly advertised internal addresses", () => {
    for (const address of ["10.203.0.1", "172.16.0.1", "192.168.1.1", "100.64.0.1", "fd00::1", "::ffff:10.203.0.1", "127.0.0.1", "224.0.0.1", "255.255.255.255", "ff02::1"]) {
      expect(isPeerAddressAllowed(address, [address], true)).toBe(false)
    }
    expect(isPeerAddressAllowed("8.8.8.8", [], true)).toBe(true)
    expect(isPeerAddressAllowed("::ffff:8.8.8.8", [], true)).toBe(true)
  })
})

/**
 * A browser stand-in: offers the same m-lines one does, and adds the box's candidates. For H.264 it offers one format
 * per profile given, default Constrained Baseline 4.0.
 */
const remoteOffer = async (codec = "video/H264", profiles: readonly string[] = ["42e028"]) => {
  const pc = new RTCPeerConnection({
    iceServers: [],
    iceAdditionalHostAddresses: ["127.0.0.1"],
    codecs: {
      video:
        codec === "video/H264"
          ? profiles.map(
              (profile) =>
                new RTCRtpCodecParameters({
                  mimeType: codec,
                  clockRate: 90_000,
                  rtcpFeedback: [useNACK(), usePLI()],
                  parameters: profile.includes("=") ? profile : `packetization-mode=1;profile-level-id=${profile}`,
                }),
            )
          : [new RTCRtpCodecParameters({ mimeType: codec, clockRate: 90_000, rtcpFeedback: [useNACK(), usePLI()] })],
    },
  })
  pc.addTransceiver("video", { direction: "recvonly" })
  const channel = pc.createDataChannel("input")
  await pc.setLocalDescription(await pc.createOffer())
  return Object.assign(pc, { channel })
}

/** The session's live peer is private; tests read the werift connection it built. */
const peerOf = (session: DesktopRtcSession) => (session as unknown as { peer: { pc: RTCPeerConnection } }).peer

const lastDiagnostics = (sent: DesktopRtcServerMessage[]) => {
  for (let i = sent.length - 1; i >= 0; i -= 1) {
    const message = sent[i]
    if (message?._tag === "rtc.diagnostics") return message.diagnostics
  }
  return null
}

/**
 * In-process TURN allocation endpoints: UDP and TLS return different relay addresses after authenticated Allocate.
 * No privileged ports, coturn, fixed certificate or outbound network. Media delivery is exercised by the coturn runner.
 */
const allocationServers = async (handshakeDelayMs = 0) => {
  const { certPem, keyPem } = await createSelfSignedCertificate({ hash: 4, signature: 3 })
  const realm = "turn-regression"
  const nonce = Buffer.from("fixture-nonce")
  const tlsAddress = ["203.0.113.71", 41001] as [string, number]
  const udpAddress = ["203.0.113.72", 41002] as [string, number]
  const response = (data: Buffer, username: string, password: string, address: [string, number]): Buffer | null => {
    const request = parseMessage(data)
    if (!request || request.messageClass !== classes.REQUEST) return null
    if (!request.getAttributeValue("USERNAME")) {
      return new Message(request.messageMethod, classes.ERROR, request.transactionId)
        .setAttribute("ERROR-CODE", [401, "Unauthorized"]).setAttribute("REALM", realm).setAttribute("NONCE", nonce).bytes
    }
    const key = createHash("md5").update(`${username}:${realm}:${password}`).digest()
    if (request.getAttributeValue("USERNAME") !== username || !parseMessage(data, key)) return null
    return new Message(request.messageMethod, classes.RESPONSE, request.transactionId)
      .setAttribute("XOR-RELAYED-ADDRESS", address).setAttribute("XOR-MAPPED-ADDRESS", ["127.0.0.1", 41000])
      .setAttribute("LIFETIME", request.getAttributeValue("LIFETIME") === 0 ? 0 : 600).addMessageIntegrity(key).bytes
  }
  const udp = createSocket("udp4")
  udp.on("message", (data, remote) => {
    const answer = response(data, "udp-user", "udp-password", udpAddress)
    if (answer) udp.send(answer, remote.port, remote.address)
  })
  const sockets = new Set<Socket>()
  const timers = new Set<NodeJS.Timeout>()
  const tls = createTlsServer({
    key: keyPem, cert: certPem,
    SNICallback(_name, done) {
      const timer = setTimeout(() => { timers.delete(timer); done(null, createSecureContext({ key: keyPem, cert: certPem })) }, handshakeDelayMs)
      timers.add(timer)
    },
  }, (socket) => {
    let pending = Buffer.alloc(0)
    socket.on("data", (data) => {
      pending = Buffer.concat([pending, data])
      while (pending.length >= 20 && pending.length >= pending.readUInt16BE(2) + 20) {
        const size = pending.readUInt16BE(2) + 20
        const answer = response(pending.subarray(0, size), "tls-user", "tls-password", tlsAddress)
        pending = pending.subarray(size)
        if (answer) socket.write(answer)
      }
    })
  })
  // Include sockets whose TLS handshake has not completed, so timeout tests also clean up completely.
  tls.on("connection", (socket) => {
    sockets.add(socket)
    socket.on("close", () => sockets.delete(socket))
    socket.on("error", () => {})
  })
  const udpReady = Promise.withResolvers<void>()
  udp.once("listening", udpReady.resolve)
  udp.once("error", udpReady.reject)
  udp.bind(0, "127.0.0.1")
  const tlsReady = Promise.withResolvers<void>()
  tls.once("listening", tlsReady.resolve)
  tls.once("error", tlsReady.reject)
  tls.listen(0, "127.0.0.1")
  await Promise.all([udpReady.promise, tlsReady.promise])
  const tlsPort = tls.address()
  if (!tlsPort || typeof tlsPort === "string") throw new Error("missing TLS listener")
  const udpServer = { urls: [`turn:127.0.0.1:${udp.address().port}?transport=udp`], username: "udp-user", credential: "udp-password" }
  const tlsServer = { urls: ["turns:fixture.invalid:443?transport=tcp"], username: "tls-user", credential: "tls-password" }
  const original = RTCPeerConnection.prototype.setLocalDescription
  // Route only the fixture's canonical TLS/443 endpoint to an ephemeral local TLS port. Preserve werift's selected
  // transport, credentials and timeout: the test must authenticate and allocate over that transport to publish a relay.
  RTCPeerConnection.prototype.setLocalDescription = new Proxy(original, {
    apply(target, pc: RTCPeerConnection, args: unknown[]) {
      for (const { connection } of pc.iceTransports) {
        if (connection.turnServer?.[0] !== "fixture.invalid") continue
        connection.turnServer = ["127.0.0.1", tlsPort.port]
        connection.options.turnTlsOptions = { ca: certPem, servername: "fixture.invalid", checkServerIdentity: () => undefined }
      }
      return Reflect.apply(target, pc, args)
    },
  })
  return {
    udpServer, tlsServer, tlsAddress, udpAddress,
    close: async () => {
      RTCPeerConnection.prototype.setLocalDescription = original
      for (const timer of timers) clearTimeout(timer)
      for (const socket of sockets) socket.destroy()
      udp.close()
      const closed = Promise.withResolvers<void>()
      tls.close(() => closed.resolve())
      await closed.promise
    },
  }
}

describe("withoutDefaultStun", () => {
  const answerer = async () => {
    const browser = await remoteOffer()
    const pc = new RTCPeerConnection({ iceServers: [] })
    await pc.setRemoteDescription({ type: "offer", sdp: browser.localDescription!.sdp })
    await browser.close()
    return pc
  }

  test("werift still has the default this exists to clear, and it is cleared", async () => {
    const pc = await answerer()
    const connections = pc.iceTransports.map((t) => t.connection)
    expect(connections.length).toBeGreaterThan(0)
    // If this stops being Google's server, werift changed and the workaround should be looked at again.
    expect(connections[0]!.stunServer).toEqual(["stun.l.google.com", 19302])
    withoutDefaultStun(pc, [])
    for (const connection of connections) expect(connection.stunServer).toBeUndefined()
    await pc.close()
  })

  test("leaves a configured STUN server alone", async () => {
    const pc = await answerer()
    const before = pc.iceTransports[0]!.connection.stunServer
    withoutDefaultStun(pc, [{ urls: ["stun:stun.example:3478"] }])
    expect(pc.iceTransports[0]!.connection.stunServer).toEqual(before)
    await pc.close()
  })
})

describe("DesktopRtcSession", () => {
  const closing: (() => unknown)[] = []
  afterEach(async () => {
    for (const close of closing.splice(0)) await close()
  })

  const session = (over: Partial<WebRtcSettings> = {}) => {
    const sent: DesktopRtcServerMessage[] = []
    const inputs: string[] = []
    const s = new DesktopRtcSession({ ...settings, ...over }, "thread-1", new MediaTap(), {
      send: (m) => sent.push(m),
      onInput: (raw) => inputs.push(raw),
      profileChanged: () => {},
      debug: () => {},
    })
    closing.push(() => s.close())
    return { s, sent, inputs }
  }

  test("an offer without H.264 is refused and takes no peer", async () => {
    const { s, sent } = session()
    const before = activeRtcPeers()
    const pc = await remoteOffer("video/VP8")
    closing.push(() => pc.close())
    await s.handle({ _tag: "rtc.offer", sdp: pc.localDescription!.sdp })
    expect(sent.at(-1)).toMatchObject({ _tag: "rtc.unavailable", retryable: false })
    expect(activeRtcPeers()).toBe(before)
  })

  test("an offer with no H.264 profile the box can answer is refused and takes no peer", async () => {
    const { s, sent } = session()
    const before = activeRtcPeers()
    for (const profiles of [["6e001f"], ["4d0028"]]) {
      const pc = await remoteOffer("video/H264", profiles)
      closing.push(() => pc.close())
      await s.handle({ _tag: "rtc.offer", sdp: pc.localDescription!.sdp })
      expect(sent.at(-1)).toMatchObject({ _tag: "rtc.unavailable", retryable: false })
    }
    expect(sent.some((m) => m._tag === "rtc.answer")).toBe(false)
    expect(s.hasPeer).toBe(false)
    expect(activeRtcPeers()).toBe(before)
  })

  test("answers a Constrained Baseline 3.1 offer by profile, echoing the offered fmtp", async () => {
    const { s, sent } = session()
    const browser = await remoteOffer("video/H264", ["42e01f"])
    closing.push(() => browser.close())
    await s.handle({ _tag: "rtc.offer", sdp: browser.localDescription!.sdp })
    const answer = sent.find((m) => m._tag === "rtc.answer")
    if (answer?._tag !== "rtc.answer") throw new Error("no answer")
    expect(answer.sdp).toContain("profile-level-id=42e01f")
  })

  test("prefers the 42e0 payload when the offer also carries a 42c0 one", async () => {
    const { s, sent } = session()
    const browser = await remoteOffer("video/H264", ["42c028", "42e01f"])
    closing.push(() => browser.close())
    await s.handle({ _tag: "rtc.offer", sdp: browser.localDescription!.sdp })
    const answer = sent.find((m) => m._tag === "rtc.answer")
    if (answer?._tag !== "rtc.answer") throw new Error("no answer")
    expect(answer.sdp).toContain("profile-level-id=42e01f")
    expect(answer.sdp).not.toContain("42c028")
  })

  test("a malformed offer is refused without leaving a peer", async () => {
    const { s, sent } = session()
    const before = activeRtcPeers()
    await s.handle({ _tag: "rtc.offer", sdp: "a=rtpmap:96 H264/90000\r\na=fmtp:96 packetization-mode=1;profile-level-id=640c1f\r\n" })
    await s.handle({ _tag: "rtc.candidate", candidate: "garbage", sdpMid: null, sdpMLineIndex: null })
    expect(sent.at(-1)).toMatchObject({ _tag: "rtc.unavailable" })
    expect(sent.some((m) => m._tag === "rtc.answer")).toBe(false)
    s.close()
    expect(activeRtcPeers()).toBe(before)
  })

  test("reports a failed credential outcome before and after a real offer", async () => {
    const { s, sent } = session()
    s.setIceServers([], false, { source: "managed", status: "unavailable", failure: "turn-credentials", issue: "provider-unavailable" })
    expect(sent.at(-1)).toEqual({
      _tag: "rtc.diagnostics",
      diagnostics: {
        turnSource: "managed",
        turnStatus: "unavailable",
        turnIssue: "provider-unavailable",
        gathering: "idle",
        relayCandidates: 0,
        connection: "new",
        failure: "turn-credentials",
      },
    })
    const browser = await remoteOffer()
    closing.push(() => browser.close())
    await s.handle({ _tag: "rtc.offer", sdp: browser.localDescription!.sdp })
    const diagnostics = lastDiagnostics(sent)
    expect(diagnostics).toMatchObject({
      turnSource: "managed",
      turnStatus: "unavailable",
      gathering: "complete",
      relayCandidates: 0,
      failure: "turn-credentials",
    })
  })

  test("counts a real relay allocation from werift candidates", async () => {
    const relay = await allocationServers()
    const { s, sent } = session()
    const browser = await remoteOffer()
    closing.push(
      () => browser.close(),
      () => relay.close(),
    )
    s.setIceServers([relay.tlsServer], true, { source: "managed", status: "configured", failure: null, issue: null })
    await s.handle({ _tag: "rtc.offer", sdp: browser.localDescription!.sdp })
    const diagnostics = lastDiagnostics(sent)
    expect(diagnostics).toMatchObject({
      turnSource: "managed",
      turnStatus: "configured",
      gathering: "complete",
      failure: null,
    })
    expect(diagnostics?.relayCandidates).toBeGreaterThan(0)
    expect(JSON.stringify(diagnostics)).not.toContain("fixture.invalid")
    expect(JSON.stringify(diagnostics)).not.toContain("tls-user")
  })

  test("werift gets the candidate filter, which refuses metadata and link-local peers", async () => {
    const { s } = session()
    const browser = await remoteOffer()
    closing.push(() => browser.close())
    await s.handle({ _tag: "rtc.offer", sdp: browser.localDescription!.sdp })
    const peer = peerOf(s)
    expect(peer.pc.iceTransports.length).toBeGreaterThan(0)
    for (const transport of peer.pc.iceTransports) {
      // werift keeps the options each connection was built with, and the session's filter is among them.
      const options = transport.connection.options as { readonly filterCandidatePair?: (pair: unknown) => boolean }
      const filter = options.filterCandidatePair
      expect(filter).toBeDefined()
      expect(filter?.({ remoteCandidate: { host: "127.0.0.1" } })).toBe(true)
      expect(filter?.({ remoteCandidate: { host: "8.8.8.8" } })).toBe(true)
      expect(filter?.({ remoteCandidate: { host: "169.254.169.254" } })).toBe(false)
      expect(filter?.({ remoteCandidate: { host: "::ffff:169.254.169.254" } })).toBe(false)
      expect(filter?.({ remoteCandidate: { host: "fe80::1" } })).toBe(false)
    }
  })

  test("managed TURN allocates the later TLS/443 endpoint with its own credentials", async () => {
    const relay = await allocationServers()
    const { s, sent } = session()
    const browser = await remoteOffer()
    closing.push(() => browser.close(), () => relay.close())
    // Cloudflare puts UDP and TLS URLs in one credential entry, with UDP first.
    s.setIceServers([{ ...relay.tlsServer, urls: [...relay.udpServer.urls, ...relay.tlsServer.urls] }], true)
    await s.handle({ _tag: "rtc.offer", sdp: browser.localDescription!.sdp })
    const answer = sent.find((message) => message._tag === "rtc.answer")
    if (!answer) throw new Error("no desktop answer")
    expect(answer.sdp).toContain(` ${relay.tlsAddress[0]} ${relay.tlsAddress[1]} typ relay `)
    expect(answer.sdp).not.toContain(` ${relay.udpAddress[0]} ${relay.udpAddress[1]} typ relay `)
  })

  test("operator TURN retains UDP-first allocation even when TLS/443 is listed later", async () => {
    const relay = await allocationServers()
    const { s, sent } = session()
    const browser = await remoteOffer()
    closing.push(() => browser.close(), () => relay.close())
    s.setIceServers([relay.udpServer, relay.tlsServer], false)
    await s.handle({ _tag: "rtc.offer", sdp: browser.localDescription!.sdp })
    const answer = sent.find((message) => message._tag === "rtc.answer")
    if (!answer) throw new Error("no desktop answer")
    expect(answer.sdp).toContain(` ${relay.udpAddress[0]} ${relay.udpAddress[1]} typ relay `)
    expect(answer.sdp).not.toContain(` ${relay.tlsAddress[0]} ${relay.tlsAddress[1]} typ relay `)
  })

  test("a managed list without TLS/443 still allocates its available UDP relay", async () => {
    const relay = await allocationServers()
    const { s, sent } = session()
    const browser = await remoteOffer()
    closing.push(() => browser.close(), () => relay.close())
    s.setIceServers([relay.udpServer], true)
    await s.handle({ _tag: "rtc.offer", sdp: browser.localDescription!.sdp })
    const answer = sent.find((message) => message._tag === "rtc.answer")
    if (!answer) throw new Error("no desktop answer")
    expect(answer.sdp).toContain(` ${relay.udpAddress[0]} ${relay.udpAddress[1]} typ relay `)
  })

  test("managed TLS gives up before a three-second handshake; operator TLS can still allocate", async () => {
    // This integration case tests werift's real TLS socket deadline. Fake JS time cannot drive the platform handshake.
    const relay = await allocationServers(3_000)
    const managed = session()
    const operator = session()
    const browser = await remoteOffer()
    closing.push(() => browser.close(), () => relay.close())
    managed.s.setIceServers([relay.tlsServer], true)
    operator.s.setIceServers([relay.tlsServer], false)
    await Promise.all([managed, operator].map(({ s }) => s.handle({ _tag: "rtc.offer", sdp: browser.localDescription!.sdp })))
    const managedAnswer = managed.sent.find((message) => message._tag === "rtc.answer")
    const operatorAnswer = operator.sent.find((message) => message._tag === "rtc.answer")
    if (!managedAnswer || !operatorAnswer) throw new Error("no desktop answer")
    expect(managedAnswer.sdp).not.toContain("typ relay")
    expect(operatorAnswer.sdp).toContain(` ${relay.tlsAddress[0]} ${relay.tlsAddress[1]} typ relay `)
    // The failed allocation is reported while gathering itself completed: direct host candidates still exist.
    expect(lastDiagnostics(managed.sent)).toMatchObject({
      turnSource: "managed",
      turnStatus: "configured",
      gathering: "complete",
      relayCandidates: 0,
      failure: "relay-allocation",
    })
    expect(lastDiagnostics(operator.sent)).toMatchObject({
      turnSource: "local",
      turnStatus: "configured",
      gathering: "complete",
      failure: null,
    })
  }, 10_000)

  test("a direct connection clears a relay-allocation failure but keeps the missing relay evidence", async () => {
    const relay = await allocationServers(3_000)
    const { s, sent } = session()
    const browser = await remoteOffer()
    closing.push(() => browser.close(), () => relay.close())
    s.setIceServers([relay.tlsServer], true, { source: "managed", status: "configured", failure: null, issue: null })
    await s.handle({ _tag: "rtc.offer", sdp: browser.localDescription!.sdp })
    const answer = sent.find((message) => message._tag === "rtc.answer")
    if (!answer) throw new Error("no desktop answer")
    expect(lastDiagnostics(sent)).toMatchObject({ gathering: "complete", relayCandidates: 0, failure: "relay-allocation" })
    await browser.setRemoteDescription({ type: "answer", sdp: answer.sdp })
    for (let i = 0; i < 100 && browser.connectionState !== "connected"; i++) await Bun.sleep(50)
    expect(browser.connectionState).toBe("connected")
    expect(lastDiagnostics(sent)).toMatchObject({
      turnSource: "managed",
      turnStatus: "configured",
      gathering: "complete",
      relayCandidates: 0,
      connection: "connected",
      failure: null,
    })
  }, 10_000)

  test("the viewer limit holds when every offer is answered at once", async () => {
    const before = activeRtcPeers()
    const offers = await Promise.all(
      Array.from({ length: 17 }, async () => {
        const { s, sent } = session()
        const browser = await remoteOffer()
        closing.push(() => browser.close())
        return { answered: s.handle({ _tag: "rtc.offer", sdp: browser.localDescription!.sdp }), sent }
      }),
    )
    await Promise.all(offers.map(({ answered }) => answered))
    expect(activeRtcPeers() - before).toBe(16)
    expect(offers.filter(({ sent }) => sent.some((m) => m._tag === "rtc.answer"))).toHaveLength(16)
    expect(offers.filter(({ sent }) => sent.some((m) => m._tag === "rtc.unavailable"))).toHaveLength(1)
  }, 20_000)

  test("inbound STUN is authenticated and address-filtered before werift responds or probes", async () => {
    const browser = await remoteOffer()
    closing.push(() => browser.close())
    const socket = createSocket("udp4")
    closing.push(() => socket.close())
    await new Promise<void>((resolve) => socket.bind(0, "127.0.0.1", resolve))
    const packets: Buffer[] = []
    socket.on("message", (packet) => packets.push(packet))
    const sourcePort = socket.address().port

    for (const denyPrivate of [false, true]) {
      const { s } = session({ denyPrivate })
      await s.handle({ _tag: "rtc.offer", sdp: browser.localDescription!.sdp })
      const peer = peerOf(s)
      const connection = peer.pc.iceTransports[0]!.connection
      const candidate = connection.localCandidates.find((c) => c.host === "127.0.0.1" && c.transport === "udp")
      if (!candidate) throw new Error("no loopback candidate")
      const send = async (username: string, password?: string) => {
        const request = new Message(methods.BINDING, classes.REQUEST)
        request.setAttribute("USERNAME", username)
        request.setAttribute("PRIORITY", 1234)
        // A role conflict used to elicit an error before iceFilterStunResponse ran.
        request.setAttribute("ICE-CONTROLLED", 0xffffffffffffffffn)
        if (password !== undefined) request.addMessageIntegrity(Buffer.from(password))
        socket.send(request.bytes, candidate.port, "127.0.0.1")
        await Bun.sleep(120)
      }
      const username = `${connection.localUsername}:${connection.remoteUsername}`
      await send(username)
      await send(username, "wrong-password")
      await send(`wrong:${connection.remoteUsername}`, connection.localPassword)
      expect(packets).toHaveLength(0)
      expect(connection.candidatePairs.some((p) => p.remoteCandidate.port === sourcePort)).toBe(false)
      await send(username, connection.localPassword)
      if (denyPrivate) {
        expect(packets).toHaveLength(0)
        expect(connection.candidatePairs.some((p) => p.remoteCandidate.port === sourcePort)).toBe(false)
      } else {
        expect(packets.length).toBeGreaterThan(0)
      }
      packets.length = 0
      s.close()
    }
  }, 10_000)

  test("negotiates, connects, carries input, and gathers no reflexive candidates unasked", async () => {
    const { s, sent, inputs } = session()
    const before = activeRtcPeers()
    const browser = await remoteOffer()
    closing.push(() => browser.close())
    await s.handle({ _tag: "rtc.offer", sdp: browser.localDescription!.sdp })
    expect(activeRtcPeers()).toBe(before + 1)
    const answer = sent.find((m) => m._tag === "rtc.answer")
    if (answer?._tag !== "rtc.answer") throw new Error("no answer")
    expect(answer.sdp).not.toContain("typ srflx")
    expect(answer.sdp).toContain("H264")
    expect(answer.sdp).toContain("profile-level-id=42e028")
    expect(answer.sdp).toContain("a=sendonly")
    await browser.setRemoteDescription({ type: "answer", sdp: answer.sdp })
    for (let i = 0; i < 100 && browser.connectionState !== "connected"; i++) await Bun.sleep(50)
    expect(browser.connectionState).toBe("connected")
    expect(s.hasPeer).toBe(true)
    // Simulate an ICE implementation rejecting a late candidate after a pair has already connected.
    const peer = peerOf(s)
    const addCandidate = peer.pc.addIceCandidate.bind(peer.pc)
    peer.pc.addIceCandidate = async () => { throw new Error("invalid candidate") }
    await s.handle({ _tag: "rtc.candidate", candidate: "garbage", sdpMid: null, sdpMLineIndex: null })
    peer.pc.addIceCandidate = addCandidate
    expect(s.hasPeer).toBe(true)
    expect(sent.some((m) => m._tag === "rtc.unavailable")).toBe(false)
    for (let i = 0; i < 100 && browser.channel.readyState !== "open"; i++) await Bun.sleep(20)
    browser.channel.send('{"_tag":"mouse.move","x":0.5,"y":0.5}')
    for (let i = 0; i < 100 && inputs.length === 0; i++) await Bun.sleep(20)
    expect(inputs).toEqual(['{"_tag":"mouse.move","x":0.5,"y":0.5}'])
    expect(inputs).toHaveLength(1)
  }, 20_000)

  test("closing releases the peer, and a later offer on a closed session does nothing", async () => {
    const { s } = session()
    const before = activeRtcPeers()
    const browser = await remoteOffer()
    closing.push(() => browser.close())
    await s.handle({ _tag: "rtc.offer", sdp: browser.localDescription!.sdp })
    expect(activeRtcPeers()).toBe(before + 1)
    s.close()
    expect(activeRtcPeers()).toBe(before)
    expect(s.hasPeer).toBe(false)
    await s.handle({ _tag: "rtc.offer", sdp: browser.localDescription!.sdp })
    expect(activeRtcPeers()).toBe(before)
  })

  test("a second offer replaces the first peer", async () => {
    const { s } = session()
    const before = activeRtcPeers()
    const a = await remoteOffer()
    const b = await remoteOffer()
    closing.push(
      () => a.close(),
      () => b.close(),
    )
    await s.handle({ _tag: "rtc.offer", sdp: a.localDescription!.sdp })
    await s.handle({ _tag: "rtc.offer", sdp: b.localDescription!.sdp })
    expect(activeRtcPeers()).toBe(before + 1)
  })
})
