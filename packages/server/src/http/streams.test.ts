import { describe, expect, test } from "bun:test"
import type { MediaKind } from "../desktop"
import { FLOW_LAG_HIGH_MS, MediaFlow } from "./streams"

const quiet = () => {}

/** A clock the test moves by hand, in milliseconds. */
const manualClock = () => {
  let now = 0
  return {
    now: () => now,
    advance: (ms: number) => {
      now += ms
    },
  }
}

describe("MediaFlow", () => {
  test("never throttles a viewer that has not acked", () => {
    const clock = manualClock()
    const flow = new MediaFlow(quiet, clock.now)
    expect(flow.offer("init")).toBe(true)
    for (let i = 0; i < 600; i++) {
      clock.advance(16)
      expect(flow.offer("delta")).toBe(true)
    }
  })

  test("does not withhold a join burst that a fast viewer acks promptly", () => {
    const logs: string[] = []
    const clock = manualClock()
    const flow = new MediaFlow((message) => logs.push(message), clock.now)
    // The cached GOP (keyframe + 240 deltas) is replayed at once, before the first ack: 242 frames in flight.
    expect(flow.offer("init")).toBe(true)
    expect(flow.offer("key")).toBe(true)
    for (let i = 0; i < 240; i++) expect(flow.offer("delta")).toBe(true)
    let sent = 242
    // The viewer has the first 60 frames 40 ms later, and the rest 40 ms after that. A 30-frame count threshold
    // would have withheld the deltas here; the lag is only 40 ms.
    clock.advance(40)
    flow.ack(60)
    clock.advance(40)
    flow.ack(sent)
    for (let i = 0; i < 60; i++) {
      clock.advance(16)
      expect(flow.offer("delta")).toBe(true)
      sent++
      flow.ack(sent)
    }
    expect(logs).toEqual([])
  })

  test("withholds deltas from a persistently slow viewer and resumes at a keyframe once it catches up", () => {
    const logs: string[] = []
    const clock = manualClock()
    const flow = new MediaFlow((message) => logs.push(message), clock.now)
    // The viewer receives each frame this long after it was sent, so its oldest unacked frame is always 1.5 s old.
    const DELAY_MS = 1500
    const inTransit: number[] = []
    const offers: { kind: MediaKind; sent: boolean }[] = []
    const offer = (kind: MediaKind) => {
      const sent = flow.offer(kind)
      if (sent) inTransit.push(clock.now())
      offers.push({ kind, sent })
    }

    offer("init")
    let received = 0
    for (let step = 1; step <= 6000 / 16; step++) {
      clock.advance(16)
      while (inTransit[0] !== undefined && inTransit[0] + DELAY_MS <= clock.now()) {
        inTransit.shift()
        received++
      }
      if (received > 0) flow.ack(received)
      offer(step % 60 === 0 ? "key" : "delta")
    }

    expect(offers.some((o) => o.sent && o.kind === "delta")).toBe(true)
    expect(offers.some((o) => !o.sent && o.kind === "delta")).toBe(true)
    // Every resume after a withheld stretch starts at a keyframe, never at a delta.
    const resumes = offers.filter((o, i) => o.sent && i > 0 && offers[i - 1]?.sent === false)
    expect(resumes.length).toBeGreaterThan(0)
    expect(resumes.every((o) => o.kind === "key")).toBe(true)
    expect(logs.some((m) => m.includes("withholding deltas"))).toBe(true)
    expect(logs.some((m) => m.includes("resumed at a keyframe"))).toBe(true)
  })

  test("a withheld viewer that catches up is resynced from the cached GOP instead of waiting for a keyframe", () => {
    const clock = manualClock()
    const flow = new MediaFlow(quiet, clock.now)
    flow.ack(0)
    expect(flow.offer("key")).toBe(true)
    for (let i = 0; i < 10; i++) expect(flow.offer("delta")).toBe(true)
    clock.advance(FLOW_LAG_HIGH_MS + 1)
    // Nothing acked and the oldest frame is past the high-water mark: the next delta is withheld.
    expect(flow.offer("delta")).toBe(false)
    // Once the viewer has everything sent, the ack reports it can be resynced from the GOP.
    expect(flow.ack(11)).toBe(true)
    flow.resume()
    expect(flow.offer("key")).toBe(true)
    expect(flow.offer("delta")).toBe(true)
  })

  test("clamps acks to what was sent", () => {
    const clock = manualClock()
    const flow = new MediaFlow(quiet, clock.now)
    flow.offer("init")
    flow.offer("delta")
    flow.ack(1_000)
    // Sent after the ack, at t=0, and never acked: an unclamped ack of 1000 would wrongly cover it.
    expect(flow.offer("delta")).toBe(true)
    clock.advance(FLOW_LAG_HIGH_MS + 500)
    expect(flow.offer("delta")).toBe(false)
  })
})
