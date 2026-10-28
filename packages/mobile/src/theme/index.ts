import { Platform, type ViewStyle } from "react-native";

/**
 * Kestrel mobile theme: the web app's dark-only, monochrome tokens (packages/app/src/styles.css).
 * White is the accent; blue (`info`) is reserved for states white can't carry.
 * Solid colors are 6-digit hex so `colors.x + "1f"` adds an alpha channel.
 */
export const colors = {
  background: "#0a0a0b",
  foreground: "#ededef",
  card: "#141416",
  cardForeground: "#ededef",
  primary: "#f5f5f6",
  primaryForeground: "#0a0a0b",
  secondary: "#1c1c1f",
  secondaryForeground: "#ededef",
  muted: "#1c1c1f",
  mutedForeground: "#8b8b93",
  accent: "#242428",
  accentForeground: "#ededef",
  destructive: "#f2555a",
  border: "rgba(255,255,255,0.07)",
  input: "rgba(255,255,255,0.05)",
  ring: "#ffffff",
  success: "#4ade80",
  warning: "#e3b341",
  info: "#6b9bff",
  code: "#070708",
  /** Translucent white washes the web app uses for hover, pills and soft buttons (`bg-white/[0.06]`). */
  white03: "rgba(255,255,255,0.03)",
  white06: "rgba(255,255,255,0.06)",
  white08: "rgba(255,255,255,0.08)",
  white12: "rgba(255,255,255,0.12)",
  scrim: "rgba(0,0,0,0.55)",
} as const;

export const fonts = {
  /** System sans; the web app's Inter is not bundled. */
  sans: undefined,
  mono: Platform.select({ ios: "Menlo", default: "monospace" }),
} as const;

export const spacing = {
  xs: 4,
  sm: 8,
  md: 12,
  lg: 16,
  xl: 24,
  xxl: 32,
} as const;

/** Web `--radius` is 14px; the steps match its `radius-sm` … `radius-2xl`. */
export const radius = {
  sm: 10,
  md: 12,
  lg: 14,
  xl: 18,
  xxl: 22,
  full: 999,
} as const;

/** The web app's depth: `shadow-soft` (raised) and `shadow-well` (inset panels, approximated with a dark fill). */
export const shadows = {
  soft: {
    shadowColor: "#000",
    shadowOpacity: 0.7,
    shadowRadius: 12,
    shadowOffset: { width: 0, height: 8 },
    elevation: 4,
  } satisfies ViewStyle,
} as const;
