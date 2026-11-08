import React, { type ReactNode } from "react";
import { StyleSheet, Text, View } from "react-native";
import type { QueryClient } from "@tanstack/react-query";
import { Schema } from "effect";
import { CLI_SIGN_IN, CliProvider, type Connection } from "@cloudagents/protocol";
import { boxKeys, keys } from "@/api/queries";
import { Alert } from "@/components/ui/Alert";
import { Badge } from "@/components/ui/Badge";
import { HarnessLogo } from "@/components/HarnessLogo";
import { colors, fonts } from "@/theme";
import type { HarnessId } from "@cloudagents/ui/harness-logos";

/** What each CLI's sign-in gets the user, keyed by provider. */
export const CLI_INTRO: Record<CliProvider, string> = {
  "claude-cli": "Use your own Claude Pro or Max subscription.",
  "codex-cli": "Use your own ChatGPT subscription.",
  "antigravity-cli": "Use your own Google account through Antigravity CLI.",
  "opencode": "Sign in with OpenCode Console to use free models. The login stays in OpenCode on your box.",
  "opencode-go": "Use your OpenCode Go subscription. The API key stays in OpenCode on your box.",
  "devin-cli": "Use your own Devin account through Devin CLI.",
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
 * The harness mark beside a subscription row, keyed by the connection it signs in. Only page sign-ins draw one, as on
 * desktop; key-based CLI logins live with the API keys.
 */
const HARNESS_OF_CONNECTION: Partial<Record<string, HarnessId>> = {
  "claude-cli": "claude",
  "codex-cli": "codex",
  "antigravity-cli": "antigravity",
  opencode: "opencode",
  "devin-cli": "devin",
};

export function harnessForConnection(provider: string): HarnessId | undefined {
  return HARNESS_OF_CONNECTION[provider];
}

/**
 * Re-reads the connections, whose CLI and harness rows come from the active box, and the usage figures a changed login
 * moves.
 */
export function invalidateConnections(queryClient: QueryClient, scope: string): Promise<void> {
  const connections = queryClient.invalidateQueries({ queryKey: keys.connections });
  const scoped = boxKeys(scope);
  void queryClient.invalidateQueries({ queryKey: scoped.models });
  void queryClient.invalidateQueries({ queryKey: scoped.usage });
  void queryClient.invalidateQueries({ queryKey: scoped.providerUsage });
  void queryClient.invalidateQueries({ queryKey: scoped.usageActivity });
  return connections;
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
  /** Harness mark in its own hanging column, for subscription rows. */
  harness?: HarnessId;
  /** Shown beside the name, e.g. the model-visibility picker. */
  headerExtra?: ReactNode;
  /** False for subscription rows, which state the signed-in account in their body instead. */
  showAccount?: boolean;
  children: ReactNode;
}

/**
 * One connection, the web `ConnectionHeader` plus the row's body and error: label, connected badge, account, then controls.
 * Subscription rows state their account in the body instead, as the web page does.
 */
export function ConnectionRowFrame({
  connection,
  error,
  harness,
  headerExtra,
  showAccount = true,
  children,
}: FrameProps) {
  const account = showAccount && connection.connected ? connection.account : null;
  return (
    <View style={styles.row}>
      {harness ? (
        <View style={styles.harness}>
          <HarnessLogo harness={harness} size={24} />
        </View>
      ) : null}
      <View style={styles.main}>
        <View style={styles.header}>
          <Text style={styles.label}>{connection.label}</Text>
          <Badge variant={connection.connected ? "success" : "neutral"}>
            {connection.connected
              ? connection.accounts !== undefined && connection.accounts.length > 1
                ? `${connection.accounts.length} connected`
                : "connected"
              : "not connected"}
          </Badge>
          {account ? <Text style={styles.account}>{account}</Text> : null}
          {headerExtra}
        </View>
        <View style={connectionStyles.body}>{children}</View>
        {error ? <ErrorLine error={error} /> : null}
      </View>
    </View>
  );
}

/** Visible error text: the `ApiError` message, or the stringified value for anything else. */
export function ErrorLine({ error }: { error: unknown }) {
  return <Alert>{error instanceof Error ? error.message : String(error)}</Alert>;
}

const styles = StyleSheet.create({
  row: {
    flexDirection: "row",
    alignItems: "flex-start",
    paddingHorizontal: 20,
    paddingVertical: 16,
    gap: 12,
  },
  harness: { marginTop: 2 },
  main: { flex: 1, gap: 10 },
  header: {
    flexDirection: "row",
    flexWrap: "wrap",
    alignItems: "center",
    gap: 8,
  },
  label: {
    flexShrink: 1,
    color: colors.foreground,
    fontSize: 14,
    fontWeight: "700",
  },
  account: {
    flexShrink: 1,
    color: colors.mutedForeground,
    fontSize: 12,
    fontFamily: fonts.mono,
  },
});
