import React from "react";
import { ActivityIndicator, FlatList, Pressable, StyleSheet, Text, View } from "react-native";
import type { HarnessCommand, ModelProvider } from "@cloudagents/protocol";
import { colors, fonts, radius, shadows, spacing } from "@/theme";

interface Props {
  matches: readonly HarnessCommand[];
  provider: ModelProvider | undefined;
  pending: boolean;
  onSelect: (command: HarnessCommand) => void;
}

export function SlashCommands({ matches, provider, pending, onSelect }: Props) {
  const prefix = provider === "openai" ? "$" : "/";

  if (pending) {
    return (
      <View style={styles.card}>
        <View style={styles.loadingRow}>
          <ActivityIndicator size="small" color={colors.mutedForeground} />
          <Text style={styles.muted}>Loading commands…</Text>
        </View>
      </View>
    );
  }

  if (matches.length === 0) {
    return (
      <View style={styles.card}>
        <Text style={[styles.muted, styles.emptyText]}>No matching commands</Text>
      </View>
    );
  }

  return (
    <View style={styles.card}>
      <FlatList
        data={matches}
        keyExtractor={(item) => item.name}
        keyboardShouldPersistTaps="always"
        style={styles.list}
        renderItem={({ item }) => (
          <Pressable
            style={({ pressed }) => [styles.item, pressed && styles.itemPressed]}
            onPress={() => onSelect(item)}
            accessibilityRole="button"
          >
            <View style={styles.nameRow}>
              <Text style={styles.name}>
                {prefix}
                {item.name}
              </Text>
              {item.argumentHint ? <Text style={styles.hint}>{item.argumentHint}</Text> : null}
            </View>
            {item.description ? (
              <Text style={styles.description} numberOfLines={2}>
                {item.description}
              </Text>
            ) : null}
          </Pressable>
        )}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    maxHeight: 180,
    borderRadius: radius.xl,
    backgroundColor: colors.secondary,
    borderWidth: 1,
    borderColor: colors.border,
    overflow: "hidden",
    marginBottom: spacing.xs,
    ...shadows.soft,
  },
  list: { flexGrow: 0 },
  loadingRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.sm,
    padding: spacing.md,
  },
  muted: { color: colors.mutedForeground, fontSize: 13 },
  emptyText: { padding: spacing.md },
  item: {
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.border,
  },
  itemPressed: { backgroundColor: colors.white06 },
  nameRow: { flexDirection: "row", alignItems: "center", gap: spacing.xs },
  name: { color: colors.foreground, fontSize: 14, fontWeight: "600" },
  hint: { color: colors.mutedForeground, fontSize: 12, fontFamily: fonts.mono },
  description: { color: colors.mutedForeground, fontSize: 12, marginTop: 2 },
});

