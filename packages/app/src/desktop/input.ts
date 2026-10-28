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

const MODIFIER_KEYS: Record<string, true> = { Shift: true, Control: true, Alt: true, Meta: true }

/**
 * Key down/up input. On key down, held Ctrl/Alt/Meta (and Shift for named keys) are
 * prefixed as a chord, e.g. "ctrl+c". Key up and modifier keys are sent bare.
 */
export function keyInput(e: KeyboardEvent, down: boolean): DesktopInput {
  const base = KEYSYMS[e.key] ?? e.key
  if (!down || MODIFIER_KEYS[e.key]) return { _tag: "key", key: base, down }
  const mods: string[] = []
  if (e.ctrlKey) mods.push("ctrl")
  if (e.altKey) mods.push("alt")
  if (e.metaKey) mods.push("super")
  if (e.shiftKey && base.length > 1) mods.push("shift")
  return { _tag: "key", key: [...mods, base].join("+"), down }
}

export function mouseButton(button: number): 1 | 2 | 3 | null {
  if (button === 0) return 1
  if (button === 1) return 2
  if (button === 2) return 3
  return null
}

export interface PointerPoint {
  /** Normalized to the decoded frame (letterbox-corrected), clamped to [0, 1]. */
  x: number
  y: number
  /** False when the pointer is in the letterbox area outside the frame. */
  inside: boolean
}

/**
 * Maps a client pointer position to normalized frame coordinates for an `object-fit: contain`
 * stream canvas. `frame` is the stream's dimensions (status width/height).
 * Returns null before the stream has dimensions.
 */
export function normalizePoint(
  element: HTMLElement,
  clientX: number,
  clientY: number,
  frame: { width: number; height: number },
): PointerPoint | null {
  const rect = element.getBoundingClientRect()
  if (rect.width === 0 || rect.height === 0 || frame.width === 0 || frame.height === 0) return null
  const scale = Math.min(rect.width / frame.width, rect.height / frame.height)
  const contentW = frame.width * scale
  const contentH = frame.height * scale
  const left = rect.left + (rect.width - contentW) / 2
  const top = rect.top + (rect.height - contentH) / 2
  const x = (clientX - left) / contentW
  const y = (clientY - top) / contentH
  return {
    x: Math.min(1, Math.max(0, x)),
    y: Math.min(1, Math.max(0, y)),
    inside: x >= 0 && x <= 1 && y >= 0 && y <= 1,
  }
}
