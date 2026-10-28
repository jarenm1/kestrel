import React, { useMemo } from "react";
import { FlatList, Pressable, StyleSheet, Text, View } from "react-native";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { Task } from "@cloudagents/protocol";
import { createQueries, storeTask } from "@/api/queries";
import { ScreenHeader } from "@/components/ScreenHeader";
import { useApiClient } from "@/hooks/useApiClient";
import { errorText, formatAgo } from "@/lib/format";
import { useNavigation } from "@/nav/navigation";
import { colors, radius, spacing } from "@/theme";

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

  return (
    <View style={styles.flex}>
      <ScreenHeader title="Archived" onBack={nav.back} />
      {tasks.error ? <Text style={styles.error}>{errorText(tasks.error)}</Text> : null}
      <FlatList
        style={styles.flex}
        contentContainerStyle={styles.list}
        data={archived}
        keyExtractor={(t) => t.id}
        renderItem={({ item }) => (
          <ArchivedRow
            task={item}
            now={Date.now()}
            unarchiving={unarchive.isPending && unarchive.variables === item.id}
            onOpen={() => nav.push({ name: "thread", taskId: item.id })}
            onUnarchive={() => unarchive.mutate(item.id)}
          />
        )}
        ListEmptyComponent={
          tasks.isPending ? undefined : <Text style={styles.note}>No archived threads.</Text>
        }
      />
    </View>
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
  return (
    <Pressable style={styles.row} onPress={onOpen}>
      <View style={styles.rowText}>
        <Text style={styles.title} numberOfLines={1}>
          {task.title || "Untitled thread"}
        </Text>
        <Text style={styles.age}>Archived {formatAgo(task.archivedAt ?? task.updatedAt, now)}</Text>
      </View>
      <Pressable style={styles.button} onPress={onUnarchive} disabled={unarchiving}>
        <Text style={styles.buttonText}>{unarchiving ? "…" : "Unarchive"}</Text>
      </Pressable>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  list: { padding: spacing.md, gap: spacing.sm },
  row: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.sm,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.xl,
    backgroundColor: colors.card,
    padding: spacing.md,
  },
  rowText: { flex: 1, gap: spacing.xs },
  title: { color: colors.foreground, fontSize: 15, fontWeight: "600" },
  age: { color: colors.mutedForeground, fontSize: 12 },
  button: {
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.lg,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.xs,
  },
  buttonText: { color: colors.foreground, fontSize: 13 },
  note: { color: colors.mutedForeground, textAlign: "center", marginTop: spacing.xl },
  error: { color: colors.destructive, paddingHorizontal: spacing.md },
});
