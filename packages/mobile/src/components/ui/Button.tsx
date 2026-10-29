import React, { type ReactNode } from "react";
import { Pressable, type StyleProp, StyleSheet, Text, type ViewStyle } from "react-native";
import type { LucideIcon } from "lucide-react-native";
import { colors, radius, shadows } from "@/theme";

export type ButtonVariant = "default" | "destructive" | "soft" | "secondary" | "ghost" | "link";
export type ButtonSize = "default" | "sm" | "lg" | "icon";

/** Fill, pressed fill and text colour per variant; the web app's `buttonVariants`, with press standing in for hover. */
const VARIANTS: Record<ButtonVariant, { bg: string; pressed: string; fg: string; raised: boolean }> = {
  default: { bg: colors.primary, pressed: "#dcdcde", fg: colors.primaryForeground, raised: true },
  destructive: { bg: colors.destructive + "26", pressed: colors.destructive + "40", fg: colors.destructive, raised: false },
  soft: { bg: colors.white06, pressed: "rgba(255,255,255,0.10)", fg: colors.foreground, raised: true },
  secondary: { bg: colors.secondary, pressed: colors.accent, fg: colors.secondaryForeground, raised: true },
  ghost: { bg: "transparent", pressed: colors.white06, fg: colors.mutedForeground, raised: false },
  link: { bg: "transparent", pressed: "transparent", fg: colors.foreground, raised: false },
};

const SIZES: Record<ButtonSize, ViewStyle & { fontSize: number }> = {
  default: { height: 36, paddingHorizontal: 16, gap: 8, fontSize: 14 },
  sm: { height: 30, paddingHorizontal: 12, gap: 6, fontSize: 12 },
  lg: { height: 44, paddingHorizontal: 28, gap: 8, fontSize: 14 },
  icon: { height: 36, width: 36, paddingHorizontal: 0, gap: 0, fontSize: 14 },
};

interface Props {
  variant?: ButtonVariant;
  size?: ButtonSize;
  /** Leading icon; drawn at the web app's 16px in the label colour. */
  icon?: LucideIcon;
  /** Label: a string is styled as the button's text. */
  children?: ReactNode;
  onPress?: () => void;
  disabled?: boolean;
  /** Shows the pressed (web: active/hover) fill without a press, e.g. the selected tab. */
  active?: boolean;
  accessibilityLabel?: string;
  style?: StyleProp<ViewStyle>;
  hitSlop?: number;
}

/** Round pill button, the web app's `Button`. */
export function Button({
  variant = "default",
  size = "default",
  icon: Icon,
  children,
  onPress,
  disabled,
  active,
  accessibilityLabel,
  style,
  hitSlop,
}: Props) {
  const v = VARIANTS[variant];
  const { fontSize, ...box } = SIZES[size];
  const fg = active && variant === "ghost" ? colors.foreground : v.fg;
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      hitSlop={hitSlop ?? (size === "sm" ? 6 : 4)}
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel}
      accessibilityState={{ disabled: disabled === true, selected: active }}
      style={({ pressed }) => [
        styles.base,
        box,
        { backgroundColor: pressed || active ? v.pressed : v.bg },
        v.raised && shadows.soft,
        disabled && styles.disabled,
        style,
      ]}
    >
      {Icon ? <Icon size={16} color={fg} strokeWidth={2} /> : null}
      {typeof children === "string" ? (
        <Text
          style={[styles.label, { color: fg, fontSize }, variant === "link" && styles.link]}
          numberOfLines={1}
        >
          {children}
        </Text>
      ) : (
        children
      )}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  base: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    borderRadius: radius.full,
    flexShrink: 0,
  },
  label: { fontWeight: "500" },
  link: { textDecorationLine: "underline" },
  disabled: { opacity: 0.4 },
});
