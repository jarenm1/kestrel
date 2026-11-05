import React, { useMemo, useState } from "react";
import { Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Schema } from "effect";
import { MODEL_PROVIDERS, CliProvider, type Connection } from "@cloudagents/protocol";
import { Plus } from "lucide-react-native";
import { createQueries } from "@/api/queries";
import { useApiClient } from "@/hooks/useApiClient";
import { Button } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import { Input } from "@/components/ui/Input";
import {
  CLI_INTRO,
  ConnectionRowFrame,
  ErrorLine,
  connectionStyles,
  invalidateConnections,
  isApiKeyConnection,
  keyCliProvider,
} from "@/components/ConnectionsShared";
import { ConnectionsCliRow } from "@/components/ConnectionsCliRow";
import { ModelPicker } from "@/components/ConnectionsModelPicker";
import { colors, spacing } from "@/theme";

/** API keys shorter than this are rejected by the server (`PutApiKeyBody`). */
const MIN_API_KEY_LENGTH = 8;

/**
 * Body of Settings › Connections: **Harnesses/Subscriptions** groups subscription sign-ins and installed harnesses,
 * each with its chat-model picker beside the name, and **API keys** keeps provider keys and key-based CLI logins with
 * their model preferences. Desktop manages GitHub access from Profile; until the mobile Profile screen lands, the
 * informational OAuth row stays here so that access is not lost.
 */
export function ConnectionsScreen() {
  const { api } = useApiClient();
  const queries = useMemo(() => createQueries(api), [api]);
  const connections = useQuery(queries.connections());
  const harnesses = connections.data?.filter(
    (connection) => connection.kind === "cli" && !isApiKeyConnection(connection)
  );
  const accounts = connections.data?.filter((connection) => connection.kind === "oauth");

  return (
    <ScrollView
      style={styles.screen}
      contentContainerStyle={styles.content}
      keyboardShouldPersistTaps="handled"
    >
      <View style={styles.heading}>
        <Text style={styles.title}>Connections</Text>
        <Text style={styles.description}>Accounts and keys Kestrel uses on your behalf.</Text>
      </View>
      {connections.error ? <ErrorLine error={connections.error} /> : null}
      {connections.isPending ? <Text style={connectionStyles.muted}>Loading…</Text> : null}
      {harnesses ? (
        <View style={styles.section}>
          <Text style={styles.sectionTitle}>Harnesses/Subscriptions</Text>
          <Card style={styles.card}>
            {/* A box switch remounts each row, so a sign-in still pending on the old box cannot finish here. */}
            {harnesses.map((connection, index) => (
              <View key={`${api.boxScope}:${connection.provider}`} style={index > 0 ? styles.divider : null}>
                <ConnectionRow connection={connection} />
              </View>
            ))}
          </Card>
        </View>
      ) : null}
      {accounts && accounts.length > 0 ? (
        <View style={styles.section}>
          <Text style={styles.sectionTitle}>Accounts</Text>
          <Card style={styles.card}>
            {accounts.map((connection, index) => (
              <View key={`${api.boxScope}:${connection.provider}`} style={index > 0 ? styles.divider : null}>
                <OAuthRow connection={connection} />
              </View>
            ))}
          </Card>
        </View>
      ) : null}
      {connections.data ? <ApiKeysCard connections={connections.data} /> : null}
    </ScrollView>
  );
}

function ConnectionRow({ connection }: { connection: Connection }) {
  if (
    connection.kind === "cli" &&
    Schema.is(CliProvider)(connection.provider) &&
    !isApiKeyConnection(connection)
  ) {
    return <ConnectionsCliRow connection={connection} provider={connection.provider} />;
  }
  return null;
}

/** Provider keys and key-based CLI logins, including unavailable logins whose saved-key state is unknown. */
function ApiKeysCard({ connections }: { connections: readonly Connection[] }) {
  const { api } = useApiClient();
  const [selected, setSelected] = useState<readonly string[]>([]);
  const [menuOpen, setMenuOpen] = useState(false);
  const providers = connections.filter(isApiKeyConnection);
  const visible = providers.filter(
    (connection) => connection.connected || selected.includes(connection.provider) ||
      (connection.kind === "cli" && !connection.available)
  );
  const remaining = providers.filter((connection) => !visible.includes(connection));

  function add(provider: string) {
    setSelected((current) => (current.includes(provider) ? current : [...current, provider]));
    setMenuOpen(false);
  }

  function remove(provider: string) {
    setSelected((current) => current.filter((id) => id !== provider));
  }

  return (
    <View style={styles.section}>
      <View style={styles.sectionHead}>
        <Text style={styles.sectionTitle}>API keys</Text>
        <Button
          variant="soft"
          size="sm"
          icon={Plus}
          disabled={remaining.length === 0}
          active={menuOpen}
          onPress={() => setMenuOpen((current) => !current)}
        >
          Add API key
        </Button>
      </View>
      {menuOpen && remaining.length > 0 ? (
        <Card style={styles.menu}>
          {remaining.map((connection, index) => (
            <Pressable
              key={connection.provider}
              style={[styles.menuItem, index > 0 && styles.divider]}
              onPress={() => add(connection.provider)}
              accessibilityRole="button"
              accessibilityLabel={`Add ${connection.label} API key`}
            >
              <Text style={styles.menuItemLabel}>{connection.label}</Text>
            </Pressable>
          ))}
        </Card>
      ) : null}
      {visible.length > 0 ? (
        <Card style={styles.card}>
          {visible.map((connection, index) => (
            <View key={`${api.boxScope}:${connection.provider}`} style={index > 0 ? styles.divider : null}>
              <ApiKeyRow connection={connection} onRemove={() => remove(connection.provider)} />
            </View>
          ))}
        </Card>
      ) : (
        <Text style={styles.empty}>No api keys added</Text>
      )}
    </View>
  );
}

interface ApiKeyRowProps {
  connection: Connection;
  /** Hides a row the user added but has not connected, after removing or disconnecting it. */
  onRemove?: () => void;
}

function ApiKeyRow({ connection, onRemove }: ApiKeyRowProps) {
  const { api } = useApiClient();
  const queryClient = useQueryClient();
  const [apiKey, setApiKey] = useState("");
  const trimmed = apiKey.trim();
  const keyProvider = keyCliProvider(connection);

  const save = useMutation({
    mutationFn: async (key: string) => {
      if (keyProvider) await api.cliLoginKey(keyProvider, { apiKey: key });
      else await api.putApiKey(connection.provider, { apiKey: key });
    },
    onSuccess: () => {
      setApiKey("");
      invalidateConnections(queryClient, api.boxScope);
    },
  });
  const disconnect = useMutation({
    mutationFn: () =>
      keyProvider ? api.cliLogout(keyProvider) : api.deleteConnection(connection.provider),
    onSuccess: () => {
      onRemove?.();
      invalidateConnections(queryClient, api.boxScope);
    },
  });

  const busy = save.isPending || disconnect.isPending;
  const error = save.error ?? disconnect.error;
  // API-key access keeps its model preferences beside the key.
  const modelProvider = MODEL_PROVIDERS.find(
    (provider) => provider.connections.includes(connection.provider)
  );
  const intro = keyProvider ? CLI_INTRO[keyProvider] : undefined;
  const picker =
    connection.connected && modelProvider ? <ModelPicker provider={modelProvider} /> : null;

  if (keyProvider && !connection.available) {
    return (
      <ConnectionRowFrame connection={connection} error={error}>
        {intro ? <Text style={connectionStyles.muted}>{intro}</Text> : null}
        <Text style={connectionStyles.muted}>{connection.error ?? "Agent box is offline."}</Text>
        <View style={connectionStyles.actions}>
          <Button
            variant="soft"
            onPress={() => invalidateConnections(queryClient, api.boxScope)}
          >
            Check again
          </Button>
          {picker}
        </View>
      </ConnectionRowFrame>
    );
  }

  return (
    <ConnectionRowFrame connection={connection} error={error}>
      {intro ? <Text style={connectionStyles.muted}>{intro}</Text> : null}
      <View style={connectionStyles.actions}>
        <Input
          style={styles.keyInput}
          value={apiKey}
          onChangeText={setApiKey}
          placeholder={connection.connected ? "Replace API key" : "API key"}
          accessibilityLabel={`${connection.label} API key`}
          secureTextEntry
          autoCapitalize="none"
          autoCorrect={false}
        />
        {connection.connected && trimmed.length === 0 ? (
          <Button variant="soft" disabled={busy} onPress={() => disconnect.mutate()}>
            Disconnect
          </Button>
        ) : (
          <Button disabled={busy || trimmed.length < MIN_API_KEY_LENGTH} onPress={() => save.mutate(trimmed)}>
            Save
          </Button>
        )}
        {!connection.connected && onRemove ? (
          <Button variant="soft" disabled={busy} onPress={onRemove}>
            Remove
          </Button>
        ) : null}
        {picker}
      </View>
    </ConnectionRowFrame>
  );
}

/** OAuth access, e.g. GitHub, which desktop manages from Profile and mobile finishes in the web app. */
function OAuthRow({ connection }: { connection: Connection }) {
  return (
    <ConnectionRowFrame connection={connection} expired={connection.expired}>
      <Text style={connectionStyles.muted}>
        {connection.available
          ? `${connection.connected ? "Reconnect" : "Connect"} ${connection.label} on the web app`
          : "needs server config"}
      </Text>
    </ConnectionRowFrame>
  );
}

const styles = StyleSheet.create({
  screen: {
    flex: 1,
    backgroundColor: colors.background,
  },
  content: {
    padding: 16,
    gap: 16,
  },
  heading: {
    gap: 2,
  },
  title: {
    color: colors.foreground,
    fontSize: 20,
    fontWeight: "600",
    letterSpacing: -0.5,
  },
  description: {
    color: colors.mutedForeground,
    fontSize: 14,
  },
  section: {
    gap: spacing.sm,
  },
  sectionHead: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: spacing.sm,
  },
  sectionTitle: {
    color: colors.foreground,
    fontSize: 16,
    fontWeight: "600",
  },
  /** The web card's `py-0` with its rows' own padding: no vertical or horizontal inset around the list. */
  card: {
    paddingVertical: 0,
    paddingHorizontal: 0,
    gap: 0,
  },
  menu: {
    paddingVertical: 0,
    paddingHorizontal: 0,
    gap: 0,
    overflow: "hidden",
  },
  menuItem: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.sm,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.md,
  },
  menuItemLabel: {
    color: colors.foreground,
    fontSize: 14,
  },
  divider: {
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.white06,
  },
  keyInput: {
    flexGrow: 1,
    flexBasis: 200,
  },
  /** The web's centered muted paragraph when no key rows are visible. */
  empty: {
    color: colors.mutedForeground,
    fontSize: 14,
    textAlign: "center",
    paddingVertical: spacing.lg,
  },
});
