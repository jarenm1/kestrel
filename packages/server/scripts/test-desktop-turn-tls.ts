/** Real TURN integration regression. See docs/box.md, "TLS-only TURN regression" for the isolated fixture. */
import assert from "node:assert/strict"
import { setTimeout as delay } from "node:timers/promises"
import type { DesktopRtcServerMessage } from "@cloudagents/protocol"
import { RTCPeerConnection, RTCRtpCodecParameters } from "werift"
import { DesktopRtcSession } from "../src/desktop/webrtc"
import { MediaTap } from "../src/desktop/rtp"

const host = process.env.KESTREL_TEST_TURN_HOST ?? "localhost"
const relay = {
  urls: [
    `turn:${host}:3478?transport=udp`,
    `turn:${host}:3478?transport=tcp`,
    `turns:${host}:5349?transport=tcp`,
    `turns:${host}:443?transport=tcp`,
  ],
  username: "smoke",
  credential: "smoke-password",
}

async function exercise(managed: boolean): Promise<void> {
  const browser = new RTCPeerConnection({
    iceServers: [{ ...relay, urls: [relay.urls[3]!] }],
    iceTransportPolicy: "relay",
    iceFilterCandidatePair: (pair) => pair.remoteCandidate.type === "relay",
    codecs: { video: [new RTCRtpCodecParameters({ mimeType: "video/H264", clockRate: 90_000, parameters: "packetization-mode=1;profile-level-id=42e028" })] },
  })
  browser.addTransceiver("video", { direction: "recvonly" })
  const input = browser.createDataChannel("input")
  const received: string[] = []
  let videoPacket: Buffer | undefined
  browser.onTrack.subscribe((track) => track.onReceiveRtp.subscribe((packet) => { videoPacket = packet.payload }))
  const tap = new MediaTap()
  const sent: DesktopRtcServerMessage[] = []
  const session = new DesktopRtcSession({ iceServers: [], turn: null, policy: "all", portRange: null, hostAddresses: ["127.0.0.1"], denyPrivate: false }, "turn-regression", tap, {
    send: (message) => { sent.push(message) },
    onInput: (raw) => received.push(raw),
    profileChanged: () => {},
    debug: console.error,
  })
  session.setIceServers([relay], managed)

  // This runs in its own process, not the unit-test worker. Suppress box host candidates to model an unreachable box:
  // success must use both relays, not accidentally pass over loopback/direct ICE. Restore before the next case.
  const setLocalDescription = RTCPeerConnection.prototype.setLocalDescription
  RTCPeerConnection.prototype.setLocalDescription = new Proxy(setLocalDescription, {
    apply(target, peer: RTCPeerConnection, args: unknown[]) {
      if (peer !== browser) for (const transport of peer.iceTransports) transport.connection.options.forceTurn = true
      return Reflect.apply(target, peer, args)
    },
  })
  const deadline = setTimeout(() => { console.error("TURN integration timed out"); process.exit(1) }, 25_000)
  try {
    await browser.setLocalDescription(await browser.createOffer())
    assert(browser.localDescription!.sdp.includes("typ relay"), "fixture must allocate the viewer's TLS relay")
    const started = performance.now()
    await session.handle({ _tag: "rtc.offer", sdp: browser.localDescription!.sdp })
    const answer = sent.find((message) => message._tag === "rtc.answer")
    assert(answer, "desktop session must answer")
    const hasRelay = answer.sdp.includes("typ relay")
    console.log(JSON.stringify({ managed, answerMs: Math.round(performance.now() - started), boxRelayCandidate: hasRelay }))
    assert.equal(hasRelay, managed, managed
      ? "managed allocation must reach TLS/443 despite unreachable earlier URLs"
      : "operator TURN order must remain UDP-first, not be silently replaced with managed TLS preference")
    if (!managed) return

    await browser.setRemoteDescription({ type: "answer", sdp: answer.sdp })
    for (let i = 0; i < 200 && input.readyState !== "open"; i++) await delay(50)
    assert.equal(input.readyState, "open")
    const command = '{"_tag":"key.down","key":"a"}'
    input.send(command)
    const config = {
      kind: "config",
      config: {
        profileIdc: 66,
        lengthBytes: 4,
        nals: [Uint8Array.of(0x67, 0x42, 0xe0, 0x28), Uint8Array.of(0x68, 0xce)],
        avcc: Uint8Array.of(1, 0x42, 0xe0, 0x28, 0xff, 0xe1, 0, 4, 0x67, 0x42, 0xe0, 0x28, 1, 0, 2, 0x68, 0xce),
      },
    } as const
    tap.push(config)
    session.push(config)
    const frame = { kind: "key", au: Uint8Array.of(0, 0, 0, 4, 0x65, 0x88, 0x84, 0x21) } as const
    tap.push(frame)
    session.push(frame)
    for (let i = 0; i < 100 && (received.length === 0 || !videoPacket); i++) await delay(50)
    assert.deepEqual(received, [command])
    assert.deepEqual(videoPacket, Buffer.from([0x65, 0x88, 0x84, 0x21]))
    const pair = browser.iceTransports[0]!.connection.nominated!
    assert.equal(pair.localCandidate.type, "relay")
    assert.equal(pair.remoteCandidate.type, "relay")
  } finally {
    clearTimeout(deadline)
    RTCPeerConnection.prototype.setLocalDescription = setLocalDescription
    session.close()
    await browser.close()
  }
}

await exercise(true)
await exercise(false)
console.log("PASS: managed TLS-only relay carries exact desktop RTP/input; operator URL order preserved")
