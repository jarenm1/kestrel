import React, { type ReactNode } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import type { Connection, ConnectionKind } from "@cloudagents/protocol";
import { colors, fonts, radius, spacing } from "@/theme";

const KIND_LABEL: Record<ConnectionKind, string> = {
  apikey: "API key",
  oauth: "OAuth",
  cli: "Subscription",
};

export const connectionStyles = StyleSheet.create({
  row: {
    padding: spacing.lg,
    gap: spacing.md,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.border,
  },
  body: {
    gap: spacing.sm,
  },
  muted: {
    color: colors.mutedForeground,
    fontSize: 13,
  },
  hint: {
    color: colors.mutedForeground,
    fontSize: 12,
  },
  input: {
    backgroundColor: colors.secondary,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.md,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    color: colors.foreground,
    fontSize: 14,
  },
  actions: {
    flexDirection: "row",
    flexWrap: "wrap",
    alignItems: "center",
    gap: spacing.sm,
  },
  code: {
    color: colors.foreground,
    fontFamily: fonts.mono,
    fontSize: 20,
    fontWeight: "600",
    letterSpacing: 2,
  },
});

interface FrameProps {
  connection: Connection;
  error?: unknown;
  children: ReactNode;
}

/** One connection: label, kind, connected state and account, then the row's controls and any error. */
export function ConnectionRowFrame({ connection, error, children }: FrameProps) {
  return (
    <View style={connectionStyles.row}>
      <View style={styles.header}>
        <View style={styles.titleBlock}>
          <View style={styles.titleLine}>
            <Text style={styles.label}>{connection.label}</Text>
            <Text style={styles.kind}>{KIND_LABEL[connection.kind]}</Text>
          </View>
          {connection.account ? <Text style={styles.account}>{connection.account}</Text> : null}
        </View>
        <View
          style={[
            styles.pill,
            { backgroundColor: connection.connected ? colors.success + "22" : colors.muted },
          ]}
        >
          <Text
            style={[
              styles.pillText,
              { color: connection.connected ? colors.success : colors.mutedForeground },
            ]}
          >
            {connection.connected ? "Connected" : "Not connected"}
          </Text>
        </View>
      </View>
      <View style={connectionStyles.body}>{children}</View>
      {error ? <ErrorLine error={error} /> : null}
    </View>
  );
}

/** Visible error text: the `ApiError` message, or the stringified value for anything else. */
export function ErrorLine({ error }: { error: unknown }) {
  return (
    <View style={styles.errorBox}>
      <Text style={styles.errorText}>{error instanceof Error ? error.message : String(error)}</Text>
    </View>
  );
}

interface ActionButtonProps {
  label: string;
  onPress: () => void;
  disabled?: boolean;
  tone?: "primary" | "secondary";
}

export function ActionButton({ label, onPress, disabled = false, tone = "primary" }: ActionButtonProps) {
  const primary = tone === "primary";
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ disabled }}
      disabled={disabled}
      onPress={onPress}
      style={[
        styles.button,
        primary ? styles.buttonPrimary : styles.buttonSecondary,
        disabled && styles.disabled,
      ]}
    >
      <Text style={primary ? styles.buttonTextPrimary : styles.buttonTextSecondary}>{label}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  header: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "flex-start",
    gap: spacing.sm,
  },
  titleBlock: {
    flex: 1,
    gap: 2,
  },
  titleLine: {
    flexDirection: "row",
    flexWrap: "wrap",
    alignItems: "center",
    gap: spacing.sm,
  },
  label: {
    color: colors.foreground,
    fontSize: 15,
    fontWeight: "600",
  },
  kind: {
    color: colors.mutedForeground,
    fontSize: 11,
  },
  account: {
    color: colors.mutedForeground,
    fontSize: 12,
    fontFamily: fonts.mono,
  },
  pill: {
    paddingHorizontal: spacing.sm,
    paddingVertical: 2,
    borderRadius: radius.sm,
  },
  pillText: {
    fontSize: 11,
    fontWeight: "600",
  },
  errorBox: {
    backgroundColor: colors.destructive + "18",
    padding: spacing.md,
    borderRadius: radius.md,
  },
  errorText: {
    color: colors.destructive,
    fontSize: 13,
  },
  button: {
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm + 2,
    borderRadius: radius.md,
    alignItems: "center",
    justifyContent: "center",
  },
  buttonPrimary: {
    backgroundColor: colors.primary,
  },
  buttonSecondary: {
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.secondary,
  },
  buttonTextPrimary: {
    color: colors.primaryForeground,
    fontSize: 13,
    fontWeight: "600",
  },
  buttonTextSecondary: {
    color: colors.foreground,
    fontSize: 13,
    fontWeight: "600",
  },
  disabled: {
    opacity: 0.4,
  },
});
