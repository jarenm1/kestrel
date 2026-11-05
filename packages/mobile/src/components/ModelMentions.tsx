import React from "react";
import { ActivityIndicator, FlatList, Pressable, StyleSheet, Text, View } from "react-native";
import { modelMentionOf } from "@cloudagents/composer/models";
import type { ModelInfo } from "@cloudagents/protocol";
import { HarnessLogo } from "./HarnessLogo";
import { colors, radius, shadows, spacing } from "@/theme";

interface Props {
  /** The connected models the user keeps in the picker, filtered by the `@` query. */
  readonly matches: readonly ModelInfo[];
  /** The text after `@`; empty right after the trigger. */
  readonly query: string;
  readonly pending: boolean;
  readonly failed: boolean;
  readonly activeIndex: number;
  readonly onSelect: (model: ModelInfo) => void;
}

/** The `@model` menu in the `/` commands' card: harness mark, rich model name, provider-qualified slug. */
export function ModelMentions({ matches, query, pending, failed, activeIndex, onSelect }: Props) {
  // Connections are the only source of the catalog: an empty menu waits on them.
  if (pending && matches.length === 0) {
    return (
      <View style={styles.card}>
        <View style={styles.loadingRow}>
          <ActivityIndicator size="small" color={colors.mutedForeground} />
          <Text style={styles.muted}>Loading models…</Text>
        </View>
      </View>
    );
  }

  if (matches.length === 0) {
    return (
      <View style={styles.card}>
        <Text style={[styles.muted, styles.emptyText]}>
          {failed
            ? "Couldn’t load connected models."
            : query === ""
              ? "No connected models available. Manage models in Connections."
              : `No models match “@${query}”.`}
        </Text>
      </View>
    );
  }

  return (
    <View style={styles.card}>
      <FlatList
        data={matches}
        keyExtractor={(item) => item.id}
        keyboardShouldPersistTaps="always"
        style={styles.list}
        renderItem={({ item, index }) => {
          const mention = modelMentionOf(item);
          const selected = index === activeIndex;
          return (
            <Pressable
              style={({ pressed }) => [styles.item, (pressed || selected) && styles.itemPressed]}
              onPress={() => onSelect(item)}
              accessibilityRole="button"
              accessibilityLabel={`${mention.name}, ${mention.harnessName}, ${mention.slug}`}
              accessibilityState={{ selected }}
            >
              <View style={styles.nameRow}>
                <HarnessLogo harness={mention.harness} />
                <View style={styles.nameBlock}>
                  <Text style={styles.name} numberOfLines={1}>
                    {mention.name}
                  </Text>
                  <Text style={styles.slug} numberOfLines={1}>
                    {mention.slug}
                  </Text>
                </View>
              </View>
            </Pressable>
          );
        }}
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
  nameRow: { flexDirection: "row", alignItems: "center", gap: spacing.sm },
  nameBlock: { flex: 1, minWidth: 0 },
  name: { color: colors.foreground, fontSize: 14, fontWeight: "600" },
  slug: { color: colors.mutedForeground, fontSize: 12, marginTop: 1 },
});
