import React from "react";
import { ActivityIndicator, FlatList, Pressable, StyleSheet, Text, View } from "react-native";
import type { HarnessCommand } from "@cloudagents/protocol";
import { commandPrefixForHarness } from "@cloudagents/composer/commands";
import type { ModelMentionHarness } from "@cloudagents/composer/models";
import { colors, fonts, radius, shadows, spacing } from "@/theme";

interface Props {
  matches: readonly HarnessCommand[];
  harness: ModelMentionHarness | undefined;
  pending: boolean;
  onSelect: (command: HarnessCommand) => void;
  activeIndex: number;
}

export function SlashCommands({ matches, harness, pending, onSelect, activeIndex }: Props) {
  // App-owned actions are available before (and without) the harness list: only an empty menu waits on it.
  if (pending && matches.length === 0) {
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
        keyExtractor={(item) => `${commandPrefixForHarness(item, harness)}${item.name}`}
        keyboardShouldPersistTaps="always"
        style={styles.list}
        renderItem={({ item, index }) => (
          <Pressable
            style={({ pressed }) => [styles.item, (pressed || index === activeIndex) && styles.itemPressed]}
            onPress={() => onSelect(item)}
            accessibilityRole="button"
            accessibilityState={{ selected: index === activeIndex }}
          >
            <View style={styles.nameRow}>
              <Text style={styles.name}>
                {commandPrefixForHarness(item, harness)}
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

