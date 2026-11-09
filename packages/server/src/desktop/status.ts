import {
  DEFAULT_DESKTOP_QUALITY,
  DESKTOP_QUALITIES,
  type DesktopQuality,
  type DesktopState,
  type DesktopStatus,
} from "@cloudagents/protocol"

/** The desktop's own resolution; the encoder's quality only changes the stream. */
export const WIDTH = 2560
export const HEIGHT = 1440

/** What `desktopStatus` needs from a session. Kept separate so the status projection has no manager state. */
export interface DesktopStatusSource {
  readonly state: DesktopState
  readonly display: string
  readonly quality: DesktopQuality
  readonly error: string | null
  /** An encoder is present (booting or live). `state` alone cannot tell this. */
  readonly streaming: boolean
}

/**
 * The status a client sees. `state` is the lifecycle and `streaming` says whether an encoder exists, so a running
 * desktop with its encoder idled out is not mistaken for a live stream. Only `starting` and `running` may be attached
 * to: a `failed` session has no live processes and no display, and its error is still shown so the viewer sees why.
 */
export const desktopStatus = (taskId: string, source: DesktopStatusSource | undefined): DesktopStatus => {
  const attachable = source !== undefined && (source.state === "starting" || source.state === "running")
  const quality = attachable ? source.quality : DEFAULT_DESKTOP_QUALITY
  return {
    taskId,
    state: source?.state ?? "stopped",
    streaming: source?.streaming ?? false,
    display: attachable ? source.display : null,
    width: WIDTH,
    height: HEIGHT,
    fps: DESKTOP_QUALITIES[quality].fps,
    quality,
    error: source !== undefined && source.state !== "stopped" ? source.error : null,
  }
}
