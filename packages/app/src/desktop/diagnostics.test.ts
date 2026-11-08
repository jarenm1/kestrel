import { expect, test } from "bun:test"
import { diagnosticSummary, serializeDiagnostics, type RtcDiagnostics } from "./diagnostics"

test("copied diagnostics cannot acquire credentials, addresses or raw reports through extra metadata", () => {
  const secret = "private-do-not-copy"
  // Structural extra fields model metadata accidentally attached by a future stats or signaling implementation.
  const box = {
    turnSource: "managed", turnStatus: "unavailable", turnIssue: "provider-unavailable", gathering: "complete", relayCandidates: 0, connection: "connecting", failure: "turn-credentials",
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
  expect(JSON.parse(copied).box.turnIssue).toBe("provider-unavailable")
  for (const field of ["iceServers", "username", "credential", "address", "url", "errorText", "sdp", "token", "rawStats"]) {
    expect(copied).not.toContain(`"${field}"`)
  }
})

test("a safe TURN issue identifies an operator fix before generic evidence", () => {
  const report: RtcDiagnostics = {
    attempt: 1, config: "ready", turnServers: 0, viewerRelayCandidates: 0, viewerGathering: "complete",
    connection: "connecting", selectedPair: null, videoBytes: null, videoPackets: null, framesDecoded: null,
    lastFailure: null, iceErrors: [],
    box: {
      turnSource: "managed", turnStatus: "unavailable", turnIssue: "configuration-incomplete",
      gathering: "complete", relayCandidates: 0, connection: "connecting", failure: "turn-credentials",
    },
  }
  expect(diagnosticSummary(report)).toContain("key id and API token")
  expect(diagnosticSummary({ ...report, box: { ...report.box!, turnIssue: "expired" } })).toContain("box clock")
})
