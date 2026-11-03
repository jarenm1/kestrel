/**
 * Touch gestures for the desktop viewer, as pure state over pointer events. The recognizer reports what the user meant
 * (clicks, drags, scrolls, zoom) to a sink; the viewer turns those into DesktopInput. Coordinates are client pixels.
 *
 * Touch mode (default): tap = left click at the point; long press (500 ms, released without moving) = right click;
 * long press then drag = left drag; one finger dragged otherwise pans the view (only visible once zoomed); two-finger
 * drag = scroll; pinch = zoom.
 *
 * Trackpad mode: one finger moves the cursor by its movement; tap = left click at the cursor; tap then drag (within
 * DOUBLE_TAP_MS) = left drag; two-finger tap = right click at the cursor; two-finger drag = scroll; pinch = zoom.
 */

export type TouchMode = "touch" | "trackpad"

export interface Point {
  x: number
  y: number
}

export interface GestureSink {
  /** A button press or release. In touch mode `at` is the point; in trackpad mode the cursor is the position. */
  button(button: 1 | 3, down: boolean, at: Point): void
  /** Touch mode: the point a left drag has reached. */
  moveTo(at: Point): void
  /** Trackpad mode: the cursor moved by this many client pixels. */
  moveBy(dx: number, dy: number): void
  /** Touch mode, one finger, not dragging: the view pans by this many client pixels. */
  pan(dx: number, dy: number): void
  /** Two fingers moved; `dx`/`dy` are wheel-direction pixels (positive dy scrolls down). */
  scroll(dx: number, dy: number): void
  /** Pinch: multiply the view scale by `factor` about the client point `center`. */
  zoom(factor: number, center: Point): void
}

/** Schedules `fn` after `ms`; returns a cancel function. */
export type Scheduler = (ms: number, fn: () => void) => () => void

export const LONG_PRESS_MS = 500
export const DOUBLE_TAP_MS = 300
/** Movement under this many pixels is still a tap. */
export const TAP_SLOP_PX = 10

interface Pointer {
  x: number
  y: number
}

interface Single {
  id: number
  start: Point
  last: Point
  t0: number
  moved: boolean
  longPressed: boolean
  dragging: boolean
  /** Trackpad: this press began within DOUBLE_TAP_MS of a tap, so movement drags. */
  dragArmed: boolean
  cancelTimer: () => void
}

interface Multi {
  start: Point
  centroid: Point
  distance: number
  startDistance: number
  t0: number
  moved: boolean
}

function distance(a: Point, b: Point): number {
  return Math.hypot(a.x - b.x, a.y - b.y)
}

export class GestureRecognizer {
  private pointers = new Map<number, Pointer>()
  private single: Single | null = null
  private multi: Multi | null = null
  /** After a two-finger gesture, lingering fingers are ignored until every finger lifts. */
  private spent = false
  private lastTapAt: number | null = null

  constructor(
    private mode: TouchMode,
    private sink: GestureSink,
    private schedule: Scheduler,
  ) {}

  setMode(mode: TouchMode): void {
    this.reset()
    this.mode = mode
  }

  down(id: number, at: Point, t: number): void {
    this.pointers.set(id, { x: at.x, y: at.y })
    if (this.spent) return
    if (this.pointers.size === 1) {
      const armed = this.mode === "trackpad" && this.lastTapAt !== null && t - this.lastTapAt <= DOUBLE_TAP_MS
      const single: Single = {
        id,
        start: { ...at },
        last: { ...at },
        t0: t,
        moved: false,
        longPressed: false,
        dragging: false,
        dragArmed: armed,
        cancelTimer: () => {},
      }
      single.cancelTimer = this.schedule(LONG_PRESS_MS, () => {
        if (this.single === single && !single.moved) single.longPressed = true
      })
      this.single = single
      return
    }
    if (this.pointers.size === 2) {
      // A second finger turns any single-finger gesture into a two-finger one. A left drag in progress is released
      // where it is; a pending tap or long press is dropped.
      const single = this.single
      if (single) {
        single.cancelTimer()
        if (single.dragging) this.sink.button(1, false, single.last)
        this.single = null
      }
      const [c, d] = this.twoFinger()
      this.multi = { start: c, centroid: c, distance: d, startDistance: d, t0: t, moved: false }
    }
  }

  move(id: number, at: Point): void {
    const p = this.pointers.get(id)
    if (!p) return
    p.x = at.x
    p.y = at.y
    if (this.spent) return
    if (this.multi && this.pointers.size === 2) {
      this.moveTwo()
      return
    }
    const single = this.single
    if (!single || single.id !== id) return
    if (!single.moved) {
      if (distance(single.start, at) <= TAP_SLOP_PX) return
      single.moved = true
      single.cancelTimer()
      if (this.mode === "touch" && single.longPressed) {
        // Long press then drag: left button down where the press began, then the pointer follows the finger.
        single.dragging = true
        this.sink.button(1, true, single.start)
      } else if (this.mode === "trackpad" && single.dragArmed) {
        single.dragging = true
        this.sink.button(1, true, single.last)
      }
    }
    if (this.mode === "touch") {
      if (single.dragging) this.sink.moveTo({ ...at })
      else this.sink.pan(at.x - single.last.x, at.y - single.last.y)
    } else {
      this.sink.moveBy(at.x - single.last.x, at.y - single.last.y)
    }
    single.last = { ...at }
  }

  up(id: number, t: number): void {
    this.end(id, t, false)
  }

  /** The system took the touch (a call, a gesture): release any drag without a click. */
  cancel(id: number): void {
    this.end(id, 0, true)
  }

  private end(id: number, t: number, cancelled: boolean): void {
    if (!this.pointers.delete(id)) return

    if (this.single && this.single.id === id) {
      const single = this.single
      single.cancelTimer()
      this.single = null
      if (single.dragging) {
        this.sink.button(1, false, single.last)
      } else if (!cancelled && !single.moved) {
        if (this.mode === "touch") {
          // A long press is a right click at the press point; a quick tap is a left click there.
          const button = single.longPressed ? 3 : 1
          this.sink.button(button, true, single.start)
          this.sink.button(button, false, single.start)
        } else {
          this.sink.button(1, true, single.last)
          this.sink.button(1, false, single.last)
          this.lastTapAt = t
        }
      }
    }

    if (this.multi && !cancelled && this.pointers.size === 0 && !this.multi.moved) {
      // Two fingers tapped together: a right click at the cursor, in trackpad mode only.
      if (this.mode === "trackpad" && t - this.multi.t0 <= DOUBLE_TAP_MS) {
        this.sink.button(3, true, { x: 0, y: 0 })
        this.sink.button(3, false, { x: 0, y: 0 })
      }
    }

    if (this.pointers.size === 0) this.reset()
    else if (this.multi) this.spent = true
  }

  private reset(): void {
    this.single?.cancelTimer()
    this.single = null
    this.multi = null
    this.spent = false
    this.pointers.clear()
  }

  private twoFinger(): [Point, number] {
    const [a, b] = [...this.pointers.values()]
    return [{ x: (a!.x + b!.x) / 2, y: (a!.y + b!.y) / 2 }, distance(a!, b!)]
  }

  private moveTwo(): void {
    const multi = this.multi!
    const [c, d] = this.twoFinger()
    if (d > 1 && multi.distance > 1 && d !== multi.distance) {
      this.sink.zoom(d / multi.distance, c)
    }
    const dx = c.x - multi.centroid.x
    const dy = c.y - multi.centroid.y
    // `0 - x` rather than `-x`: an unmoved axis must not emit -0.
    if (dx !== 0 || dy !== 0) this.sink.scroll(0 - dx, 0 - dy)
    if (distance(multi.start, c) > TAP_SLOP_PX || Math.abs(d - multi.startDistance) > TAP_SLOP_PX) multi.moved = true
    multi.centroid = c
    multi.distance = d
  }
}

/** Zoom limits of the viewer; 1 is the fitted desktop. */
export const MIN_SCALE = 1
export const MAX_SCALE = 4

/** The view's transform of the stage, in container pixels: translate(x, y) scale(scale), origin at the top left. */
export interface View {
  scale: number
  x: number
  y: number
}

export const FIT_VIEW: View = { scale: 1, x: 0, y: 0 }

/** Keeps the stage covering the container: no gap opens at an edge, and at scale 1 the view is at rest. */
export function clampView(v: View, width: number, height: number): View {
  const scale = Math.min(MAX_SCALE, Math.max(MIN_SCALE, v.scale))
  return {
    scale,
    x: Math.min(0, Math.max(width - width * scale, v.x)),
    y: Math.min(0, Math.max(height - height * scale, v.y)),
  }
}

/** Zooms about container point `center`, so the content under the fingers stays under them. */
export function zoomView(v: View, factor: number, center: Point, width: number, height: number): View {
  const scale = Math.min(MAX_SCALE, Math.max(MIN_SCALE, v.scale * factor))
  const f = scale / v.scale
  return clampView(
    { scale, x: center.x - (center.x - v.x) * f, y: center.y - (center.y - v.y) * f },
    width,
    height,
  )
}

export function panView(v: View, dx: number, dy: number, width: number, height: number): View {
  return clampView({ scale: v.scale, x: v.x + dx, y: v.y + dy }, width, height)
}
