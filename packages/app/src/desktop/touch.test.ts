import { describe, expect, test } from "bun:test"
import {
  DOUBLE_TAP_MS,
  FIT_VIEW,
  GestureRecognizer,
  LONG_PRESS_MS,
  MAX_SCALE,
  clampView,
  panView,
  zoomView,
  type GestureSink,
  type TouchMode,
} from "./touch"

type Event =
  | ["button", 1 | 3, boolean, number, number]
  | ["moveTo", number, number]
  | ["moveBy", number, number]
  | ["pan", number, number]
  | ["scroll", number, number]
  | ["zoom", number, number, number]

function harness(mode: TouchMode) {
  const events: Event[] = []
  const sink: GestureSink = {
    button: (b, down, at) => events.push(["button", b, down, at.x, at.y]),
    moveTo: (at) => events.push(["moveTo", at.x, at.y]),
    moveBy: (dx, dy) => events.push(["moveBy", dx, dy]),
    pan: (dx, dy) => events.push(["pan", dx, dy]),
    scroll: (dx, dy) => events.push(["scroll", dx, dy]),
    zoom: (f, c) => events.push(["zoom", f, c.x, c.y]),
  }
  const timers: { at: number; fn: () => void; live: boolean }[] = []
  const recognizer = new GestureRecognizer(mode, sink, (ms, fn) => {
    const timer = { at: now + ms, fn, live: true }
    timers.push(timer)
    return () => {
      timer.live = false
    }
  })
  let now = 0
  const fireTimers = (until: number) => {
    now = until
    for (const t of timers) if (t.live && t.at <= now) {
      t.live = false
      t.fn()
    }
  }
  return {
    events,
    recognizer,
    advance: (ms: number) => fireTimers(now + ms),
  }
}

describe("touch mode", () => {
  test("quick tap is a left click at the press point", () => {
    const h = harness("touch")
    h.recognizer.down(1, { x: 10, y: 20 }, 0)
    h.recognizer.up(1, 100)
    expect(h.events).toEqual([
      ["button", 1, true, 10, 20],
      ["button", 1, false, 10, 20],
    ])
  })

  test("long press released without moving is a right click at the press point", () => {
    const h = harness("touch")
    h.recognizer.down(1, { x: 10, y: 20 }, 0)
    h.advance(LONG_PRESS_MS)
    expect(h.events).toEqual([])
    h.recognizer.up(1, LONG_PRESS_MS + 10)
    expect(h.events).toEqual([
      ["button", 3, true, 10, 20],
      ["button", 3, false, 10, 20],
    ])
  })

  test("long press then drag is a left drag from the press point", () => {
    const h = harness("touch")
    h.recognizer.down(1, { x: 10, y: 20 }, 0)
    h.advance(LONG_PRESS_MS)
    h.recognizer.move(1, { x: 50, y: 60 })
    h.recognizer.move(1, { x: 70, y: 80 })
    h.recognizer.up(1, 800)
    expect(h.events).toEqual([
      ["button", 1, true, 10, 20],
      ["moveTo", 50, 60],
      ["moveTo", 70, 80],
      ["button", 1, false, 70, 80],
    ])
  })

  test("a drag before the long press pans, never clicks", () => {
    const h = harness("touch")
    h.recognizer.down(1, { x: 10, y: 20 }, 0)
    h.recognizer.move(1, { x: 40, y: 20 })
    h.advance(LONG_PRESS_MS)
    h.recognizer.up(1, 600)
    expect(h.events).toEqual([["pan", 30, 0]])
  })

  test("two fingers scroll with wheel-direction pixels", () => {
    const h = harness("touch")
    h.recognizer.down(1, { x: 100, y: 100 }, 0)
    h.recognizer.down(2, { x: 200, y: 100 }, 0)
    h.recognizer.move(1, { x: 100, y: 140 })
    h.recognizer.move(2, { x: 200, y: 140 })
    // Fingers moved down 40 px: the content scrolls up, so wheel dy is negative.
    expect(h.events.filter((e) => e[0] === "scroll")).toEqual([
      ["scroll", 0, -20],
      ["scroll", 0, -20],
    ])
  })

  test("pinch zooms about the centroid", () => {
    const h = harness("touch")
    h.recognizer.down(1, { x: 100, y: 100 }, 0)
    h.recognizer.down(2, { x: 200, y: 100 }, 0)
    h.recognizer.move(2, { x: 300, y: 100 })
    const zoom = h.events.find((e) => e[0] === "zoom")
    expect(zoom).toEqual(["zoom", 2, 200, 100])
  })

  test("a second finger drops a pending long press", () => {
    const h = harness("touch")
    h.recognizer.down(1, { x: 10, y: 20 }, 0)
    h.recognizer.down(2, { x: 30, y: 20 }, 100)
    h.advance(LONG_PRESS_MS)
    h.recognizer.up(1, 600)
    h.recognizer.up(2, 610)
    expect(h.events.filter((e) => e[0] === "button")).toEqual([])
  })
})

describe("trackpad mode", () => {
  test("movement moves the cursor by its delta", () => {
    const h = harness("trackpad")
    h.recognizer.down(1, { x: 0, y: 0 }, 0)
    h.recognizer.move(1, { x: 30, y: 0 })
    h.recognizer.move(1, { x: 30, y: 5 })
    expect(h.events).toEqual([
      ["moveBy", 30, 0],
      ["moveBy", 0, 5],
    ])
  })

  test("a finger that moves is cursor movement, not a tap", () => {
    const h = harness("trackpad")
    h.recognizer.down(1, { x: 0, y: 0 }, 0)
    h.recognizer.move(1, { x: 30, y: 0 })
    h.recognizer.up(1, 100)
    expect(h.events).toEqual([["moveBy", 30, 0]])
  })

  test("a near-stationary tap clicks where the touch started", () => {
    const h = harness("trackpad")
    h.recognizer.down(1, { x: 0, y: 0 }, 0)
    h.recognizer.move(1, { x: 3, y: 0 })
    h.recognizer.up(1, 100)
    expect(h.events.slice(-2)).toEqual([
      ["button", 1, true, 0, 0],
      ["button", 1, false, 0, 0],
    ])
  })

  test("tap then quick drag is a left drag", () => {
    const h = harness("trackpad")
    h.recognizer.down(1, { x: 0, y: 0 }, 0)
    h.recognizer.up(1, 50)
    h.recognizer.down(2, { x: 0, y: 0 }, 50 + DOUBLE_TAP_MS - 100)
    h.recognizer.move(2, { x: 40, y: 0 })
    h.recognizer.up(2, 300)
    expect(h.events.map((e) => e[0] + (e[0] === "button" ? `:${e[1]}:${e[2]}` : ""))).toEqual([
      "button:1:true",
      "button:1:false",
      "button:1:true",
      "moveBy",
      "button:1:false",
    ])
  })

  test("two-finger tap is a right click", () => {
    const h = harness("trackpad")
    h.recognizer.down(1, { x: 0, y: 0 }, 0)
    h.recognizer.down(2, { x: 40, y: 0 }, 0)
    h.recognizer.up(1, 100)
    h.recognizer.up(2, 120)
    expect(h.events.filter((e) => e[0] === "button")).toEqual([
      ["button", 3, true, 0, 0],
      ["button", 3, false, 0, 0],
    ])
  })
})

describe("view", () => {
  test("clamp keeps the stage over the container and at rest at scale 1", () => {
    expect(clampView({ scale: 1, x: 40, y: -40 }, 100, 100)).toEqual(FIT_VIEW)
    expect(clampView({ scale: 2, x: 40, y: -300 }, 100, 100)).toEqual({ scale: 2, x: 0, y: -100 })
    expect(clampView({ scale: 99, x: 0, y: 0 }, 100, 100).scale).toBe(MAX_SCALE)
  })

  test("zoom keeps the point under the fingers in place", () => {
    const v = zoomView(FIT_VIEW, 2, { x: 50, y: 50 }, 100, 100)
    // Content point under (50,50) before the zoom is (50,50); it must stay at (50,50).
    expect((50 - v.x) / v.scale).toBe(50)
    expect((50 - v.y) / v.scale).toBe(50)
  })

  test("pan moves within bounds", () => {
    const zoomed = zoomView(FIT_VIEW, 2, { x: 0, y: 0 }, 100, 100)
    expect(panView(zoomed, 30, 0, 100, 100).x).toBe(0)
    expect(panView(zoomed, -30, 0, 100, 100).x).toBe(-30)
  })
})
