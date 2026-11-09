import type { DesktopInput, DesktopStatus } from "@cloudagents/protocol"
import { type DesktopConnection, type DesktopSource, openDesktopStream } from "@/api/events"
import type { RtcDiagnostics } from "@/desktop/diagnostics"
import { DesktopRtc, type RtcStats, type RtcState } from "@/desktop/webrtc"
import { DesktopStreamAuthority } from "@/desktop/status"

/** How the WebSocket ended. `opened` false means the handshake was refused or failed (auth, or no box). */
export interface DesktopClose {
  code: number | null
  opened: boolean
}

/** A signalling socket that closed while the viewer still wants the stream reconnects after this long. */
const RECONNECT_MS = 2000

export interface DesktopSessionListeners {
  onStatus: (status: DesktopStatus) => void
  onRtc: (state: RtcState) => void
  onStats: (stats: RtcStats) => void
  /** Redacted connection evidence for a bug report, copied per emit. */
  onDiagnostics: (diagnostics: RtcDiagnostics) => void
  onAudio: (available: boolean) => void
  /** The WebSocket closed, or never opened. The WebRTC session is already torn down when this fires. */
  onClose: (close: DesktopClose) => void
}

export interface DesktopSession {
  /** Sends input over WebRTC: pointer moves on the unreliable channel, everything else on the ordered one. */
  sendInput: (message: DesktopInput, pointer?: boolean) => boolean
  close: () => void
}

/**
 * One desktop viewing session: the WebSocket for status and signaling, and the WebRTC peer that plays into `video`.
 * Closing it tears both down without reporting `onClose`.
 *
 * Retries have one owner per layer: this function reconnects a closed signalling socket, and `DesktopRtc` owns
 * negotiation failures and refusals with its own 1→30 s backoff. Keeping the same `DesktopRtc` across a socket
 * reconnect means a refusal or failed attempt is never answered by a fresh offer two seconds later.
 */
export function startDesktopSession(
  source: DesktopSource,
  video: HTMLVideoElement,
  listeners: DesktopSessionListeners,
): DesktopSession {
  let stream: DesktopConnection | undefined
  let retry: number | undefined
  let closed = false
  // Authority follows the socket, not the viewer's intent: it is claimed by the first frame and released on close.
  const authority = new DesktopStreamAuthority()
  const rtc = new DesktopRtc(video, {
    send: (message) => stream?.send(message),
    onState: listeners.onRtc,
    onStats: listeners.onStats,
    onDiagnostics: listeners.onDiagnostics,
    onAudio: listeners.onAudio,
  })

  const connect = () => {
    if (closed) return
    stream = openDesktopStream(source, {
      onStatus: (status) => {
        authority.frame(status.taskId)
        listeners.onStatus(status)
      },
      onSignal: (message) => rtc.handle(message),
      onClose: (close) => {
        if (closed) return
        authority.close()
        rtc.disconnect()
        listeners.onClose(close)
        retry = window.setTimeout(connect, rtc.reconnectDelay(RECONNECT_MS))
      },
    })
  }
  connect()

  return {
    sendInput: (message, pointer = false) => rtc.sendInput(message, pointer),
    close: () => {
      closed = true
      window.clearTimeout(retry)
      authority.close()
      rtc.close()
      stream?.close()
    },
  }
}
