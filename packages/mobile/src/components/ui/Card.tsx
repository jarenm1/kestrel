import React, { type ReactNode } from "react";
import { type StyleProp, StyleSheet, View, type ViewStyle } from "react-native";
import { colors, radius, shadows } from "@/theme";

/** Raised surface, the web app's `Card` (`rounded-2xl bg-card py-5 shadow-soft`); content pads itself with px-5. */
export function Card({ children, style }: { children: ReactNode; style?: StyleProp<ViewStyle> }) {
  return <View style={[styles.card, style]}>{children}</View>;
}

const styles = StyleSheet.create({
  card: {
    backgroundColor: colors.card,
    borderRadius: radius.xxl,
    paddingVertical: 20,
    paddingHorizontal: 20,
    gap: 16,
    ...shadows.soft,
  },
});
