import { describe, expect, test } from "bun:test";
import { endSwipe, moveSwipe, startSwipe } from "./swipe";

/** A touch from (x0, y0) through `moves` to its last point, over `ms`. */
function gesture(moves: readonly [number, number][], ms: number) {
  const track = startSwipe(400, 500, 0);
  for (const [x, y] of moves) moveSwipe(track, x, y);
  const [x] = moves.at(-1)!;
  return endSwipe(track, x, ms);
}

describe("swipes over a WebView", () => {
  test("a slow, mostly horizontal drag is a swipe in its direction", () => {
    expect(gesture([[380, 505], [300, 510], [200, 515]], 600)).toBe("left");
    expect(gesture([[420, 495], [520, 490], [620, 488]], 600)).toBe("right");
  });

  test("a vertical scroll stays a scroll, even if it later drifts sideways", () => {
    expect(gesture([[402, 470], [380, 420], [200, 400]], 600)).toBeNull();
  });

  test("a tap or a short, slow nudge does nothing; a short flick counts", () => {
    expect(gesture([[398, 501]], 80)).toBeNull();
    expect(gesture([[385, 501], [360, 502]], 600)).toBeNull();
    expect(gesture([[385, 501], [360, 502]], 60)).toBe("left");
  });
});
