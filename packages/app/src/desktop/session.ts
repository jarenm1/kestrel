import type { DesktopInput, DesktopStatus } from "@cloudagents/protocol"
import { type DesktopSource, openDesktopStream } from "@/api/events"
import { DesktopRtc, type RtcStats, type RtcState } from "@/desktop/webrtc"

/** How the WebSocket ended. `opened` false means the handshake was refused or failed (auth, or no box). */
export interface DesktopClose {
  code: number | null
  opened: boolean
}

export interface DesktopSessionListeners {
  onStatus: (status: DesktopStatus) => void
  onRtc: (state: RtcState) => void
  onStats: (stats: RtcStats) => void
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
 */
export function startDesktopSession(
  source: DesktopSource,
  video: HTMLVideoElement,
  listeners: DesktopSessionListeners,
): DesktopSession {
  const rtc = new DesktopRtc(video, {
    send: (message) => stream.send(message),
    onState: listeners.onRtc,
    onStats: listeners.onStats,
    onAudio: listeners.onAudio,
  })
  const stream = openDesktopStream(source, {
    onStatus: listeners.onStatus,
    onSignal: (message) => rtc.handle(message),
    onClose: (close) => {
      rtc.close()
      listeners.onClose(close)
    },
  })
  return {
    sendInput: (message, pointer = false) => rtc.sendInput(message, pointer),
    close: () => {
      rtc.close()
      stream.close()
    },
  }
}
