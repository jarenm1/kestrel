import { describe, expect, test } from "bun:test"
import { MediaBundler, type BundleClock } from "./bundle"
import type { MediaKind } from "./manager"

/** A clock the test moves by hand, running due timers in order. */
const fakeClock = () => {
  let now = 0
  let nextId = 1
  const timers = new Map<number, { at: number; callback: () => void }>()
  const clock: BundleClock = {
    now: () => now,
    setTimeout: (callback, ms) => {
      const id = nextId++
      timers.set(id, { at: now + ms, callback })
      return id
    },
    clearTimeout: (timer) => {
      timers.delete(timer as number)
    },
  }
  const advance = (ms: number) => {
    const target = now + ms
    for (;;) {
      const due = [...timers.entries()]
        .filter(([, timer]) => timer.at <= target)
        .sort((a, b) => a[1].at - b[1].at)[0]
      if (due === undefined) break
      timers.delete(due[0])
      now = due[1].at
      due[1].callback()
    }
    now = target
  }
  return { clock, advance, pending: () => timers.size }
}

const collector = () => {
  const messages: { chunk: Uint8Array; kind: MediaKind }[] = []
  return { messages, emit: (chunk: Uint8Array, kind: MediaKind) => messages.push({ chunk, kind }) }
}

const bytes = (...values: number[]): Uint8Array => Uint8Array.from(values)

const chunkBytes = (chunk: Uint8Array): number[] => [...chunk]

describe("MediaBundler", () => {
  test("a zero window passes every fragment through on its own", () => {
    const { clock, advance } = fakeClock()
    const out = collector()
    const bundler = new MediaBundler(0, out.emit, clock)
    bundler.push(bytes(1), "delta")
    bundler.push(bytes(2, 3), "delta")
    bundler.push(bytes(4), "key")
    expect(out.messages).toEqual([
      { chunk: bytes(1), kind: "delta" },
      { chunk: bytes(2, 3), kind: "delta" },
      { chunk: bytes(4), kind: "key" },
    ])
    advance(1_000)
    expect(out.messages.length).toBe(3)
  })

  test("the first fragment after a quiet period goes out at once", () => {
    const { clock, advance } = fakeClock()
    const out = collector()
    const bundler = new MediaBundler(50, out.emit, clock)
    bundler.push(bytes(1), "delta")
    expect(out.messages.map((m) => chunkBytes(m.chunk))).toEqual([[1]])
    // Held: the previous emit was less than a window ago.
    advance(10)
    bundler.push(bytes(2), "delta")
    expect(out.messages.length).toBe(1)
    advance(40)
    expect(out.messages.map((m) => chunkBytes(m.chunk))).toEqual([[1], [2]])
    // A quiet period again: the next fragment is immediate.
    advance(50)
    bundler.push(bytes(3), "delta")
    expect(out.messages.map((m) => chunkBytes(m.chunk))).toEqual([[1], [2], [3]])
  })

  test("fragments within the window are concatenated into one message", () => {
    const { clock, advance } = fakeClock()
    const out = collector()
    const bundler = new MediaBundler(50, out.emit, clock)
    bundler.push(bytes(1), "delta")
    advance(10)
    bundler.push(bytes(2), "delta")
    advance(10)
    bundler.push(bytes(3), "delta")
    advance(10)
    bundler.push(bytes(4), "delta")
    expect(out.messages.length).toBe(1)
    advance(20)
    expect(out.messages.length).toBe(2)
    expect(chunkBytes(out.messages[1]!.chunk)).toEqual([2, 3, 4])
    expect(out.messages[1]!.kind).toBe("delta")
  })

  test("flush sends what is held at once and cancels the timer, so a status frame can follow in order", () => {
    const { clock, advance, pending } = fakeClock()
    const out = collector()
    const bundler = new MediaBundler(50, out.emit, clock)
    bundler.push(bytes(1), "delta")
    advance(10)
    bundler.push(bytes(2), "delta")
    bundler.push(bytes(3), "delta")
    bundler.flush()
    expect(out.messages.map((m) => chunkBytes(m.chunk))).toEqual([[1], [2, 3]])
    expect(pending()).toBe(0)
    advance(100)
    expect(out.messages.length).toBe(2)
  })

  test("an init fragment flushes pending media and goes alone", () => {
    const { clock, advance } = fakeClock()
    const out = collector()
    const bundler = new MediaBundler(100, out.emit, clock)
    bundler.push(bytes(1), "delta")
    advance(10)
    bundler.push(bytes(2), "delta")
    advance(10)
    bundler.push(bytes(3, 4), "init")
    expect(out.messages).toEqual([
      { chunk: bytes(1), kind: "delta" },
      { chunk: bytes(2), kind: "delta" },
      { chunk: bytes(3, 4), kind: "init" },
    ])
    advance(1_000)
    expect(out.messages.length).toBe(3)
  })

  test("a keyframe flushes pending deltas first and starts a new bundle", () => {
    const { clock, advance } = fakeClock()
    const out = collector()
    const bundler = new MediaBundler(50, out.emit, clock)
    bundler.push(bytes(1), "delta")
    advance(10)
    bundler.push(bytes(2), "delta")
    advance(10)
    bundler.push(bytes(3), "delta")
    advance(10)
    bundler.push(bytes(4), "key")
    expect(out.messages.map((m) => ({ kind: m.kind, bytes: chunkBytes(m.chunk) }))).toEqual([
      { kind: "delta", bytes: [1] },
      { kind: "delta", bytes: [2, 3] },
    ])
    advance(50)
    expect(out.messages.map((m) => ({ kind: m.kind, bytes: chunkBytes(m.chunk) }))).toEqual([
      { kind: "delta", bytes: [1] },
      { kind: "delta", bytes: [2, 3] },
      { kind: "key", bytes: [4] },
    ])
  })

  test("a held bundle flushes early once it reaches 1 MiB", () => {
    const { clock, advance } = fakeClock()
    const out = collector()
    const bundler = new MediaBundler(1_000, out.emit, clock)
    bundler.push(bytes(1), "delta")
    advance(1)
    bundler.push(new Uint8Array(1024 * 1024), "delta")
    expect(out.messages.length).toBe(2)
    expect(out.messages[1]!.chunk.byteLength).toBe(1024 * 1024)
    advance(1_000)
    expect(out.messages.length).toBe(2)
  })

  test("close drops what is pending and stops the timer", () => {
    const clock = fakeClock()
    const out = collector()
    const bundler = new MediaBundler(100, out.emit, clock.clock)
    bundler.push(bytes(1), "delta")
    clock.advance(10)
    bundler.push(bytes(2), "delta")
    expect(clock.pending()).toBe(1)
    bundler.close()
    expect(clock.pending()).toBe(0)
    clock.advance(1_000)
    expect(out.messages).toEqual([{ chunk: bytes(1), kind: "delta" }])
  })
})
