import { describe, expect, test } from "bun:test"
import { DESKTOP_QUALITIES, type DesktopQuality } from "@cloudagents/protocol"
import { type H264EncoderProfile, WEBRTC_H264_LEVEL } from "./h264"
import { ffmpegArgs } from "./manager"

// H.264 level 4.0 limits (Table A-1): macroblocks per frame and macroblocks per second.
const LEVEL_4_0 = { maxFrameMbs: 8192, maxMbPerSecond: 245760 }

const argAfter = (args: readonly string[], flag: string): string | undefined => {
  const i = args.indexOf(flag)
  return i < 0 ? undefined : args[i + 1]
}

const QUALITIES = Object.keys(DESKTOP_QUALITIES) as DesktopQuality[]
const KINDS = ["nvenc", "x264"] as const
const PROFILES: readonly H264EncoderProfile[] = ["high", "baseline"]

describe("WebRTC H.264 profile", () => {
  test("the encoder is level 4.0, High or Constrained Baseline", () => {
    expect(WEBRTC_H264_LEVEL).toBe("4.0")
  })

  test("level 4.0 covers every desktop quality", () => {
    for (const q of QUALITIES) {
      const { width, height, fps } = DESKTOP_QUALITIES[q]
      const mbs = Math.ceil(width / 16) * Math.ceil(height / 16)
      expect(mbs).toBeLessThanOrEqual(LEVEL_4_0.maxFrameMbs)
      expect(mbs * fps).toBeLessThanOrEqual(LEVEL_4_0.maxMbPerSecond)
    }
  })

  for (const kind of KINDS) {
    for (const profile of PROFILES) {
      test(`${kind} encodes ${profile} at the pinned level from 4:2:0 bgr0 input, with no B-frames`, () => {
        for (const q of QUALITIES) {
          const args = ffmpegArgs(kind, q, profile)
          expect(argAfter(args, "-profile:v")).toBe(profile)
          expect(argAfter(args, "-level:v")).toBe(WEBRTC_H264_LEVEL)
          expect(argAfter(args, "-bf")).toBe("0")
          // NVENC makes 4:2:0 from bgr0; an RGB 4:4:4 source would produce High 4:4:4 regardless of profile.
          expect(args).toContain("bgr0")
        }
      })
    }
  }

  test("the GPU scaler is bicubic (interp_algo 3); the CPU path keeps area averaging", () => {
    for (const q of QUALITIES) {
      expect(argAfter(ffmpegArgs("nvenc", q, "high"), "-vf")).toContain("scale_cuda=")
      expect(argAfter(ffmpegArgs("nvenc", q, "high"), "-vf")).toContain("interp_algo=3")
      expect(argAfter(ffmpegArgs("x264", q, "high"), "-vf")).toContain("flags=area")
      // An ffmpeg without the CUDA filters keeps NVENC, scaling on the CPU to 4:2:0, and asks for no CUDA device.
      const noCuda = ffmpegArgs("nvenc", q, "high", false)
      expect(argAfter(noCuda, "-vf")).toContain("flags=area,format=yuv420p")
      expect(noCuda).not.toContain("-init_hw_device")
      expect(noCuda).toContain("h264_nvenc")
    }
  })
})
