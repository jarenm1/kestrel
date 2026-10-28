import React, { type ReactNode } from "react";
import { StyleSheet, Text, View } from "react-native";
import { colors } from "@/theme";

export type BadgeVariant = "neutral" | "info" | "success" | "warning" | "destructive";

/** Tinted fill and text per variant; the signalling tones carry a dot, as the web badge's `before:` pseudo-element does. */
const TONES: Record<BadgeVariant, { bg: string; fg: string; dot: boolean }> = {
  neutral: { bg: colors.white06, fg: colors.mutedForeground, dot: false },
  info: { bg: colors.info + "1f", fg: colors.info, dot: true },
  success: { bg: colors.success + "1f", fg: colors.success, dot: true },
  warning: { bg: colors.warning + "1f", fg: colors.warning, dot: true },
  destructive: { bg: colors.destructive + "1f", fg: colors.destructive, dot: true },
};

/** Small status capsule, the web app's `Badge`. Pass lowercase text, as the web does. */
export function Badge({ variant = "neutral", children }: { variant?: BadgeVariant; children: ReactNode }) {
  const tone = TONES[variant];
  return (
    <View style={[styles.box, { backgroundColor: tone.bg }]}>
      {tone.dot ? <View style={[styles.dot, { backgroundColor: tone.fg }]} /> : null}
      {typeof children === "string" ? <Text style={[styles.text, { color: tone.fg }]}>{children}</Text> : children}
    </View>
  );
}

const styles = StyleSheet.create({
  box: {
    flexDirection: "row",
    alignItems: "center",
    alignSelf: "flex-start",
    flexShrink: 0,
    gap: 6,
    borderRadius: 999,
    paddingHorizontal: 8,
    paddingVertical: 2,
  },
  dot: {
    width: 6,
    height: 6,
    borderRadius: 3,
  },
  text: {
    fontSize: 11,
    fontWeight: "500",
  },
});
