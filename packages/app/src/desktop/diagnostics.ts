import type { DesktopRtcBoxDiagnostics } from "@cloudagents/protocol"

export type CandidateKind = "host" | "srflx" | "prflx" | "relay" | "unknown"
export type IceTransport = "udp" | "tcp" | "tls" | "unknown"
export type RtcFailure = "timeout" | "connection" | "negotiation" | "video-stalled" | "refused" | "unsupported" | "playback"

/** Explicitly allowlisted evidence suitable for copying into a bug report. No browser reports or raw errors. */
export interface RtcDiagnostics {
  attempt: number
  config: "waiting" | "ready" | "refreshing"
  turnServers: number
  viewerRelayCandidates: number
  viewerGathering: RTCIceGatheringState | "unknown"
  connection: RTCPeerConnectionState | "unknown"
  selectedPair: {
    local: CandidateKind
    remote: CandidateKind
    protocol: IceTransport
    relayProtocol: IceTransport
  } | null
  /** Null until the browser actually reports the counter; an omitted field is not a measured zero. */
  videoBytes: number | null
  videoPackets: number | null
  framesDecoded: number | null
  lastFailure: RtcFailure | null
  iceErrors: ReadonlyArray<{ code: number; transport: "stun" | "turn-udp" | "turn-tcp" | "turn-tls" | "unknown" }>
  box: DesktopRtcBoxDiagnostics | null
}

/** Evidence, not a claim about the network: candidates and ICE connection do not prove video decoding. */
export function diagnosticSummary(d: RtcDiagnostics): string {
  if (d.config === "waiting") return "Waiting for connection settings from the box."
  if (d.config === "refreshing") return "Refreshing connection settings before retrying."
  if (d.connection === "connected") {
    if ((d.framesDecoded ?? 0) > 0) return "Desktop video frames have decoded."
    if ((d.videoBytes ?? 0) > 0 || (d.videoPackets ?? 0) > 0) {
      return d.framesDecoded === null
        ? "Video is arriving; decoded-frame statistics are unavailable."
        : "Video is arriving, but no frames have decoded yet."
    }
    if (d.videoBytes === null && d.videoPackets === null) return "WebRTC connected; waiting for video statistics."
    return "WebRTC connected; waiting for video packets."
  }
  if (d.lastFailure === "playback") return "Video playback was blocked or failed in this browser."
  if (d.lastFailure === "video-stalled") return "Video stopped progressing after the stream started."
  if (d.lastFailure === "negotiation") return "WebRTC negotiation failed."
  if (d.lastFailure === "refused") return "The box declined this stream attempt."
  if (d.lastFailure === "unsupported") return "This browser or box cannot serve this WebRTC stream."
  if (d.box?.turnStatus === "unavailable") return "The box could not obtain usable TURN credentials."
  if (d.turnServers === 0) return "No authenticated TURN relay is available; only direct WebRTC can connect."
  if (d.box?.turnStatus === "configured" && d.box.relayCandidates === 0 &&
    (d.box.gathering === "complete" || d.box.failure === "relay-allocation")) {
    return "The box did not obtain a TURN relay candidate."
  }
  if (d.viewerGathering === "complete" && d.viewerRelayCandidates === 0) {
    return "This browser finished gathering without a TURN relay candidate."
  }
  if (d.lastFailure === "timeout" || d.lastFailure === "connection") {
    return "WebRTC did not connect. Candidate gathering alone does not prove a working path."
  }
  return "Gathering candidates and negotiating the connection."
}

/** Project every field explicitly: future browser/box metadata cannot accidentally enter a copied report. */
export function serializeDiagnostics(d: RtcDiagnostics): string {
  return JSON.stringify({
    version: 1,
    attempt: d.attempt,
    config: d.config,
    turnServers: d.turnServers,
    viewerRelayCandidates: d.viewerRelayCandidates,
    viewerGathering: d.viewerGathering,
    connection: d.connection,
    selectedPair: d.selectedPair === null ? null : {
      local: d.selectedPair.local,
      remote: d.selectedPair.remote,
      protocol: d.selectedPair.protocol,
      relayProtocol: d.selectedPair.relayProtocol,
    },
    videoBytes: d.videoBytes,
    videoPackets: d.videoPackets,
    framesDecoded: d.framesDecoded,
    lastFailure: d.lastFailure,
    iceErrors: d.iceErrors.map(({ code, transport }) => ({ code, transport })),
    box: d.box === null ? null : {
      turnSource: d.box.turnSource,
      turnStatus: d.box.turnStatus,
      gathering: d.box.gathering,
      relayCandidates: d.box.relayCandidates,
      connection: d.box.connection,
      failure: d.box.failure,
    },
  }, null, 2)
}
