import React, { useMemo, useState } from "react";
import {
  View,
  Text,
  TextInput,
  StyleSheet,
  FlatList,
  Pressable,
  ActivityIndicator,
  RefreshControl,
} from "react-native";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useApiClient } from "@/hooks/useApiClient";
import { createQueries, keys } from "@/api/queries";
import { BoxOfflineBanner, useBoxOffline } from "@/components/BoxStatus";
import { StatusBadge } from "@/components/StatusBadge";
import { colors, radius, spacing } from "@/theme";
import type { Task } from "@/api/types";

interface Props {
  repoId: string;
  onSelectTask: (taskId: string) => void;
  onBack: () => void;
}

export function RepoScreen({ repoId, onSelectTask, onBack }: Props) {
  const { api } = useApiClient();
  const queryClient = useQueryClient();
  const queries = useMemo(() => createQueries(api), [api]);
  const offline = useBoxOffline();

  const repo = useQuery(queries.repo(repoId));
  const tasks = useQuery(queries.repoTasks(repoId));
  const [title, setTitle] = useState("");

  const createTask = useMutation({
    mutationFn: (t: string) => api.createTask(repoId, { title: t || undefined }),
    onSuccess: (task) => {
      void queryClient.invalidateQueries({ queryKey: keys.repoTasks(repoId) });
      setTitle("");
      onSelectTask(task.id);
    },
  });

  return (
    <View style={styles.container}>
      <BoxOfflineBanner />
      <View style={styles.header}>
        <Pressable onPress={onBack} style={styles.backBtn}>
          <Text style={styles.backText}>← Back</Text>
        </Pressable>
        <Text style={styles.repoName} numberOfLines={1}>
          {repo.data?.name ?? "Loading…"}
        </Text>
      </View>

      {/* New task input */}
      <View style={styles.newTaskRow}>
        <TextInput
          style={styles.input}
          value={title}
          onChangeText={setTitle}
          placeholder="New task title (optional)"
          placeholderTextColor={colors.mutedForeground}
          returnKeyType="done"
        />
        <Pressable
          style={[styles.createBtn, (offline || createTask.isPending) && styles.btnDisabled]}
          onPress={() => createTask.mutate(title.trim())}
          disabled={offline || createTask.isPending}
        >
          <Text style={styles.createBtnText}>
            {createTask.isPending ? "…" : "New task"}
          </Text>
        </Pressable>
      </View>

      {createTask.error && (
        <View style={styles.errorBar}>
          <Text style={styles.errorText}>
            {createTask.error instanceof Error ? createTask.error.message : String(createTask.error)}
          </Text>
        </View>
      )}

      <FlatList
        data={tasks.data ?? []}
        keyExtractor={(item) => item.id}
        contentContainerStyle={styles.list}
        refreshControl={
          <RefreshControl
            refreshing={tasks.isFetching}
            onRefresh={() => {
              void tasks.refetch();
            }}
            tintColor={colors.primary}
          />
        }
        ListEmptyComponent={
          tasks.isPending ? (
            <ActivityIndicator style={styles.loader} color={colors.primary} />
          ) : (
            <Text style={styles.emptyText}>No tasks yet. Create one above.</Text>
          )
        }
        renderItem={({ item }) => (
          <Pressable
            style={styles.taskCard}
            onPress={() => onSelectTask(item.id)}
          >
            <View style={styles.taskHeader}>
              <Text style={styles.taskTitle} numberOfLines={1}>
                {item.title || "Untitled task"}
              </Text>
              <StatusBadge status={item.status} />
            </View>
            <Text style={styles.taskBranch} numberOfLines={1}>
              {item.branch}
            </Text>
          </Pressable>
        )}
      />
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
  repoName: {
    color: colors.foreground,
    fontSize: 16,
    fontWeight: "600",
    flex: 1,
  },
  newTaskRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.sm,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.md,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
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
    fontSize: 14,
  },
  createBtn: {
    backgroundColor: colors.primary,
    borderRadius: radius.md,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.sm + 2,
  },
  btnDisabled: {
    opacity: 0.5,
  },
  createBtnText: {
    color: colors.primaryForeground,
    fontSize: 13,
    fontWeight: "600",
  },
  errorBar: {
    backgroundColor: colors.destructive + "18",
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.sm,
  },
  errorText: {
    color: colors.destructive,
    fontSize: 12,
  },
  list: {
    padding: spacing.lg,
    gap: spacing.sm,
  },
  loader: {
    marginTop: 40,
  },
  emptyText: {
    color: colors.mutedForeground,
    textAlign: "center",
    marginTop: 40,
    fontSize: 14,
  },
  taskCard: {
    backgroundColor: colors.card,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: colors.border,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.md,
    gap: 4,
  },
  taskHeader: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.sm,
  },
  taskTitle: {
    flex: 1,
    color: colors.foreground,
    fontSize: 14,
    fontWeight: "600",
  },
  taskBranch: {
    color: colors.mutedForeground,
    fontSize: 11,
    fontFamily: "monospace",
  },
});

