import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { PanGestureConfig } from "react-native-gesture-handler";
import { Easing, type SharedValue, useSharedValue, withTiming } from "react-native-reanimated";
import { scheduleOnRN } from "react-native-worklets";

/** Horizontal travel before a swipe takes over; vertical travel first lets lists scroll instead. */
const ACTIVATE_PX = 12;
const FAIL_Y_PX = 24;
/** A flick this fast settles in its direction regardless of how far it travelled. */
const FLING_PX_PER_S = 300;
const SETTLE_MS = 260;
/** Effectively unbounded: an offset range edge that never triggers. */
const NEVER = 100_000;

const SETTLE = { duration: SETTLE_MS, easing: Easing.out(Easing.cubic) };

interface Options {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Which screen edge the panel slides in from. "left" opens with a right swipe, "right" with a left swipe. */
  side: "left" | "right";
  /** How far the panel travels between closed and open, in points. */
  distance: number;
  /** When false, swipes do not open the panel (buttons still do). */
  enabled?: boolean;
}

export interface SwipePanel {
  /** 0 closed … 1 open, following the finger while dragging. */
  progress: SharedValue<number>;
  /** True while any part of the panel can be seen: open, dragged, or animating closed. Mount heavy content on it. */
  visible: boolean;
  /** Pan config for the surface the panel opens over. Pass to `usePanGesture`. */
  openGesture: PanGestureConfig;
  /** Pan config for the panel itself (or its scrim) to swipe it shut. Pass to `usePanGesture`, once per surface. */
  closeGesture: PanGestureConfig;
}

/**
 * A panel that slides in from one edge and follows horizontal swipes, for the thread sidebar and the
 * Desktop/Diff panel. `open` stays the source of truth: a finished swipe reports through `onOpenChange`,
 * and changing `open` from a button animates the panel there.
 */
export function useSwipePanel({ open, onOpenChange, side, distance, enabled = true }: Options): SwipePanel {
  const progress = useSharedValue(open ? 1 : 0);
  const start = useSharedValue(0);
  const [dragging, setDragging] = useState(false);
  const [closing, setClosing] = useState(false);
  const previousOpen = useRef(open);

  const settled = useCallback(
    (nowOpen: boolean) => {
      setDragging(false);
      if (!nowOpen) setClosing(true);
      if (nowOpen !== open) onOpenChange(nowOpen);
    },
    [open, onOpenChange]
  );
  const closed = useCallback(() => setClosing(false), []);

  useEffect(() => {
    const wasOpen = previousOpen.current;
    previousOpen.current = open;
    // A panel that starts closed has nothing to animate out or mount.
    if (!open && !wasOpen) return;
    if (!open) setClosing(true);
    progress.value = withTiming(open ? 1 : 0, SETTLE, (finished) => {
      if (finished && !open) scheduleOnRN(closed);
    });
  }, [open, progress, closed]);

  const configs = useMemo(() => {
    // Opening direction in screen x: +1 for a left panel (swipe right), -1 for a right panel (swipe left).
    const dir = side === "left" ? 1 : -1;
    const towardOpen: [number, number] = dir === 1 ? [-NEVER, ACTIVATE_PX] : [-ACTIVATE_PX, NEVER];
    const towardClose: [number, number] = dir === 1 ? [-ACTIVATE_PX, NEVER] : [-NEVER, ACTIVATE_PX];

    const callbacks = {
      onActivate: () => {
        "worklet";
        start.value = progress.value;
        scheduleOnRN(setDragging, true);
      },
      onUpdate: (e: { translationX: number }) => {
        "worklet";
        const next = start.value + (dir * e.translationX) / distance;
        progress.value = Math.min(1, Math.max(0, next));
      },
      onDeactivate: (e: { velocityX: number; canceled: boolean }) => {
        "worklet";
        const velocity = dir * e.velocityX;
        const target = e.canceled
          ? (open ? 1 : 0)
          : velocity > FLING_PX_PER_S ? 1 : velocity < -FLING_PX_PER_S ? 0 : progress.value > 0.5 ? 1 : 0;
        progress.value = withTiming(target, SETTLE, (finished) => {
          if (finished && target === 0) scheduleOnRN(closed);
        });
        scheduleOnRN(settled, target === 1);
      },
    };

    const openGesture: PanGestureConfig = {
      enabled: enabled && !open,
      activeOffsetX: towardOpen,
      // The opposite panel's recognizer should fail promptly, not linger until touch-up.
      failOffsetX: dir === 1 ? [-ACTIVATE_PX, NEVER] : [-NEVER, ACTIVATE_PX],
      failOffsetY: [-FAIL_Y_PX, FAIL_Y_PX],
      ...callbacks,
    };
    const closeGesture: PanGestureConfig = {
      enabled: open,
      activeOffsetX: towardClose,
      failOffsetX: dir === 1 ? [-NEVER, ACTIVATE_PX] : [-ACTIVATE_PX, NEVER],
      failOffsetY: [-FAIL_Y_PX, FAIL_Y_PX],
      ...callbacks,
    };
    return { openGesture, closeGesture };
  }, [side, distance, enabled, open, progress, start, settled, closed]);

  return { progress, visible: open || dragging || closing, ...configs };
}
