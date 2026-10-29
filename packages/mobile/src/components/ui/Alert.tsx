import React, { type ReactNode } from "react";
import { type StyleProp, StyleSheet, Text, View, type ViewStyle } from "react-native";
import { colors, radius } from "@/theme";

const TONES = {
  destructive: { bg: colors.destructive + "1a", fg: colors.destructive },
  warning: { bg: colors.warning + "1a", fg: colors.warning },
} as const;

/** Inline error or warning, the web app's `Alert`. */
export function Alert({
  variant = "destructive",
  children,
  style,
}: {
  variant?: keyof typeof TONES;
  children: ReactNode;
  style?: StyleProp<ViewStyle>;
}) {
  const tone = TONES[variant];
  return (
    <View accessibilityRole="alert" style={[styles.box, { backgroundColor: tone.bg }, style]}>
      {typeof children === "string" ? <Text style={[styles.text, { color: tone.fg }]}>{children}</Text> : children}
    </View>
  );
}

const styles = StyleSheet.create({
  box: { borderRadius: radius.md, paddingHorizontal: 14, paddingVertical: 10 },
  text: { fontSize: 14, lineHeight: 20 },
});
