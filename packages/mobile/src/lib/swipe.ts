/**
 * Swipes that start inside a native WebView never reach react-native-gesture-handler: the WebView takes the touch. A
 * DOM component that covers a swipe surface (the chat transcript) reads them itself and reports a finished horizontal
 * swipe with `classifySwipe`, using the same thresholds as `useSwipePanel`.
 */

/** Horizontal travel before a touch counts as a swipe; vertical travel first leaves it to scrolling. */
const ACTIVATE_PX = 12;
const FAIL_Y_PX = 24;
/** A finished swipe needs this much travel, or a flick this fast. */
const SWIPE_PX = 60;
const FLING_PX_PER_MS = 0.3;

export type SwipeDirection = "left" | "right";

/** Tracks one touch; `null` once it is a vertical scroll, so later movement never turns it into a swipe. */
export interface SwipeTrack {
  readonly x: number;
  readonly y: number;
  readonly at: number;
  horizontal: boolean | null;
}

export function startSwipe(x: number, y: number, at: number): SwipeTrack {
  return { x, y, at, horizontal: null };
}

/** Decides, once, whether the touch is horizontal: it must move `ACTIVATE_PX` sideways before `FAIL_Y_PX` up or down. */
export function moveSwipe(track: SwipeTrack, x: number, y: number): void {
  if (track.horizontal !== null) return;
  const dx = Math.abs(x - track.x);
  const dy = Math.abs(y - track.y);
  if (dy > FAIL_Y_PX) track.horizontal = false;
  else if (dx > ACTIVATE_PX && dx > dy) track.horizontal = true;
}

/** The direction of a finished horizontal swipe, or null when it was a scroll, a tap, or too short and slow. */
export function endSwipe(track: SwipeTrack, x: number, at: number): SwipeDirection | null {
  if (track.horizontal !== true) return null;
  const dx = x - track.x;
  const fast = Math.abs(dx) / Math.max(1, at - track.at) > FLING_PX_PER_MS;
  if (Math.abs(dx) < SWIPE_PX && !fast) return null;
  return dx < 0 ? "left" : "right";
}
