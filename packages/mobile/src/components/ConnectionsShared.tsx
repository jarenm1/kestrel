import React, { type ReactNode } from "react";
import { StyleSheet, Text, View } from "react-native";
import type { Connection } from "@cloudagents/protocol";
import { Alert } from "@/components/ui/Alert";
import { Badge } from "@/components/ui/Badge";
import { colors, fonts } from "@/theme";

export const connectionStyles = StyleSheet.create({
  body: {
    gap: 8,
  },
  muted: {
    color: colors.mutedForeground,
    fontSize: 14,
  },
  hint: {
    color: colors.mutedForeground,
    fontSize: 12,
  },
  actions: {
    flexDirection: "row",
    flexWrap: "wrap",
    alignItems: "center",
    gap: 8,
  },
  /** `w-fit`: a button sized to its label inside the stretching body column. */
  fit: {
    alignSelf: "flex-start",
  },
  code: {
    color: colors.foreground,
    fontFamily: fonts.mono,
    fontSize: 18,
    fontWeight: "600",
    letterSpacing: 2,
  },
});

interface FrameProps {
  connection: Connection;
  error?: unknown;
  children: ReactNode;
}

/**
 * One connection, the web `ConnectionHeader` plus the row's body and error: label, connected badge, account, then controls.
 * Subscription rows state their account in the body instead, as the web page does.
 */
export function ConnectionRowFrame({ connection, error, children }: FrameProps) {
  const showAccount = connection.connected && connection.account && connection.kind !== "cli";
  return (
    <View style={styles.row}>
      <View style={styles.header}>
        <Text style={styles.label}>{connection.label}</Text>
        <Badge variant={connection.connected ? "success" : "neutral"}>
          {connection.connected ? "connected" : "not connected"}
        </Badge>
        {showAccount ? <Text style={styles.account}>{connection.account}</Text> : null}
      </View>
      <View style={connectionStyles.body}>{children}</View>
      {error ? <ErrorLine error={error} /> : null}
    </View>
  );
}

/** Visible error text: the `ApiError` message, or the stringified value for anything else. */
export function ErrorLine({ error }: { error: unknown }) {
  return <Alert>{error instanceof Error ? error.message : String(error)}</Alert>;
}

const styles = StyleSheet.create({
  row: {
    paddingHorizontal: 20,
    paddingVertical: 16,
    gap: 10,
  },
  header: {
    flexDirection: "row",
    flexWrap: "wrap",
    alignItems: "center",
    gap: 8,
  },
  label: {
    color: colors.foreground,
    fontSize: 14,
    fontWeight: "700",
  },
  account: {
    color: colors.mutedForeground,
    fontSize: 12,
    fontFamily: fonts.mono,
  },
});
