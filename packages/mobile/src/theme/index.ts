/**
 * Kestrel mobile theme — matches the webapp's dark-only design tokens.
 * Color values are taken directly from packages/app/src/styles.css.
 */

export const colors = {
  background: "#0e1014",
  foreground: "#e4e7ee",
  card: "#161921",
  cardForeground: "#e4e7ee",
  primary: "#5b8cff",
  primaryForeground: "#ffffff",
  secondary: "#1d212b",
  secondaryForeground: "#e4e7ee",
  muted: "#1d212b",
  mutedForeground: "#8a93a6",
  accent: "#232837",
  accentForeground: "#e4e7ee",
  destructive: "#f85149",
  border: "#293040",
  input: "#293040",
  ring: "#5b8cff",
  success: "#3fb950",
  warning: "#d29922",
  info: "#58a6ff",
  code: "#0a0c10",
} as const;

export const fonts = {
  sans: undefined, // uses system default
  mono: "SpaceMono",
} as const;

export const spacing = {
  xs: 4,
  sm: 8,
  md: 12,
  lg: 16,
  xl: 24,
  xxl: 32,
} as const;

export const radius = {
  sm: 4,
  md: 6,
  lg: 8,
  xl: 12,
} as const;

