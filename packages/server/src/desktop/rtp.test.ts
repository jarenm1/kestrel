import { describe, expect, test } from "bun:test"
import { type H264Unit, MediaTap, RTP_PAYLOAD_BYTES, RtpVideoSender, packetizeH264, parseAvcConfig, sampleNals } from "./rtp"

const SPS = Uint8Array.from([0x67, 0x64, 0x00, 0x28, 0xac])
const PPS = Uint8Array.from([0x68, 0xee, 0x3c, 0x80])
const AVCC = Uint8Array.from([1, 0x64, 0x00, 0x28, 0xff, 0xe1, 0, SPS.length, ...SPS, 1, 0, PPS.length, ...PPS])

const CONFIG_AVC = parseAvcConfig(AVCC)
const CONFIG: H264Unit = { kind: "config", config: CONFIG_AVC }
const BASELINE_SPS = Uint8Array.from([0x67, 0x42, 0xe0, 0x1f, 0xac])
const BASELINE_CONFIG: H264Unit = {
  kind: "config",
  config: parseAvcConfig(Uint8Array.from([1, 0x42, 0xe0, 0x1f, 0xff, 0xe1, 0, BASELINE_SPS.length, ...BASELINE_SPS, 1, 0, PPS.length, ...PPS])),
}

const lengthPrefixed = (...nals: Uint8Array[]): Uint8Array =>
  Uint8Array.from(nals.flatMap((n) => [(n.length >>> 24) & 0xff, (n.length >>> 16) & 0xff, (n.length >>> 8) & 0xff, n.length & 0xff, ...n]))

const idr = (size = 10) => Uint8Array.from({ length: size }, (_, i) => (i === 0 ? 0x65 : 0x11))
const delta = (size = 10) => Uint8Array.from({ length: size }, (_, i) => (i === 0 ? 0x41 : 0x22))

const keyUnit = (au: Uint8Array): H264Unit => ({ kind: "key", au })
const deltaUnit = (au: Uint8Array): H264Unit => ({ kind: "delta", au })

const harness = (baselineOnly = false) => {
  let now = 0
  const written: { payload: Uint8Array; marker: boolean; timestamp: number }[] = []
  const timers: { run: () => void; at: number }[] = []
  const tap = new MediaTap()
  const logs: string[] = []
  const sender = new RtpVideoSender(
    tap,
    {
      write: (payload, marker, timestamp) => written.push({ payload, marker, timestamp }),
      now: () => now,
      setTimer: (run, ms) => {
        const timer = { run, at: now + ms }
        timers.push(timer)
        return () => {
          timers.splice(timers.indexOf(timer), 1)
        }
      },
    },
    (m) => logs.push(m),
    baselineOnly,
  )
  const feed = (unit: H264Unit) => {
    tap.push(unit)
    sender.push(unit)
  }
  const advance = (ms: number) => {
    now += ms
    for (const timer of timers.splice(0)) if (timer.at <= now) timer.run()
      else timers.push(timer)
  }
  return { sender, tap, written, feed, advance, logs, timers }
}

describe("H.264 parsing", () => {
  test("reads the parameter sets and length size of an avcC record", () => {
    const config = parseAvcConfig(AVCC)
    expect(config.lengthBytes).toBe(4)
    expect(config.profileIdc).toBe(100)
    expect(config.nals.map((n) => [...n])).toEqual([[...SPS], [...PPS]])
  })

  test("rejects a truncated avcC record", () => {
    expect(() => parseAvcConfig(AVCC.subarray(0, 8))).toThrow("truncated")
  })

  test("splits a sample into NAL units and leaves out access unit delimiters", () => {
    const aud = Uint8Array.from([0x09, 0xf0])
    const nals = sampleNals(lengthPrefixed(aud, idr(4), delta(5)), 4)
    expect(nals.map((n) => n.length)).toEqual([4, 5])
  })

  test("rejects a NAL length past the end of its sample", () => {
    expect(() => sampleNals(Uint8Array.from([0, 0, 0, 9, 0x65]), 4)).toThrow("bad NAL length")
  })
})

describe("packetizeH264", () => {
  test("sends small NAL units whole, with the marker only on the last", () => {
    const packets = packetizeH264([SPS, PPS, idr()])
    expect(packets.map((p) => p.marker)).toEqual([false, false, true])
    expect([...packets[0]!.payload]).toEqual([...SPS])
  })

  test("fragments a large NAL unit as FU-A that reassembles to the original", () => {
    const nal = Uint8Array.from({ length: 5000 }, (_, i) => (i === 0 ? 0x65 : i % 251))
    const packets = packetizeH264([nal], 1000)
    expect(packets.length).toBeGreaterThan(5)
    for (const p of packets) {
      expect(p.payload.length).toBeLessThanOrEqual(1000)
      expect(p.payload[0]! & 0x1f).toBe(28)
      expect(p.payload[0]! & 0xe0).toBe(0x65 & 0xe0)
      expect(p.payload[1]! & 0x1f).toBe(5)
    }
    expect(packets[0]!.payload[1]! & 0x80).toBe(0x80)
    expect(packets.at(-1)!.payload[1]! & 0x40).toBe(0x40)
    expect(packets.map((p) => p.marker).filter(Boolean).length).toBe(1)
    expect(packets.at(-1)!.marker).toBe(true)
    const rebuilt = [nal[0]!, ...packets.flatMap((p) => [...p.payload.subarray(2)])]
    expect(rebuilt).toEqual([...nal])
  })

  test("a NAL unit that fits exactly is not fragmented", () => {
    expect(packetizeH264([delta(RTP_PAYLOAD_BYTES)])).toHaveLength(1)
  })
})

describe("RtpVideoSender", () => {
  const key = keyUnit(lengthPrefixed(idr()))
  const frame = deltaUnit(lengthPrefixed(delta()))

  test("sends nothing before start", () => {
    const h = harness()
    h.feed(CONFIG)
    h.feed(key)
    expect(h.written).toHaveLength(0)
  })

  test("on start, replays the GOP from its keyframe with parameter sets first, then goes live", () => {
    const h = harness()
    h.feed(CONFIG)
    h.feed(key)
    h.feed(frame)
    h.sender.start()
    expect(h.written.map((w) => w.payload[0]! & 0x1f)).toEqual([7, 8, 5, 1])
    h.advance(50)
    h.feed(frame)
    expect(h.written.at(-1)!.payload[0]! & 0x1f).toBe(1)
    expect(h.written).toHaveLength(5)
  })

  test("without a GOP to replay, stays silent to the next keyframe", () => {
    const h = harness()
    h.feed(CONFIG)
    h.sender.start()
    h.feed(frame)
    expect(h.written).toHaveLength(0)
    h.feed(key)
    expect(h.written.map((w) => w.payload[0]! & 0x1f)).toEqual([7, 8, 5])
  })

  test("a Constrained Baseline viewer's replay of a High stream is held back", () => {
    const h = harness(true)
    h.feed(CONFIG)
    h.feed(key)
    h.sender.start()
    expect(h.written).toHaveLength(0)
  })

  test("a Constrained Baseline viewer replays a Baseline stream", () => {
    const h = harness(true)
    h.feed(BASELINE_CONFIG)
    h.feed(key)
    h.sender.start()
    expect(h.written.map((w) => w.payload[0]! & 0x1f)).toEqual([7, 8, 5])
  })

  test("a new encoder's stream waits for its keyframe and uses its parameter sets", () => {
    const h = harness()
    h.feed(CONFIG)
    h.feed(key)
    h.sender.start()
    h.written.length = 0
    h.feed(CONFIG)
    h.feed(frame)
    expect(h.written).toHaveLength(0)
    h.feed(key)
    expect(h.written.map((w) => w.payload[0]! & 0x1f)).toEqual([7, 8, 5])
  })

  test("timestamps only ever go up, across replays that run ahead of the clock", () => {
    const h = harness()
    h.feed(CONFIG)
    h.feed(key)
    for (let i = 0; i < 100; i++) h.feed(frame)
    h.advance(10)
    h.sender.start()
    const afterReplay = h.written.at(-1)!.timestamp
    expect(afterReplay).toBeGreaterThan(10 * 90)
    h.feed(frame)
    h.advance(2000)
    h.sender.requestKeyframe()
    h.advance(1)
    h.feed(frame)
    let last = -1
    let frames = 0
    for (const packet of h.written) {
      if (packet.timestamp <= last) throw new Error(`timestamp ${packet.timestamp} after ${last}`)
      // Only the last packet of a unit carries a marker, and each unit here ends with one.
      if (packet.marker) {
        last = packet.timestamp
        frames += 1
      }
    }
    expect(frames).toBeGreaterThan(200)
  })

  test("answers repeated keyframe requests with one replay per interval", () => {
    const h = harness()
    h.feed(CONFIG)
    h.feed(key)
    h.sender.start()
    const once = h.written.length
    h.advance(100)
    h.sender.requestKeyframe()
    h.sender.requestKeyframe()
    expect(h.written).toHaveLength(once)
    h.advance(1000)
    h.sender.requestKeyframe()
    expect(h.written.length).toBe(once * 2)
  })

  test("spaces replays of a large GOP so they stay a share of the pacing rate", () => {
    const h = harness()
    const bigKey = keyUnit(lengthPrefixed(idr(1_000_000)))
    for (let i = 0; i < 20; i++) h.sender.reportLoss(0.2)
    h.feed(CONFIG)
    h.feed(bigKey)
    h.sender.start()
    expect(h.sender.pacingBps).toBe(4_000_000)
    const sentAfterStart = () => h.written.filter((w) => (w.payload[0]! & 0x1f) === 7).length
    expect(sentAfterStart()).toBe(1)
    // 1 MB at 4 Mbit/s is 2 s of sending, so the next replay is 8 s away, not the usual 1 s.
    h.advance(7000)
    h.sender.requestKeyframe()
    expect(sentAfterStart()).toBe(1)
    h.advance(1100)
    h.sender.requestKeyframe()
    // The pacer owes tokens from the replay before, so the new one starts on its next tick.
    h.advance(100)
    expect(sentAfterStart()).toBe(2)
  })

  test("paces a burst over the rate, and sends the rest as tokens return", () => {
    const h = harness()
    h.feed(CONFIG)
    h.sender.start()
    h.feed(keyUnit(lengthPrefixed(idr(1_000_000))))
    const total = packetizeH264([SPS, PPS, idr(1_000_000)]).length
    expect(h.written.length).toBeLessThan(total)
    expect(h.timers).toHaveLength(1)
    for (let i = 0; i < 100 && h.written.length < total; i++) h.advance(5)
    expect(h.written).toHaveLength(total)
    expect(h.timers).toHaveLength(0)
  })

  test("bounds what it buffers for a viewer that cannot keep up, and recovers at a keyframe", () => {
    const h = harness()
    const bigKey = keyUnit(lengthPrefixed(idr(2_000_000)))
    const bigDelta = deltaUnit(lengthPrefixed(delta(2_000_000)))
    h.feed(CONFIG)
    h.sender.start()
    h.feed(bigKey)
    // No time passes: 100 Mbit/s of backlog over a one-second cap at the starting rate.
    for (let i = 0; i < 4; i++) h.feed(bigDelta)
    expect(h.logs.some((l) => l.includes("dropping to the next keyframe"))).toBe(true)
    expect(h.timers).toHaveLength(0)
    const sent = h.written.length
    h.advance(2000)
    h.feed(bigDelta)
    expect(h.written).toHaveLength(sent)
    h.feed(bigKey)
    expect(h.written.length).toBeGreaterThan(sent)
  })

  test("slows on reported loss and recovers on a clean path, within its limits", () => {
    const h = harness()
    const start = h.sender.pacingBps
    h.sender.reportLoss(0.2)
    expect(h.sender.pacingBps).toBeLessThan(start)
    for (let i = 0; i < 100; i++) h.sender.reportLoss(0.2)
    expect(h.sender.pacingBps).toBe(4_000_000)
    h.sender.reportLoss(0.03)
    expect(h.sender.pacingBps).toBe(4_000_000)
    for (let i = 0; i < 200; i++) h.sender.reportLoss(0)
    expect(h.sender.pacingBps).toBe(100_000_000)
  })

  test("close stops its timer and sends nothing more", () => {
    const h = harness()
    const bigKey = keyUnit(lengthPrefixed(idr(1_000_000)))
    h.feed(CONFIG)
    h.sender.start()
    h.feed(bigKey)
    const sent = h.written.length
    h.sender.close()
    expect(h.timers).toHaveLength(0)
    h.feed(bigKey)
    h.advance(1000)
    expect(h.written).toHaveLength(sent)
  })
})

describe("MediaTap", () => {
  test("keeps the latest config and the GOP from its keyframe", () => {
    const tap = new MediaTap()
    const a = Uint8Array.of(1)
    const b = Uint8Array.of(2)
    tap.push(deltaUnit(a))
    expect(tap.gop).toBeNull()
    tap.push(CONFIG)
    tap.push(keyUnit(a))
    tap.push(deltaUnit(b))
    expect(tap.config).toBe(CONFIG_AVC)
    expect(tap.gop).toEqual([a, b])
    tap.push(keyUnit(b))
    expect(tap.gop).toEqual([b])
    tap.push(CONFIG)
    expect(tap.gop).toBeNull()
  })

  test("gives up on a GOP over its cap until the next keyframe", () => {
    const tap = new MediaTap()
    const big = new Uint8Array(3 * 1024 * 1024)
    tap.push(keyUnit(big))
    tap.push(deltaUnit(big))
    expect(tap.gop).toBeNull()
    tap.push(deltaUnit(big))
    expect(tap.gop).toBeNull()
    tap.push(keyUnit(big))
    expect(tap.gop).toEqual([big])
  })
})
