import React, { type ReactNode } from "react";
import { StyleSheet, Text, View } from "react-native";
import type { QueryClient } from "@tanstack/react-query";
import { Schema } from "effect";
import { CLI_SIGN_IN, CliProvider, type Connection } from "@cloudagents/protocol";
import { boxKeys, keys } from "@/api/queries";
import { Alert } from "@/components/ui/Alert";
import { Badge } from "@/components/ui/Badge";
import { colors, fonts } from "@/theme";

/** What each CLI's sign-in gets the user, keyed by provider. */
export const CLI_INTRO: Record<CliProvider, string> = {
  "claude-cli": "Use your own Claude Pro or Max subscription.",
  "codex-cli": "Use your own ChatGPT subscription.",
  "antigravity-cli": "Use your own Google account through Antigravity CLI.",
  "opencode": "Sign in with OpenCode Console to use free models. The login stays in OpenCode on your box.",
  "opencode-go": "Use your OpenCode Go subscription. The API key stays in OpenCode on your box.",
};

/** The CLI provider a key-based CLI connection signs in with, or null for page sign-ins and non-CLI rows. */
export function keyCliProvider(connection: Connection): CliProvider | null {
  return connection.kind === "cli" &&
    Schema.is(CliProvider)(connection.provider) &&
    CLI_SIGN_IN[connection.provider] === "key"
    ? connection.provider
    : null;
}

/** Rows shown under API keys: provider keys, and key-based CLI logins that keep their box-local authentication. */
export function isApiKeyConnection(connection: Connection): boolean {
  return connection.kind === "apikey" || keyCliProvider(connection) !== null;
}

/**
 * Re-reads the connections, whose CLI and harness rows come from the active box, and the usage figures a changed login
 * moves.
 */
export function invalidateConnections(queryClient: QueryClient, scope: string): void {
  void queryClient.invalidateQueries({ queryKey: keys.connections });
  const scoped = boxKeys(scope);
  void queryClient.invalidateQueries({ queryKey: scoped.usage });
  void queryClient.invalidateQueries({ queryKey: scoped.providerUsage });
  void queryClient.invalidateQueries({ queryKey: scoped.usageActivity });
}

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
