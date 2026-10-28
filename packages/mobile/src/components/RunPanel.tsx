import React from "react";
import { View, Text, StyleSheet, FlatList, Pressable } from "react-native";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import type { Run } from "@/api/types";
import { useApiClient } from "@/hooks/useApiClient";
import { keys, upsert } from "@/api/queries";
import { StatusBadge } from "./StatusBadge";
import { colors, radius, spacing } from "@/theme";

interface Props {
  taskId: string;
  runs: readonly Run[];
  output: Record<string, string[]>;
}

function formatTime(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

export function RunPanel({ taskId, runs, output }: Props) {
  const { api } = useApiClient();
  const queryClient = useQueryClient();
  const current = runs.length > 0 ? runs[runs.length - 1] : null;
  const lines = current ? (output[current.id] ?? []) : [];

  const cancel = useMutation({
    mutationFn: (runId: string) => api.cancelRun(runId),
    onSuccess: (run) =>
      queryClient.setQueryData(
        keys.runs(taskId),
        (list: Run[] | undefined) => upsert(list, run)
      ),
  });

  if (runs.length === 0) return null;

  return (
    <View style={styles.container}>
      {current && current.status === "running" && lines.length > 0 && (
        <View style={styles.logBox}>
          <Text style={styles.logLabel}>Live log</Text>
          <Text style={styles.logText} numberOfLines={8}>
            {lines.slice(-8).join("\n")}
          </Text>
        </View>
      )}
      {[...runs].reverse().map((run) => (
        <View key={run.id} style={styles.runRow}>
          <StatusBadge status={run.status} />
          <Text style={styles.prompt} numberOfLines={1}>
            {run.prompt}
          </Text>
          <Text style={styles.time}>{formatTime(run.startedAt)}</Text>
          {run.exitCode !== null && (
            <Text style={styles.exitCode}>exit {run.exitCode}</Text>
          )}
          {run.status === "running" && (
            <Pressable
              style={styles.cancelBtn}
              onPress={() => cancel.mutate(run.id)}
              disabled={cancel.isPending}
            >
              <Text style={styles.cancelText}>Cancel</Text>
            </Pressable>
          )}
        </View>
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    borderTopWidth: 1,
    borderTopColor: colors.border,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.sm,
  },
  logBox: {
    backgroundColor: colors.code,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.border,
    padding: spacing.sm,
    marginBottom: spacing.sm,
  },
  logLabel: {
    color: colors.mutedForeground,
    fontSize: 11,
    marginBottom: 4,
  },
  logText: {
    color: colors.foreground,
    fontSize: 11,
    fontFamily: "monospace",
  },
  runRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.sm,
    paddingVertical: 4,
  },
  prompt: {
    flex: 1,
    color: colors.foreground,
    fontSize: 13,
  },
  time: {
    color: colors.mutedForeground,
    fontSize: 11,
  },
  exitCode: {
    color: colors.mutedForeground,
    fontSize: 11,
    fontFamily: "monospace",
  },
  cancelBtn: {
    paddingHorizontal: spacing.sm,
    paddingVertical: 2,
    borderRadius: radius.sm,
    borderWidth: 1,
    borderColor: colors.border,
  },
  cancelText: {
    color: colors.foreground,
    fontSize: 11,
  },
});

