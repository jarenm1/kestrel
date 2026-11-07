import type { H264EncoderProfile } from "./h264"

/** What the encoder needs to know about a viewer: whether its payload is Constrained Baseline only (see webrtc.ts). */
export interface ProfileSink {
  readonly baselineOnly: boolean
}

/**
 * The profile a desktop's encoder must produce for its viewers: Constrained Baseline while any of them decodes only
 * Baseline, High otherwise. A viewer that cannot decode High drops every frame of a High stream, so the stream follows
 * its narrowest viewer.
 */
export const profileFor = (sinks: Iterable<ProfileSink>): H264EncoderProfile =>
  [...sinks].some((sink) => sink.baselineOnly) ? "baseline" : "high"

/**
 * Whether a live encoder in `current` must restart to serve `sinks`, whose required profile changed because a viewer
 * attached or left. No viewers means nothing to serve: the encoder is left to its linger timer.
 */
export const profileRestartNeeded = (sinks: Iterable<ProfileSink>, current: H264EncoderProfile | null): boolean => {
  if (current === null) return false
  const viewers = [...sinks]
  return viewers.length > 0 && profileFor(viewers) !== current
}
