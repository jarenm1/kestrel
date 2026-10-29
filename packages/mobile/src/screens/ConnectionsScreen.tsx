import React, { useMemo, useState } from "react";
import { ScrollView, StyleSheet, Text, View } from "react-native";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Schema } from "effect";
import { CliProvider, type Connection } from "@cloudagents/protocol";
import { createQueries, keys } from "@/api/queries";
import { useApiClient } from "@/hooks/useApiClient";
import { Button } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import { Input } from "@/components/ui/Input";
import {
  ConnectionRowFrame,
  ErrorLine,
  connectionStyles,
} from "@/components/ConnectionsShared";
import { ConnectionsCliRow } from "@/components/ConnectionsCliRow";
import { ConnectionsModels } from "@/components/ConnectionsModels";
import { colors } from "@/theme";

/** API keys shorter than this are rejected by the server (`PutApiKeyBody`). */
const MIN_API_KEY_LENGTH = 8;

export function ConnectionsScreen() {
  const { api } = useApiClient();
  const queries = useMemo(() => createQueries(api), [api]);
  const connections = useQuery(queries.connections());

  return (
    <ScrollView style={styles.screen} contentContainerStyle={styles.content}>
      <View style={styles.heading}>
        <Text style={styles.title}>Connections</Text>
        <Text style={styles.description}>Accounts and keys Kestrel uses on your behalf.</Text>
      </View>
      {connections.error ? <ErrorLine error={connections.error} /> : null}
      {connections.isPending ? <Text style={connectionStyles.muted}>Loading…</Text> : null}
      {connections.data ? (
        <Card style={styles.card}>
          {connections.data.map((connection, index) => (
            <View key={connection.provider} style={index > 0 ? styles.divider : null}>
              <ConnectionRow connection={connection} />
            </View>
          ))}
        </Card>
      ) : null}
      {connections.data ? <ConnectionsModels connections={connections.data} /> : null}
    </ScrollView>
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
      <View style={connectionStyles.actions}>
        <Input
          style={styles.keyInput}
          value={apiKey}
          onChangeText={setApiKey}
          placeholder={connection.connected ? "Replace API key" : "API key"}
          secureTextEntry
          autoCapitalize="none"
          autoCorrect={false}
        />
        <Button disabled={busy || trimmed.length < MIN_API_KEY_LENGTH} onPress={() => save.mutate(trimmed)}>
          Save
        </Button>
        {connection.connected ? (
          <Button variant="soft" disabled={busy} onPress={() => disconnect.mutate()}>
            Disconnect
          </Button>
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
  /** The web card's `py-0` with its rows' own padding: no vertical or horizontal inset around the list. */
  card: {
    paddingVertical: 0,
    paddingHorizontal: 0,
    gap: 0,
  },
  divider: {
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.white06,
  },
  keyInput: {
    flexGrow: 1,
    flexBasis: 200,
  },
});
