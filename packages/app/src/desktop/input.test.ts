import { describe, expect, test } from "bun:test"
import {
  NotchAccumulator,
  TEXT_LIMIT,
  keyPress,
  normalizePoint,
  textInputs,
  typedInputs,
  wheelNotches,
} from "./input"

describe("keyPress", () => {
  test("down carries the chord, up is bare", () => {
    expect(keyPress("c", ["ctrl"], true)).toEqual({ _tag: "key", key: "ctrl+c", down: true })
    expect(keyPress("c", ["ctrl"], false)).toEqual({ _tag: "key", key: "c", down: false })
  })

  test("named keys map to keysyms", () => {
    expect(keyPress("Enter", [], true)).toEqual({ _tag: "key", key: "Return", down: true })
    expect(keyPress("ArrowLeft", ["alt"], true)).toEqual({ _tag: "key", key: "alt+Left", down: true })
  })

  test("shift on a single character is already in the glyph", () => {
    expect(keyPress("A", ["shift"], true)).toEqual({ _tag: "key", key: "A", down: true })
    expect(keyPress("Tab", ["shift"], true)).toEqual({ _tag: "key", key: "shift+Tab", down: true })
  })

  test("modifier keys are sent bare", () => {
    expect(keyPress("Control", ["ctrl"], true)).toEqual({ _tag: "key", key: "Control_L", down: true })
  })
})

describe("typedInputs", () => {
  test("plain text is one text message per 1000-unit chunk", () => {
    expect(typedInputs("hi", [])).toEqual([{ _tag: "text", text: "hi" }])
    const long = "a".repeat(TEXT_LIMIT + 1)
    const out = textInputs(long)
    expect(out.map((m) => (m._tag === "text" ? m.text.length : -1))).toEqual([TEXT_LIMIT, 1])
  })

  test("never splits a surrogate pair", () => {
    const emoji = "😀"
    const text = "a".repeat(TEXT_LIMIT - 1) + emoji
    const out = textInputs(text)
    expect(out.length).toBe(2)
    expect(out.map((m) => (m._tag === "text" ? m.text : "")).join("")).toBe(text)
  })

  test("latched modifiers make each character a chord with a bare release", () => {
    expect(typedInputs("c", ["ctrl"])).toEqual([
      { _tag: "key", key: "ctrl+c", down: true },
      { _tag: "key", key: "c", down: false },
    ])
  })
})

describe("NotchAccumulator", () => {
  test("pixels become notches; fractions carry over", () => {
    const acc = new NotchAccumulator()
    expect(wheelNotches({ deltaX: 0, deltaY: 25, deltaMode: 0 }).dy).toBe(0.5)
    expect(acc.add(0, 0.5)).toBeNull()
    expect(acc.add(0, 0.5)).toEqual({ dx: 0, dy: 1 })
    expect(acc.add(0, 0.25)).toBeNull()
  })

  test("lines are notches, pages are five", () => {
    expect(wheelNotches({ deltaX: 0, deltaY: 3, deltaMode: 1 }).dy).toBe(3)
    expect(wheelNotches({ deltaX: 0, deltaY: 1, deltaMode: 2 }).dy).toBe(5)
  })

  test("reset drops the remainder", () => {
    const acc = new NotchAccumulator()
    acc.add(0, 0.9)
    acc.reset()
    expect(acc.add(0, 0.2)).toBeNull()
  })
})

describe("normalizePoint", () => {
  const element = (left: number, top: number, width: number, height: number) =>
    ({ getBoundingClientRect: () => ({ left, top, width, height }) }) as unknown as HTMLElement

  test("letterboxes a 16:9 frame in a square box", () => {
    const el = element(0, 0, 100, 100)
    const frame = { width: 1600, height: 900 }
    // Content is 100 wide, 56.25 tall, vertically centred at 21.875.
    expect(normalizePoint(el, 0, 50, frame)).toEqual({ x: 0, y: (50 - 21.875) / 56.25, inside: true })
    expect(normalizePoint(el, 50, 5, frame)?.inside).toBe(false)
  })

  test("clamps outside points and reports them as outside", () => {
    const el = element(10, 10, 200, 100)
    const p = normalizePoint(el, 0, 0, { width: 200, height: 100 })
    expect(p).toEqual({ x: 0, y: 0, inside: false })
  })

  test("null before the frame has dimensions", () => {
    expect(normalizePoint(element(0, 0, 100, 100), 1, 1, { width: 0, height: 0 })).toBeNull()
  })
})
