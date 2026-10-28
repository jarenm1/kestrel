import React, { useEffect, useRef } from "react";
import { Animated, Easing, StyleSheet, View } from "react-native";
import { Ban, Check, CircleAlert, LoaderCircle, X, type LucideIcon } from "lucide-react-native";
import { colors } from "@/theme";

const ICON_BY_STATUS: Record<string, { icon: LucideIcon; color: string; spin?: boolean }> = {
  running: { icon: LoaderCircle, color: colors.mutedForeground, spin: true },
  starting: { icon: LoaderCircle, color: colors.mutedForeground, spin: true },
  needs_input: { icon: CircleAlert, color: colors.warning },
  done: { icon: Check, color: colors.success },
  succeeded: { icon: Check, color: colors.success },
  failed: { icon: X, color: colors.destructive },
  cancelled: { icon: Ban, color: colors.mutedForeground },
};

function Spinner({ children }: { children: React.ReactNode }) {
  const turn = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    const loop = Animated.loop(
      Animated.timing(turn, { toValue: 1, duration: 1000, easing: Easing.linear, useNativeDriver: true })
    );
    loop.start();
    return () => loop.stop();
  }, [turn]);
  const rotate = turn.interpolate({ inputRange: [0, 1], outputRange: ["0deg", "360deg"] });
  return <Animated.View style={{ transform: [{ rotate }] }}>{children}</Animated.View>;
}

/** Task, run and desktop states as one small icon (the web app's `StatusIcon`); the state name is its label. */
export function StatusIcon({ status, size = 16 }: { status: string; size?: number }) {
  const label = status.replace("_", " ");
  const entry = ICON_BY_STATUS[status];
  if (!entry) {
    // Idle and unknown states: a small filled dot.
    return (
      <View accessibilityRole="image" accessibilityLabel={label} style={[styles.box, { width: size, height: size }]}>
        <View style={[styles.dot, { width: size / 2, height: size / 2, borderRadius: size / 4 }]} />
      </View>
    );
  }
  const Icon = entry.icon;
  const glyph = <Icon size={size} color={entry.color} strokeWidth={2} />;
  return (
    <View accessibilityRole="image" accessibilityLabel={label} style={styles.box}>
      {entry.spin ? <Spinner>{glyph}</Spinner> : glyph}
    </View>
  );
}

const styles = StyleSheet.create({
  box: { alignItems: "center", justifyContent: "center", flexShrink: 0 },
  dot: { backgroundColor: colors.mutedForeground },
});
