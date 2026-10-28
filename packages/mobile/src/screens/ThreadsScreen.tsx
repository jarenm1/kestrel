import React, { useMemo } from "react";
import { FlatList, Pressable, StyleSheet, Text, View } from "react-native";
import { useQuery } from "@tanstack/react-query";
import type { Task } from "@cloudagents/protocol";
import { createQueries } from "@/api/queries";
import { BoxPill } from "@/components/BoxStatus";
import { StatusBadge } from "@/components/StatusBadge";
import { useAuth } from "@/auth/AuthContext";
import { useApiClient } from "@/hooks/useApiClient";
import { formatAgo, repoShortName, errorText } from "@/lib/format";
import { type Route, useNavigation } from "@/nav/navigation";
import { colors, radius, spacing } from "@/theme";

const MENU: readonly { readonly label: string; readonly route: Route }[] = [
  { label: "Automations", route: { name: "automations" } },
  { label: "Archived", route: { name: "archived" } },
  { label: "Connections", route: { name: "connections" } },
];

export function ThreadsScreen() {
  const { api } = useApiClient();
  const nav = useNavigation();
  const { signOut } = useAuth();
  const tasks = useQuery(createQueries(api).tasks());

  const threads = useMemo(
    () =>
      (tasks.data ?? [])
        .filter((t) => t.archivedAt === undefined)
        .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)),
    [tasks.data]
  );

  return (
    <View style={styles.flex}>
      <View style={styles.bar}>
        <Text style={styles.brand}>Kestrel</Text>
        <View style={styles.barRight}>
          <BoxPill />
          <Pressable
            style={styles.newBtn}
            onPress={() => nav.push({ name: "new-thread" })}
            accessibilityRole="button"
            accessibilityLabel="New thread"
          >
            <Text style={styles.newBtnText}>+ New</Text>
          </Pressable>
        </View>
      </View>
      <View style={styles.menu}>
        {MENU.map((item) => (
          <Pressable key={item.label} style={styles.menuItem} onPress={() => nav.push(item.route)}>
            <Text style={styles.menuText}>{item.label}</Text>
          </Pressable>
        ))}
        <Pressable style={styles.menuItem} onPress={signOut}>
          <Text style={styles.menuText}>Exit</Text>
        </Pressable>
      </View>
      {tasks.isPending ? <Text style={styles.note}>Loading threads…</Text> : null}
      {tasks.error ? <Text style={styles.error}>{errorText(tasks.error)}</Text> : null}
      <FlatList
        style={styles.flex}
        contentContainerStyle={styles.list}
        data={threads}
        keyExtractor={(t) => t.id}
        renderItem={({ item }) => (
          <ThreadRow task={item} now={Date.now()} onPress={() => nav.push({ name: "thread", taskId: item.id })} />
        )}
        ListEmptyComponent={
          tasks.isPending ? undefined : <Text style={styles.note}>No threads yet. Start one with + New.</Text>
        }
      />
    </View>
  );
}

function ThreadRow({ task, now, onPress }: { task: Task; now: number; onPress: () => void }) {
  return (
    <Pressable style={styles.row} onPress={onPress}>
      <View style={styles.rowTop}>
        <Text style={styles.rowTitle} numberOfLines={1}>
          {task.title || "Untitled thread"}
        </Text>
        <StatusBadge status={task.status} />
      </View>
      <View style={styles.rowMeta}>
        <Text style={styles.age}>{formatAgo(task.updatedAt, now)}</Text>
        {task.checkouts.map((c) => (
          <View key={c.id} style={styles.chip}>
            <Text style={styles.chipText} numberOfLines={1}>
              {repoShortName(c.repo)} · {c.branch}
            </Text>
          </View>
        ))}
      </View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  bar: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
  },
  brand: { color: colors.foreground, fontSize: 18, fontWeight: "700" },
  barRight: { flexDirection: "row", alignItems: "center", gap: spacing.sm },
  newBtn: { backgroundColor: colors.primary, borderRadius: radius.lg, paddingHorizontal: spacing.md, paddingVertical: spacing.xs },
  newBtnText: { color: colors.primaryForeground, fontWeight: "700" },
  menu: { flexDirection: "row", flexWrap: "wrap", gap: spacing.sm, paddingHorizontal: spacing.md, paddingBottom: spacing.sm },
  menuItem: {
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.lg,
    paddingHorizontal: spacing.sm,
    paddingVertical: spacing.xs,
  },
  menuText: { color: colors.mutedForeground, fontSize: 13 },
  list: { padding: spacing.md, gap: spacing.sm },
  row: {
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.xl,
    backgroundColor: colors.card,
    padding: spacing.md,
    gap: spacing.sm,
  },
  rowTop: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: spacing.sm },
  rowTitle: { color: colors.foreground, fontSize: 15, fontWeight: "600", flex: 1 },
  rowMeta: { flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: spacing.xs },
  age: { color: colors.mutedForeground, fontSize: 12, marginRight: spacing.xs },
  chip: { backgroundColor: colors.secondary, borderRadius: radius.sm, paddingHorizontal: spacing.sm, paddingVertical: 2 },
  chipText: { color: colors.mutedForeground, fontSize: 12 },
  note: { color: colors.mutedForeground, textAlign: "center", marginTop: spacing.xl },
  error: { color: colors.destructive, paddingHorizontal: spacing.md },
});
