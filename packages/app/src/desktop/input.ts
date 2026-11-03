import type { DesktopInput } from "@cloudagents/protocol"

/** DOM KeyboardEvent.key -> xdotool keysym. Anything not listed is passed through (letters, digits, F-keys). */
const KEYSYMS: Record<string, string> = {
  Enter: "Return",
  Backspace: "BackSpace",
  Tab: "Tab",
  Escape: "Escape",
  Delete: "Delete",
  Insert: "Insert",
  Home: "Home",
  End: "End",
  PageUp: "Prior",
  PageDown: "Next",
  ArrowUp: "Up",
  ArrowDown: "Down",
  ArrowLeft: "Left",
  ArrowRight: "Right",
  " ": "space",
  Shift: "Shift_L",
  Control: "Control_L",
  Alt: "Alt_L",
  Meta: "Super_L",
  CapsLock: "Caps_Lock",
}

export type Modifier = "ctrl" | "alt" | "shift" | "super"
export const MODIFIERS: readonly Modifier[] = ["ctrl", "alt", "shift", "super"]

const MODIFIER_KEYS: Record<string, true> = { Shift: true, Control: true, Alt: true, Meta: true }

/**
 * A key press for DOM key name `name`. Down carries the held modifiers as a chord ("ctrl+c"); up is the bare key, as
 * the box releases the chord's last key. Modifiers pressed on their own are sent bare.
 */
export function keyPress(name: string, mods: readonly Modifier[], down: boolean): DesktopInput {
  const base = KEYSYMS[name] ?? name
  if (!down || MODIFIER_KEYS[name]) return { _tag: "key", key: base, down }
  // Shift on a single character is already in the character (the box types the shifted glyph).
  const held = mods.filter((m) => m !== "shift" || base.length > 1)
  return { _tag: "key", key: [...held, base].join("+"), down }
}

/** Key down/up input for a hardware key event; held Ctrl/Alt/Meta (and Shift for named keys) make the chord. */
export function keyInput(e: KeyboardEvent, down: boolean): DesktopInput {
  const mods: Modifier[] = []
  if (e.ctrlKey) mods.push("ctrl")
  if (e.altKey) mods.push("alt")
  if (e.metaKey) mods.push("super")
  if (e.shiftKey) mods.push("shift")
  return keyPress(e.key, mods, down)
}

/** Text for the box to type with xdotool; the protocol caps one `text` message at 1000 UTF-16 units. */
export const TEXT_LIMIT = 1000

/** `text` messages for `text`, split on code points so no surrogate pair is cut. */
export function textInputs(text: string): DesktopInput[] {
  const out: DesktopInput[] = []
  let chunk = ""
  for (const ch of text) {
    if (chunk.length + ch.length > TEXT_LIMIT) {
      out.push({ _tag: "text", text: chunk })
      chunk = ""
    }
    chunk += ch
  }
  if (chunk !== "") out.push({ _tag: "text", text: chunk })
  return out
}

/**
 * Text typed into the keyboard toggle's hidden input, with latched modifiers. Without modifiers the text is typed
 * as is; with them each character is a chord ("ctrl+c"), which `text` cannot express.
 */
export function typedInputs(text: string, mods: readonly Modifier[]): DesktopInput[] {
  if (mods.length === 0) return textInputs(text)
  const out: DesktopInput[] = []
  for (const ch of text) {
    out.push(keyPress(ch, mods, true), keyPress(ch, [], false))
  }
  return out
}

export function mouseButton(button: number): 1 | 2 | 3 | null {
  if (button === 0) return 1
  if (button === 1) return 2
  if (button === 2) return 3
  return null
}

/** Pixels per wheel notch; touch scrolling converts finger travel the same way. */
export const PIXELS_PER_NOTCH = 50

/** A wheel event's movement in notches. Lines count as notches; a page is five. */
export function wheelNotches(e: { deltaX: number; deltaY: number; deltaMode: number }): { dx: number; dy: number } {
  const scale = e.deltaMode === 1 ? 1 : e.deltaMode === 2 ? 5 : 1 / PIXELS_PER_NOTCH
  return { dx: e.deltaX * scale, dy: e.deltaY * scale }
}

/**
 * Sums fractional notches and emits whole ones, so slow trackpad scrolling still moves the desktop and nothing is
 * lost to rounding.
 */
export class NotchAccumulator {
  private x = 0
  private y = 0

  /** Whole notches to send for this movement, or null when less than one notch has built up. */
  add(dx: number, dy: number): { dx: number; dy: number } | null {
    this.x += dx
    this.y += dy
    const wx = Math.trunc(this.x)
    const wy = Math.trunc(this.y)
    this.x -= wx
    this.y -= wy
    return wx === 0 && wy === 0 ? null : { dx: wx, dy: wy }
  }

  reset(): void {
    this.x = 0
    this.y = 0
  }
}

/** Where the frame's pixels land on screen for an `object-fit: contain` element, in client pixels. */
export interface ContentRect {
  left: number
  top: number
  width: number
  height: number
}

export function contentRect(element: HTMLElement, frame: { width: number; height: number }): ContentRect | null {
  const rect = element.getBoundingClientRect()
  if (rect.width === 0 || rect.height === 0 || frame.width === 0 || frame.height === 0) return null
  const scale = Math.min(rect.width / frame.width, rect.height / frame.height)
  const width = frame.width * scale
  const height = frame.height * scale
  return { left: rect.left + (rect.width - width) / 2, top: rect.top + (rect.height - height) / 2, width, height }
}

export interface PointerPoint {
  /** Normalized to the decoded frame (letterbox-corrected), clamped to [0, 1]. */
  x: number
  y: number
  /** False when the pointer is in the letterbox area outside the frame. */
  inside: boolean
}

/**
 * Maps a client pointer position to normalized frame coordinates. Works through CSS transforms (zoom), since the
 * element's bounding box is the transformed one. Returns null before the stream has dimensions.
 */
export function normalizePoint(
  element: HTMLElement,
  clientX: number,
  clientY: number,
  frame: { width: number; height: number },
): PointerPoint | null {
  const rect = contentRect(element, frame)
  if (rect === null) return null
  const x = (clientX - rect.left) / rect.width
  const y = (clientY - rect.top) / rect.height
  return {
    x: Math.min(1, Math.max(0, x)),
    y: Math.min(1, Math.max(0, y)),
    inside: x >= 0 && x <= 1 && y >= 0 && y <= 1,
  }
}
