import { describe, expect, test } from "bun:test"
import { FlvMuxer, flvHeader } from "./clip"
import { FlvDemuxer, type FlvEvent } from "./flv"

const SPS = Uint8Array.from([0x67, 0x64, 0x00, 0x28, 0xac])
const PPS = Uint8Array.from([0x68, 0xee, 0x3c, 0x80])
const AVCC = Uint8Array.from([1, 0x64, 0x00, 0x28, 0xff, 0xe1, 0, SPS.length, ...SPS, 1, 0, PPS.length, ...PPS])

const lengthPrefixed = (...nals: Uint8Array[]): Uint8Array =>
  Uint8Array.from(nals.flatMap((n) => [(n.length >>> 24) & 0xff, (n.length >>> 16) & 0xff, (n.length >>> 8) & 0xff, n.length & 0xff, ...n]))

const KEY = lengthPrefixed(Uint8Array.from([0x65, 0x11, 0x22]))
const DELTA = lengthPrefixed(Uint8Array.from([0x41, 0x33]))

/** Muxes with a collector, then reads the same bytes back with the demuxer the desktop already uses. */
const roundTrip = (build: (muxer: FlvMuxer) => void): { bytes: Uint8Array[]; events: FlvEvent[] } => {
  const bytes: Uint8Array[] = []
  const muxer = new FlvMuxer((chunk) => bytes.push(chunk))
  build(muxer)
  const demuxer = new FlvDemuxer()
  const events = bytes.flatMap((chunk) => demuxer.push(chunk))
  return { bytes, events }
}

describe("FLV muxer", () => {
  test("writes a video-only FLV header", () => {
    const header = flvHeader()
    expect([...header.slice(0, 9)]).toEqual([0x46, 0x4c, 0x56, 1, 1, 0, 0, 0, 9])
    expect([...header.slice(9)]).toEqual([0, 0, 0, 0])
  })

  test("the demuxer reads back the sequence header, keyframe and delta with their timestamps", () => {
    const { bytes, events } = roundTrip((muxer) => {
      muxer.sequenceHeader(AVCC)
      muxer.videoTag(KEY, true, 0)
      muxer.videoTag(DELTA, false, 33)
    })
    expect(bytes[0]!.slice(0, 4)).toEqual(Uint8Array.from([0x46, 0x4c, 0x56, 1]))
    expect(events).toHaveLength(3)
    expect(events[0]).toMatchObject({ kind: "config" })
    expect([...((events[0] as Extract<FlvEvent, { kind: "config" }>).avcc)]).toEqual([...AVCC])
    expect(events[1]).toMatchObject({ kind: "frame", dts: 0, keyframe: true })
    expect([...((events[1] as Extract<FlvEvent, { kind: "frame" }>).data)]).toEqual([...KEY])
    expect(events[2]).toMatchObject({ kind: "frame", dts: 33, keyframe: false })
    expect([...((events[2] as Extract<FlvEvent, { kind: "frame" }>).data)]).toEqual([...DELTA])
  })

  test("keeps timestamps monotonic and carries the 32-bit extension", () => {
    const { events } = roundTrip((muxer) => {
      muxer.sequenceHeader(AVCC)
      muxer.videoTag(KEY, true, 0x01000005)
      // A clock that steps back must not produce a tag before the previous one.
      muxer.videoTag(DELTA, false, 10)
    })
    const frames = events.filter((event): event is Extract<FlvEvent, { kind: "frame" }> => event.kind === "frame")
    expect(frames.map((frame) => frame.dts)).toEqual([0x01000005, 0x01000005])
  })

  test("a second sequence header after an encoder restart is written at the current time", () => {
    const { events } = roundTrip((muxer) => {
      muxer.sequenceHeader(AVCC)
      muxer.videoTag(KEY, true, 0)
      muxer.videoTag(DELTA, false, 100)
      muxer.sequenceHeader(AVCC, 100)
      muxer.videoTag(KEY, true, 100)
    })
    expect(events.map((event) => event.kind)).toEqual(["config", "frame", "frame", "config", "frame"])
  })
})
