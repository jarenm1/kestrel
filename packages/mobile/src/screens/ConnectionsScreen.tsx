import React, { useMemo, useState } from "react";
import {
  View,
  Text,
  TextInput,
  StyleSheet,
  ScrollView,
  Pressable,
  ActivityIndicator,
  Alert,
} from "react-native";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useApiClient } from "@/hooks/useApiClient";
import { createQueries, keys } from "@/api/queries";
import { colors, radius, spacing } from "@/theme";
import type { Connection } from "@/api/types";

interface Props {
  onBack: () => void;
}

export function ConnectionsScreen({ onBack }: Props) {
  const { api } = useApiClient();
  const queryClient = useQueryClient();
  const queries = useMemo(() => createQueries(api), [api]);
  const connections = useQuery(queries.connections());

  return (
    <View style={styles.container}>
      <View style={styles.header}>
        <Pressable onPress={onBack} style={styles.backBtn}>
          <Text style={styles.backText}>← Back</Text>
        </Pressable>
        <Text style={styles.headerTitle}>API Keys & Connections</Text>
      </View>

      <ScrollView contentContainerStyle={styles.content}>
        <Text style={styles.sectionSubtitle}>
          Configure LLM API keys and model credentials for your agents.
        </Text>

        {connections.isPending && (
          <ActivityIndicator color={colors.primary} style={{ marginTop: 24 }} />
        )}

        {connections.error && (
          <View style={styles.errorBox}>
            <Text style={styles.errorText}>
              {connections.error instanceof Error
                ? connections.error.message
                : "Failed to load connections"}
            </Text>
          </View>
        )}

        {connections.data?.map((conn) => (
          <ConnectionCard key={conn.provider} connection={conn} />
        ))}
      </ScrollView>
    </View>
  );
}

function ConnectionCard({ connection }: { connection: Connection }) {
  const { api } = useApiClient();
  const queryClient = useQueryClient();
  const [keyInput, setKeyInput] = useState("");

  const refresh = () =>
    queryClient.invalidateQueries({ queryKey: keys.connections });

  const saveMutation = useMutation({
    mutationFn: (apiKey: string) =>
      api.putApiKey(connection.provider, { apiKey }),
    onSuccess: () => {
      setKeyInput("");
      refresh();
      Alert.alert("Success", `${connection.label} key saved.`);
    },
    onError: (err: any) => {
      Alert.alert("Error", err?.message ?? "Failed to save key");
    },
  });

  const deleteMutation = useMutation({
    mutationFn: () => api.deleteConnection(connection.provider),
    onSuccess: () => {
      refresh();
      Alert.alert("Disconnected", `${connection.label} disconnected.`);
    },
  });

  const busy = saveMutation.isPending || deleteMutation.isPending;

  return (
    <View style={styles.card}>
      <View style={styles.cardHeader}>
        <View style={styles.providerInfo}>
          <Text style={styles.providerLabel}>{connection.label}</Text>
          {connection.account ? (
            <Text style={styles.accountText}>{connection.account}</Text>
          ) : null}
        </View>
        <View
          style={[
            styles.statusPill,
            {
              backgroundColor: connection.connected
                ? colors.success + "22"
                : colors.muted,
            },
          ]}
        >
          <Text
            style={[
              styles.statusText,
              {
                color: connection.connected
                  ? colors.success
                  : colors.mutedForeground,
              },
            ]}
          >
            {connection.connected ? "Connected" : "Not connected"}
          </Text>
        </View>
      </View>

      {connection.kind === "apikey" && (
        <View style={styles.inputRow}>
          <TextInput
            style={styles.input}
            value={keyInput}
            onChangeText={setKeyInput}
            placeholder={
              connection.connected ? "Replace API key…" : "Enter API key…"
            }
            placeholderTextColor={colors.mutedForeground}
            secureTextEntry
            autoCapitalize="none"
            autoCorrect={false}
          />
          <Pressable
            style={[
              styles.btn,
              styles.saveBtn,
              (busy || keyInput.trim().length < 8) && styles.btnDisabled,
            ]}
            onPress={() => saveMutation.mutate(keyInput.trim())}
            disabled={busy || keyInput.trim().length < 8}
          >
            <Text style={styles.saveBtnText}>
              {saveMutation.isPending ? "…" : "Save"}
            </Text>
          </Pressable>
          {connection.connected && (
            <Pressable
              style={[styles.btn, styles.disconnectBtn, busy && styles.btnDisabled]}
              onPress={() => deleteMutation.mutate()}
              disabled={busy}
            >
              <Text style={styles.disconnectBtnText}>Remove</Text>
            </Pressable>
          )}
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: colors.background,
  },
  header: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.md,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.md,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
    backgroundColor: colors.card,
  },
  backBtn: {
    paddingVertical: 4,
    paddingRight: spacing.sm,
  },
  backText: {
    color: colors.primary,
    fontSize: 14,
    fontWeight: "500",
  },
  headerTitle: {
    color: colors.foreground,
    fontSize: 16,
    fontWeight: "600",
  },
  content: {
    padding: spacing.lg,
    gap: spacing.md,
  },
  sectionSubtitle: {
    color: colors.mutedForeground,
    fontSize: 13,
    marginBottom: spacing.xs,
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
  card: {
    backgroundColor: colors.card,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: colors.border,
    padding: spacing.lg,
    gap: spacing.md,
  },
  cardHeader: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
  },
  providerInfo: {
    gap: 2,
  },
  providerLabel: {
    color: colors.foreground,
    fontSize: 15,
    fontWeight: "600",
  },
  accountText: {
    color: colors.mutedForeground,
    fontSize: 12,
    fontFamily: "monospace",
  },
  statusPill: {
    paddingHorizontal: spacing.sm,
    paddingVertical: 2,
    borderRadius: radius.sm,
  },
  statusText: {
    fontSize: 11,
    fontWeight: "600",
  },
  inputRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.sm,
  },
  input: {
    flex: 1,
    backgroundColor: colors.secondary,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.md,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    color: colors.foreground,
    fontSize: 13,
  },
  btn: {
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm + 2,
    borderRadius: radius.md,
    alignItems: "center",
    justifyContent: "center",
  },
  saveBtn: {
    backgroundColor: colors.primary,
  },
  saveBtnText: {
    color: colors.primaryForeground,
    fontSize: 13,
    fontWeight: "600",
  },
  disconnectBtn: {
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: "transparent",
  },
  disconnectBtnText: {
    color: colors.destructive,
    fontSize: 13,
  },
  btnDisabled: {
    opacity: 0.4,
  },
});

