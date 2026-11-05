/**
 * The H.264 encoder settings for desktop WebRTC. One encoder serves every viewer and quality, and its profile follows
 * the viewers connected now (manager.ts): Constrained High (the High profile with no B-frames) by default, and
 * Constrained Baseline while a viewer decodes only Baseline (an OpenH264-only browser). Both are 4:2:0 and both
 * hardware encoders (NVENC, libx264) produce them. A Constrained Baseline stream also decodes on a High decoder, so a
 * viewer answered with a High payload takes either profile.
 *
 * The SPS carries level 4.0, which fits both desktop qualities (1080p30 needs 4.0; 720p60 fits it). Negotiation matches
 * the profile only, so the level a browser offers does not decide the answer, and the answer echoes the offered format.
 */
export type H264EncoderProfile = "baseline" | "high"
export const WEBRTC_H264_LEVEL = "4.0"
