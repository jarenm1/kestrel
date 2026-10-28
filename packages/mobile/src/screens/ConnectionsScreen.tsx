import React, { useMemo, useState } from "react";
import { ActivityIndicator, ScrollView, StyleSheet, Text, TextInput, View } from "react-native";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Schema } from "effect";
import { CliProvider, type Connection } from "@cloudagents/protocol";
import { createQueries, keys } from "@/api/queries";
import { useApiClient } from "@/hooks/useApiClient";
import { useNavigation } from "@/nav/navigation";
import { ScreenHeader } from "@/components/ScreenHeader";
import {
  ActionButton,
  ConnectionRowFrame,
  ErrorLine,
  connectionStyles,
} from "@/components/ConnectionsShared";
import { ConnectionsCliRow } from "@/components/ConnectionsCliRow";
import { colors, radius, spacing } from "@/theme";

/** API keys shorter than this are rejected by the server (`PutApiKeyBody`). */
const MIN_API_KEY_LENGTH = 8;

export function ConnectionsScreen() {
  const { api } = useApiClient();
  const navigation = useNavigation();
  const queries = useMemo(() => createQueries(api), [api]);
  const connections = useQuery(queries.connections());

  return (
    <View style={styles.screen}>
      <ScreenHeader title="Connections" onBack={() => navigation.back()} />
      <ScrollView contentContainerStyle={styles.content}>
        <Text style={styles.subtitle}>Accounts and keys Kestrel uses on your behalf.</Text>
        {connections.isPending ? <ActivityIndicator color={colors.primary} /> : null}
        {connections.error ? <ErrorLine error={connections.error} /> : null}
        {connections.data ? (
          <View style={styles.card}>
            {connections.data.map((connection) => (
              <ConnectionRow key={connection.provider} connection={connection} />
            ))}
          </View>
        ) : null}
      </ScrollView>
    </View>
  );
}

function ConnectionRow({ connection }: { connection: Connection }) {
  if (connection.kind === "oauth") return <OAuthRow connection={connection} />;
  if (connection.kind === "cli" && Schema.is(CliProvider)(connection.provider)) {
    return <ConnectionsCliRow connection={connection} provider={connection.provider} />;
  }
  return <ApiKeyRow connection={connection} />;
}

function ApiKeyRow({ connection }: { connection: Connection }) {
  const { api } = useApiClient();
  const queryClient = useQueryClient();
  const [apiKey, setApiKey] = useState("");
  const trimmed = apiKey.trim();

  const save = useMutation({
    mutationFn: (key: string) => api.putApiKey(connection.provider, { apiKey: key }),
    onSuccess: () => {
      setApiKey("");
      void queryClient.invalidateQueries({ queryKey: keys.connections });
    },
  });
  const disconnect = useMutation({
    mutationFn: () => api.deleteConnection(connection.provider),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: keys.connections });
    },
  });

  const busy = save.isPending || disconnect.isPending;
  const error = save.error ?? disconnect.error;

  return (
    <ConnectionRowFrame connection={connection} error={error}>
      <TextInput
        style={connectionStyles.input}
        value={apiKey}
        onChangeText={setApiKey}
        placeholder={connection.connected ? "Replace API key" : "API key"}
        placeholderTextColor={colors.mutedForeground}
        secureTextEntry
        autoCapitalize="none"
        autoCorrect={false}
      />
      <View style={connectionStyles.actions}>
        <ActionButton
          label="Save"
          disabled={busy || trimmed.length < MIN_API_KEY_LENGTH}
          onPress={() => save.mutate(trimmed)}
        />
        {connection.connected ? (
          <ActionButton
            label="Disconnect"
            tone="secondary"
            disabled={busy}
            onPress={() => disconnect.mutate()}
          />
        ) : null}
      </View>
    </ConnectionRowFrame>
  );
}

function OAuthRow({ connection }: { connection: Connection }) {
  // OAuth needs the signed-in session cookie, which the app cannot hand to an external browser.
  return (
    <ConnectionRowFrame connection={connection}>
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
    padding: spacing.lg,
    gap: spacing.md,
  },
  subtitle: {
    color: colors.mutedForeground,
    fontSize: 13,
  },
  card: {
    backgroundColor: colors.card,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: colors.border,
    overflow: "hidden",
  },
});
