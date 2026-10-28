import React, { useMemo } from "react";
import { FlatList, Pressable, StyleSheet, Text, View } from "react-native";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { Task } from "@cloudagents/protocol";
import { createQueries, storeTask } from "@/api/queries";
import { Alert } from "@/components/ui/Alert";
import { Button } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import { useApiClient } from "@/hooks/useApiClient";
import { errorText, formatAgo, repoShortName } from "@/lib/format";
import { useNavigation } from "@/nav/navigation";
import { colors, spacing } from "@/theme";

/** The user's archived threads, most recently archived first. Opening one shows it; Unarchive brings it back. */
export function ArchivedScreen() {
  const { api } = useApiClient();
  const nav = useNavigation();
  const queryClient = useQueryClient();
  const tasks = useQuery(createQueries(api).tasks());

  const archived = useMemo(
    () =>
      (tasks.data ?? [])
        .filter((t) => t.archivedAt !== undefined)
        .sort((a, b) => (b.archivedAt ?? "").localeCompare(a.archivedAt ?? "")),
    [tasks.data]
  );

  const unarchive = useMutation({
    mutationFn: (taskId: string) => api.unarchiveTask(taskId),
    onSuccess: (task) => storeTask(queryClient, task),
  });

  const now = Date.now();

  return (
    <FlatList
      style={styles.flex}
      contentContainerStyle={styles.content}
      data={archived}
      keyExtractor={(t) => t.id}
      ListHeaderComponent={
        <View style={styles.header}>
          <View style={styles.heading}>
            <Text style={styles.title}>Archived threads</Text>
            <Text style={styles.description}>
              Archived threads keep their history and checkouts. Unarchive one to continue it.
            </Text>
          </View>
          {tasks.error ? <Alert>{errorText(tasks.error)}</Alert> : null}
          {unarchive.error ? <Alert>{errorText(unarchive.error)}</Alert> : null}
        </View>
      }
      renderItem={({ item }) => (
        <ArchivedRow
          task={item}
          now={now}
          unarchiving={unarchive.isPending && unarchive.variables === item.id}
          onOpen={() => nav.push({ name: "thread", taskId: item.id })}
          onUnarchive={() => unarchive.mutate(item.id)}
        />
      )}
      ListEmptyComponent={
        tasks.isSuccess ? (
          <Card style={styles.empty}>
            <Text style={styles.emptyText}>No archived threads.</Text>
          </Card>
        ) : undefined
      }
    />
  );
}

interface ArchivedRowProps {
  task: Task;
  now: number;
  unarchiving: boolean;
  onOpen: () => void;
  onUnarchive: () => void;
}

function ArchivedRow({ task, now, unarchiving, onOpen, onUnarchive }: ArchivedRowProps) {
  const repos =
    task.checkouts.length > 0 ? task.checkouts.map((checkout) => repoShortName(checkout.repo)).join(", ") : "No repository";
  return (
    <Card>
      <View style={styles.row}>
        <View style={styles.rowText}>
          <Pressable onPress={onOpen} accessibilityRole="button" hitSlop={8} style={styles.titlePress}>
            <Text style={styles.threadTitle} numberOfLines={1}>
              {task.title || "Untitled thread"}
            </Text>
          </Pressable>
          <Text style={styles.meta} numberOfLines={1}>
            {repos}
            {task.archivedAt ? ` · archived ${formatAgo(task.archivedAt, now)}` : ""}
          </Text>
        </View>
        <Button variant="soft" size="sm" disabled={unarchiving} onPress={onUnarchive}>
          Unarchive
        </Button>
      </View>
    </Card>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  content: { padding: spacing.lg, gap: spacing.lg },
  header: { gap: spacing.lg },
  heading: { gap: spacing.xs },
  title: { color: colors.foreground, fontSize: 18, fontWeight: "600", letterSpacing: -0.2 },
  description: { color: colors.mutedForeground, fontSize: 14, lineHeight: 20 },
  row: { flexDirection: "row", alignItems: "center", gap: spacing.lg },
  rowText: { flex: 1, minWidth: 0, gap: 2 },
  titlePress: { paddingVertical: spacing.xs },
  threadTitle: { color: colors.foreground, fontSize: 15, fontWeight: "500" },
  meta: { color: colors.mutedForeground, fontSize: 12 },
  empty: { alignItems: "center", paddingVertical: 40 },
  emptyText: { color: colors.foreground, fontSize: 14, fontWeight: "500" },
});
