import { expect, test } from "bun:test"
import { serializeDiagnostics, type RtcDiagnostics } from "./diagnostics"

test("copied diagnostics cannot acquire credentials, addresses or raw reports through extra metadata", () => {
  const secret = "private-do-not-copy"
  // Structural extra fields model metadata accidentally attached by a future stats or signaling implementation.
  const box = {
    turnSource: "managed", turnStatus: "configured", gathering: "complete", relayCandidates: 1, connection: "connected", failure: null,
    iceServers: [{ urls: [`turns://${secret}:443`], username: secret, credential: secret }],
  } as const
  const selectedPair = { local: "host", remote: "relay", protocol: "udp", relayProtocol: "tls", address: secret, url: secret } as const
  const iceErrors = [{ code: 701, transport: "turn-tls", errorText: secret, url: secret, address: secret }] as const
  const report = {
    attempt: 2, config: "ready", turnServers: 1, viewerRelayCandidates: 1, viewerGathering: "complete", connection: "connected",
    selectedPair, videoBytes: 1024, videoPackets: 8, framesDecoded: 3, lastFailure: null,
    iceErrors,
    box, sdp: secret, token: secret, rawStats: { credential: secret },
  } satisfies RtcDiagnostics & { sdp: string; token: string; rawStats: { credential: string } }
  const copied = serializeDiagnostics(report)
  expect(copied).not.toContain(secret)
  for (const field of ["iceServers", "username", "credential", "address", "url", "errorText", "sdp", "token", "rawStats"]) {
    expect(copied).not.toContain(`"${field}"`)
  }
})
