import { describe, expect, test } from "bun:test"
import { RTC_FRAGMENT_BYTES, RTC_MAX_MESSAGE_BYTES, RtcReassembler, type RtcMessage, fragmentMessage } from "./src/rtc"

/** Pushes every fragment in order and returns the message the last one completes. */
function reassemble(message: RtcMessage): { readonly fragments: number; readonly result: RtcMessage | null } {
  const fragments = fragmentMessage(message)
  const reassembler = new RtcReassembler()
  let result: RtcMessage | null = null
  for (const fragment of fragments) result = reassembler.push(fragment)
  return { fragments: fragments.length, result }
}

describe("channel fragments", () => {
  test("a text message split across fragments comes back whole", () => {
    const text = "x".repeat(RTC_FRAGMENT_BYTES * 2 + 5)
    const { fragments, result } = reassemble({ text: true, data: text })
    expect(fragments).toBe(3)
    expect(result).toEqual({ text: true, data: text })
  })

  test("a binary message split across fragments comes back byte for byte", () => {
    const bytes = new Uint8Array(RTC_FRAGMENT_BYTES * 3).map((_, i) => i % 251)
    const { fragments, result } = reassemble({ text: false, data: bytes })
    expect(fragments).toBe(3)
    expect(result?.text).toBe(false)
    expect(result?.data).toEqual(bytes)
  })

  test("an empty message is one fragment and comes back empty", () => {
    const { fragments, result } = reassemble({ text: false, data: new Uint8Array(0) })
    expect(fragments).toBe(1)
    expect(result).toEqual({ text: false, data: new Uint8Array(0) })
  })

  test("the message is only returned once its last fragment arrives", () => {
    const fragments = fragmentMessage({ text: true, data: "y".repeat(RTC_FRAGMENT_BYTES + 1) })
    const reassembler = new RtcReassembler()
    expect(reassembler.push(fragments[0] ?? new Uint8Array())).toBeNull()
    expect(reassembler.push(fragments[1] ?? new Uint8Array())?.text).toBe(true)
  })

  test("a message above the size limit is rejected", () => {
    const oversize = fragmentMessage({ text: false, data: new Uint8Array(RTC_MAX_MESSAGE_BYTES + 1) })
    const reassembler = new RtcReassembler()
    expect(() => {
      for (const fragment of oversize) reassembler.push(fragment)
    }).toThrow("channel message is too large")
  })

  test("an empty fragment is rejected", () => {
    expect(() => new RtcReassembler().push(new Uint8Array(0))).toThrow("empty channel fragment")
  })

  test("a flood of payload-free fragments is rejected once it exceeds the fragment limit", () => {
    const reassembler = new RtcReassembler()
    const flagsOnly = Uint8Array.of(0)
    const limit = Math.ceil(RTC_MAX_MESSAGE_BYTES / RTC_FRAGMENT_BYTES)
    for (let i = 0; i < limit; i++) expect(reassembler.push(flagsOnly)).toBeNull()
    expect(() => reassembler.push(flagsOnly)).toThrow("channel message has too many fragments")
  })
})
