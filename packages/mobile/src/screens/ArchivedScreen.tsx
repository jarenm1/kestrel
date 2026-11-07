import React from "react";
import { FlatList, Pressable, StyleSheet, Text, View } from "react-native";
import { useQueries } from "@tanstack/react-query";
import type { Task } from "@cloudagents/protocol";
import { isUnreachableError } from "@/api/errors";
import { createQueries } from "@/api/queries";
import { ThreadAvatar } from "@/components/ThreadAvatar";
import { Alert } from "@/components/ui/Alert";
import { Button } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import { type BoxSource, useBoxSources } from "@/hooks/useBoxSources";
import { useThreadArchive } from "@/hooks/useThreadArchive";
import { errorText, formatAgo, repoShortName } from "@/lib/format";
import { useNavigation } from "@/nav/navigation";
import { colors, spacing } from "@/theme";

type ArchivedEntry = { task: Task; source: BoxSource };

/**
 * The archived threads of every box the sidebar lists, most recently archived first. Opening one shows it on the box it
 * lives on; Unarchive brings it back there.
 */
export function ArchivedScreen() {
  const sources = useBoxSources();
  const tasksByBox = useQueries({ queries: sources.map((source) => createQueries(source.api).tasks()) });
  const nav = useNavigation();
  const { unarchive } = useThreadArchive();
  const now = Date.now();

  const archived: ArchivedEntry[] = sources
    .flatMap((source, i) => (tasksByBox[i].data ?? []).map((task) => ({ task, source })))
    .filter(({ task }) => task.archivedAt !== undefined)
    .sort((a, b) => (b.task.archivedAt ?? "").localeCompare(a.task.archivedAt ?? ""));
  const allLoaded = tasksByBox.every((query) => query.isSuccess);

  return (
    <FlatList
      style={styles.flex}
      contentContainerStyle={styles.content}
      data={archived}
      keyExtractor={({ task, source }) => `${source.api.boxScope}:${task.id}`}
      ListHeaderComponent={
        <View style={styles.header}>
          <View style={styles.heading}>
            <Text style={styles.title}>Archived threads</Text>
            <Text style={styles.description}>
              Archived threads keep their history and checkouts. Unarchive one to continue it.
            </Text>
          </View>
          {sources.map((source, i) => {
            const query = tasksByBox[i];
            if (query.error) {
              // A box that is merely unreachable is already shown by its indicator; only a real refusal is worth a row.
              return isUnreachableError(query.error) ? null : (
                <Alert key={source.api.boxScope}>{`${source.label}: ${errorText(query.error)}`}</Alert>
              );
            }
            if (query.isPending) {
              return (
                <Text key={source.api.boxScope} style={styles.loading}>
                  Loading {source.label}…
                </Text>
              );
            }
            return null;
          })}
          {unarchive.error ? <Alert>{errorText(unarchive.error)}</Alert> : null}
        </View>
      }
      renderItem={({ item: { task, source } }) => (
        <ArchivedRow
          task={task}
          label={source.label}
          now={now}
          unarchiving={
            unarchive.isPending &&
            unarchive.variables?.taskId === task.id &&
            unarchive.variables.api.boxScope === source.api.boxScope
          }
          onOpen={() => nav.push({ name: "thread", taskId: task.id, box: source.box })}
          onUnarchive={() => unarchive.mutate({ api: source.api, taskId: task.id })}
        />
      )}
      ListEmptyComponent={
        allLoaded ? (
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
  label: string;
  now: number;
  unarchiving: boolean;
  onOpen: () => void;
  onUnarchive: () => void;
}

function ArchivedRow({ task, label, now, unarchiving, onOpen, onUnarchive }: ArchivedRowProps) {
  const repos =
    task.checkouts.length > 0 ? task.checkouts.map((checkout) => repoShortName(checkout.repo)).join(", ") : "No repository";
  return (
    <Card>
      <View style={styles.row}>
        <ThreadAvatar task={task} />
        <View style={styles.rowText}>
          <Pressable onPress={onOpen} accessibilityRole="button" hitSlop={8} style={styles.titlePress}>
            <Text style={styles.threadTitle} numberOfLines={1}>
              {task.title || "Untitled thread"}
            </Text>
          </Pressable>
          <Text style={styles.meta} numberOfLines={1}>
            {repos} · {label}
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
  loading: { color: colors.mutedForeground, fontSize: 14 },
  row: { flexDirection: "row", alignItems: "center", gap: spacing.lg },
  rowText: { flex: 1, minWidth: 0, gap: 2 },
  titlePress: { paddingVertical: spacing.xs },
  threadTitle: { color: colors.foreground, fontSize: 15, fontWeight: "500" },
  meta: { color: colors.mutedForeground, fontSize: 12 },
  empty: { alignItems: "center", paddingVertical: 40 },
  emptyText: { color: colors.foreground, fontSize: 14, fontWeight: "500" },
});
