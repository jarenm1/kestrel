import React, { useEffect, useRef } from "react";
import { Animated, Easing, StyleSheet, Text, View } from "react-native";
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

/** Icon and optional visible label share a status colour; only the glyph animates. */
export function StatusIcon({ status, label, size = 16 }: { status: string; label?: string; size?: number }) {
  const entry = ICON_BY_STATUS[status];
  const color = entry?.color ?? colors.mutedForeground;
  const Icon = entry?.icon;
  const glyph = Icon ? (
    <Icon size={size} color={color} strokeWidth={2} />
  ) : (
    <View style={[styles.box, { width: size, height: size }]}>
      <View style={[styles.dot, { width: size / 2, height: size / 2, borderRadius: size / 4 }]} />
    </View>
  );
  return (
    <View
      accessibilityRole="image"
      accessibilityLabel={label ?? status.replace("_", " ")}
      style={[styles.box, label !== undefined && styles.labelRow]}
    >
      {entry?.spin ? <Spinner>{glyph}</Spinner> : glyph}
      {label !== undefined ? <Text style={{ color, fontSize: size }}>{label}</Text> : null}
    </View>
  );
}

const styles = StyleSheet.create({
  box: { alignItems: "center", justifyContent: "center", flexShrink: 0 },
  labelRow: { flexDirection: "row", gap: 4 },
  dot: { backgroundColor: colors.mutedForeground },
});
