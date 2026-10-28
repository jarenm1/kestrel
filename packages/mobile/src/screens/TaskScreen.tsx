import React, { useEffect, useState } from "react";
import { Linking, Pressable, StyleSheet, Text, View } from "react-native";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { storeTask } from "@/api/queries";
import { ChatPanel } from "@/components/ChatPanel";
import { DesktopViewer } from "@/components/DesktopViewer";
import { DiffView } from "@/components/DiffView";
import { ScreenHeader } from "@/components/ScreenHeader";
import { useApiClient } from "@/hooks/useApiClient";
import { useTaskState } from "@/hooks/useTaskState";
import { useNavigation } from "@/nav/navigation";
import { colors, radius, spacing } from "@/theme";

type TabId = "chat" | "desktop" | "diff";

const TABS: readonly { readonly id: TabId; readonly label: string }[] = [
  { id: "chat", label: "Chat" },
  { id: "desktop", label: "Desktop" },
  { id: "diff", label: "Diff" },
];

interface Props {
  taskId: string;
}

export function TaskScreen({ taskId }: Props) {
  const { api } = useApiClient();
  const nav = useNavigation();
  const queryClient = useQueryClient();
  const state = useTaskState(taskId);
  const [tab, setTab] = useState<TabId>("chat");
  const { desktopOpens } = state;

  // Opening a desktop from elsewhere (a run asks for one) switches to the Desktop tab.
  useEffect(() => {
    if (desktopOpens > 0) setTab("desktop");
  }, [desktopOpens]);

  const task = state.task;
  const archived = task?.archivedAt !== undefined;

  const archive = useMutation({
    mutationFn: () => api.archiveTask(taskId),
    onSuccess: (updated) => storeTask(queryClient, updated),
  });
  const unarchive = useMutation({
    mutationFn: () => api.unarchiveTask(taskId),
    onSuccess: (updated) => storeTask(queryClient, updated),
  });

  const pullRequests = (task?.checkouts ?? []).flatMap((c) =>
    c.pullRequest ? [{ id: c.id, repo: c.repo, number: c.pullRequest.number, url: c.pullRequest.url }] : []
  );

  const archiveToggle = archived ? (
    <Pressable style={styles.headerBtn} onPress={() => unarchive.mutate()} disabled={unarchive.isPending}>
      <Text style={styles.headerBtnText}>{unarchive.isPending ? "…" : "Unarchive"}</Text>
    </Pressable>
  ) : (
    <Pressable style={styles.headerBtn} onPress={() => archive.mutate()} disabled={archive.isPending}>
      <Text style={styles.headerBtnText}>{archive.isPending ? "…" : "Archive"}</Text>
    </Pressable>
  );

  return (
    <View style={styles.flex}>
      <ScreenHeader title={task?.title || "Thread"} onBack={nav.back} right={archiveToggle} />
      {pullRequests.length > 0 ? (
        <View style={styles.prRow}>
          {pullRequests.map((pr) => (
            <Pressable key={pr.id} style={styles.pr} onPress={() => void Linking.openURL(pr.url)}>
              <Text style={styles.prText} numberOfLines={1}>
                {pr.repo} #{pr.number}
              </Text>
            </Pressable>
          ))}
        </View>
      ) : null}
      <View style={styles.tabs}>
        {TABS.map((t) => (
          <Pressable
            key={t.id}
            style={[styles.tab, tab === t.id && styles.tabActive]}
            onPress={() => setTab(t.id)}
            accessibilityRole="tab"
            accessibilityState={{ selected: tab === t.id }}
          >
            <Text style={[styles.tabText, tab === t.id && styles.tabTextActive]}>{t.label}</Text>
          </Pressable>
        ))}
      </View>
      {state.error ? <Text style={styles.error}>{state.error}</Text> : null}
      {tab === "chat" ? (
        <ChatPanel
          taskId={taskId}
          taskStatus={task?.status}
          messages={state.messages}
          runs={state.runs}
          output={state.output}
          archived={archived}
          onUnarchive={() => unarchive.mutate()}
          unarchiving={unarchive.isPending}
        />
      ) : null}
      {tab === "desktop" ? (
        archived ? (
          <Text style={styles.note}>Desktops are off while a thread is archived. Unarchive it to open one.</Text>
        ) : (
          <DesktopViewer taskId={taskId} />
        )
      ) : null}
      {tab === "diff" ? <DiffView taskId={taskId} running={task?.status === "running"} /> : null}
    </View>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  headerBtn: {
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.lg,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.xs,
  },
  headerBtnText: { color: colors.foreground, fontSize: 13 },
  prRow: { flexDirection: "row", flexWrap: "wrap", gap: spacing.sm, paddingHorizontal: spacing.md },
  pr: {
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.lg,
    paddingHorizontal: spacing.sm,
    paddingVertical: spacing.xs,
  },
  prText: { color: colors.primary, fontSize: 12 },
  tabs: {
    flexDirection: "row",
    margin: spacing.md,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.lg,
    overflow: "hidden",
  },
  tab: { flex: 1, alignItems: "center", paddingVertical: spacing.sm },
  tabActive: { backgroundColor: colors.accent },
  tabText: { color: colors.mutedForeground, fontSize: 14 },
  tabTextActive: { color: colors.foreground, fontWeight: "700" },
  error: { color: colors.destructive, paddingHorizontal: spacing.md },
  note: { color: colors.mutedForeground, padding: spacing.lg, textAlign: "center" },
});
