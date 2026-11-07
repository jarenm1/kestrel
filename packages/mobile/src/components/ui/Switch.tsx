import React, { useEffect } from "react";
import { Platform, Pressable, StyleSheet, type StyleProp, type ViewStyle } from "react-native";
import Animated, {
  interpolateColor,
  useAnimatedStyle,
  useReducedMotion,
  useSharedValue,
  withTiming,
} from "react-native-reanimated";
import { colors } from "@/theme";

const TRACK_WIDTH = 36;
const TRACK_HEIGHT = 20;
const PADDING = 2;
const THUMB_SIZE = 16;
const TRAVEL = TRACK_WIDTH - PADDING * 2 - THUMB_SIZE;

interface Props {
  value: boolean;
  onValueChange: (value: boolean) => void;
  disabled?: boolean;
  accessibilityLabel?: string;
  style?: StyleProp<ViewStyle>;
}

/** React Native puts the key in `nativeEvent`; react-native-web passes the DOM event with a top-level `key`. */
type KeyDownLike = {
  key?: string;
  nativeEvent?: { key?: string };
  preventDefault?: () => void;
};

/**
 * The web app's switch (`components/ui/switch`): a 36×20 input-coloured well with a 16px foreground thumb that slides
 * right and turns the track primary when on. React Native's own Switch is styled by the platform (Material on Android,
 * UIKit on iOS), so it never matches the desktop theme; this draws the shared geometry instead and animates it the
 * same 200ms, honouring reduced motion.
 */
export function Switch({ value, onValueChange, disabled = false, accessibilityLabel, style }: Props) {
  const reduceMotion = useReducedMotion();
  const progress = useSharedValue(value ? 1 : 0);

  useEffect(() => {
    progress.value = withTiming(value ? 1 : 0, { duration: reduceMotion ? 0 : 200 });
  }, [progress, reduceMotion, value]);

  const trackStyle = useAnimatedStyle(() => ({
    backgroundColor: interpolateColor(progress.value, [0, 1], [colors.input, colors.primary]),
  }));

  const thumbStyle = useAnimatedStyle(() => ({
    backgroundColor: interpolateColor(progress.value, [0, 1], [colors.foreground, colors.primaryForeground]),
    transform: [{ translateX: progress.value * TRAVEL }],
  }));

  // react-native-web's Pressable only activates a `switch` on Enter; the web app's Radix switch also toggles on Space.
  const keyboard =
    Platform.OS === "web"
      ? {
          onKeyDown: (event: KeyDownLike) => {
            const key = event.nativeEvent?.key ?? event.key;
            if (key === " " || key === "Spacebar") {
              event.preventDefault?.();
              onValueChange(!value);
            }
          },
        }
      : {};

  return (
    <Pressable
      {...keyboard}
      accessibilityRole="switch"
      accessibilityLabel={accessibilityLabel}
      aria-checked={value}
      aria-disabled={disabled}
      disabled={disabled}
      hitSlop={8}
      onPress={() => onValueChange(!value)}
      style={style}
    >
      <Animated.View style={[styles.track, trackStyle, disabled && styles.disabled]}>
        <Animated.View style={[styles.thumb, thumbStyle]} />
      </Animated.View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  track: {
    width: TRACK_WIDTH,
    height: TRACK_HEIGHT,
    padding: PADDING,
    borderRadius: TRACK_HEIGHT / 2,
    flexDirection: "row",
    alignItems: "center",
  },
  thumb: {
    width: THUMB_SIZE,
    height: THUMB_SIZE,
    borderRadius: THUMB_SIZE / 2,
    shadowColor: "#000",
    shadowOpacity: 0.55,
    shadowRadius: 3,
    shadowOffset: { width: 0, height: 1 },
    elevation: 2,
  },
  disabled: { opacity: 0.5 },
});
