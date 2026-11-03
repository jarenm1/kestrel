import React, { useState } from "react";
import { FlatList, Image, Modal, Pressable, StyleSheet, Text, View } from "react-native";
import { useQueries } from "@tanstack/react-query";
import {
  Archive,
  ChevronsUpDown,
  GitBranch,
  GitPullRequest,
  LogOut,
  type LucideIcon,
  Plug,
  Settings,
  SquarePen,
  Workflow,
} from "lucide-react-native";
import type { Task } from "@cloudagents/protocol";
import { sameBox } from "@/api/client";
import { createQueries } from "@/api/queries";
import { useAuth } from "@/auth/AuthContext";
import { KestrelMark } from "@/components/KestrelMark";
import { ThreadAvatar } from "@/components/ThreadAvatar";
import { Alert } from "@/components/ui/Alert";
import { Button } from "@/components/ui/Button";
import { StatusIcon } from "@/components/ui/StatusIcon";
import { LiveText } from "@/components/ui/LiveText";
import { type BoxSource, useBoxSources } from "@/hooks/useBoxSources";
import { useThreadArchive } from "@/hooks/useThreadArchive";
import { errorText, formatAgo, repoShortName } from "@/lib/format";
import { type Route, useNavigation } from "@/nav/navigation";
import { colors, radius, shadows, spacing } from "@/theme";

const STATUS_LABEL: Record<Task["status"], string> = {
  idle: "Idle",
  running: "Working",
  needs_input: "Needs input",
  done: "Done",
  failed: "Failed",
};

function NavRow({ icon: Icon, label, route, active }: { icon: LucideIcon; label: string; route: Route; active: boolean }) {
  const nav = useNavigation();
  return (
    <Pressable
      onPress={() => nav.navigate(route)}
      accessibilityRole="button"
      accessibilityState={{ selected: active }}
      style={({ pressed }) => [styles.row, (pressed || active) && styles.rowActive]}
    >
      <Icon size={22} color={colors.foreground} strokeWidth={1.75} />
      <Text style={styles.navText}>{label}</Text>
    </Pressable>
  );
}

/**
 * The web's expanded thread row: the first checkout's repository (and how many more) with the time, the title (fading
 * while the agent works), and that checkout's branch or pull request with the status. Without a checkout the last
 * line names the status instead.
 */
function ThreadRow({
  task,
  source,
  active,
  archiving,
  onArchive,
  now,
}: {
  task: Task;
  source: BoxSource;
  active: boolean;
  archiving: boolean;
  onArchive: () => void;
  now: number;
}) {
  const nav = useNavigation();
  const [checkout, ...otherCheckouts] = task.checkouts;
  const checkoutsLabel = task.checkouts.map((c) => `${c.repo}, ${c.branch}`).join("; ");
  return (
    <Pressable
      onPress={() => nav.navigate({ name: "thread", taskId: task.id, box: source.box })}
      accessibilityRole="button"
      accessibilityLabel={[task.title || "Untitled thread", STATUS_LABEL[task.status], checkoutsLabel]
        .filter(Boolean)
        .join(" — ")}
      accessibilityState={{ selected: active }}
      style={({ pressed }) => [styles.threadRow, (pressed || active) && styles.rowActive]}
    >
      <View style={styles.threadInfo}>
        <View style={styles.threadLine}>
          <ThreadAvatar task={task} small />
          <Text style={styles.threadMeta} numberOfLines={1}>
            {checkout ? repoShortName(checkout.repo) : null}
            {otherCheckouts.length > 0 ? ` +${otherCheckouts.length}` : null}
          </Text>
          {/* The open thread's archive button covers the time; it keeps its space so the line does not reflow. */}
          <Text style={[styles.threadTime, active && styles.hidden]}>{formatAgo(task.updatedAt, now)}</Text>
        </View>
        <LiveText live={task.status === "running"} style={[styles.threadTitle, active && styles.threadTitleActive]}>
          {task.title || "Untitled thread"}
        </LiveText>
        <View style={styles.threadLine}>
          {checkout ? (
            <>
              {checkout.pullRequest ? (
                <GitPullRequest size={14} color={colors.mutedForeground} />
              ) : (
                <GitBranch size={14} color={colors.mutedForeground} />
              )}
              <Text style={styles.threadMeta} numberOfLines={1}>
                {checkout.branch}
                {checkout.pullRequest ? ` #${checkout.pullRequest.number}` : null}
              </Text>
            </>
          ) : (
            <Text style={styles.threadMeta} numberOfLines={1}>
              {STATUS_LABEL[task.status]}
            </Text>
          )}
          <StatusIcon status={task.status} size={14} />
        </View>
      </View>
      {/* The open thread's archive button floats over the time's corner, as on the web, so the row keeps its width. */}
      {active ? (
        <Button
          variant="ghost"
          size="icon"
          icon={Archive}
          accessibilityLabel="Archive thread"
          disabled={archiving}
          onPress={onArchive}
          style={styles.archive}
        />
      ) : null}
    </Pressable>
  );
}

/** Account and connections, behind the settings button at the foot of the sidebar. */
function SettingsSheet({ open, onClose }: { open: boolean; onClose: () => void }) {
  const nav = useNavigation();
  const { user, signOut } = useAuth();
  return (
    <Modal visible={open} transparent animationType="fade" onRequestClose={onClose}>
      <Pressable style={styles.backdrop} onPress={onClose}>
        <View style={styles.sheet}>
          {user ? (
            <View style={styles.account}>
              <View style={styles.avatar}>
                {user.avatarUrl ? (
                  <Image source={{ uri: user.avatarUrl }} style={styles.avatarImage} />
                ) : (
                  <Text style={styles.avatarLetter}>{user.login.slice(0, 1)}</Text>
                )}
              </View>
              <Text style={styles.signedIn} numberOfLines={1}>
                Signed in as <Text style={styles.login}>{user.login}</Text>
              </Text>
            </View>
          ) : null}
          <Pressable
            style={({ pressed }) => [styles.row, pressed && styles.rowActive]}
            onPress={() => {
              onClose();
              nav.navigate({ name: "settings" });
            }}
          >
            <Settings size={22} color={colors.foreground} strokeWidth={1.75} />
            <Text style={styles.navText}>Settings</Text>
          </Pressable>
          <Pressable
            style={({ pressed }) => [styles.row, pressed && styles.rowActive]}
            onPress={() => {
              onClose();
              nav.navigate({ name: "connections" });
            }}
          >
            <Plug size={22} color={colors.foreground} strokeWidth={1.75} />
            <Text style={styles.navText}>Connections</Text>
          </Pressable>
          <Pressable
            style={({ pressed }) => [styles.row, pressed && styles.rowActive]}
            onPress={() => {
              onClose();
              void signOut();
            }}
          >
            <LogOut size={22} color={colors.destructive} strokeWidth={1.75} />
            <Text style={[styles.navText, styles.danger]}>Sign out</Text>
          </Pressable>
        </View>
      </Pressable>
    </Modal>
  );
}

type ThreadEntry = { task: Task; source: BoxSource };

/**
 * The user's threads under the workspace pages, the left drawer: most recent first, working threads last. Threads come
 * from every box the user has; the thread view names its box, and a box that is still loading or failed says so.
 */
export function ThreadSidebar({ bottomInset }: { bottomInset: number }) {
  const { user } = useAuth();
  const sources = useBoxSources();
  const tasksByBox = useQueries({ queries: sources.map((source) => createQueries(source.api).tasks()) });
  const nav = useNavigation();
  const { archive } = useThreadArchive();
  const [settingsOpen, setSettingsOpen] = useState(false);
  const current = nav.current;
  const now = Date.now();

  // Working threads sit at the bottom, by the composer and the dock, each part newest first. Ordered by updatedAt,
  // which also moves when a run finishes; Task has no `lastMessageAt` to sort by yet.
  const byRecent: ThreadEntry[] = sources
    .flatMap((source, i) => (tasksByBox[i].data ?? []).map((task) => ({ task, source })))
    .sort(
      (a, b) =>
        Number(a.task.status === "running") - Number(b.task.status === "running") ||
        b.task.updatedAt.localeCompare(a.task.updatedAt)
    );
  const threads = byRecent.filter(({ task }) => task.archivedAt === undefined);
  const archivedCount = byRecent.length - threads.length;
  const allLoaded = tasksByBox.every((query) => query.isSuccess);

  function archiveThread({ task, source }: ThreadEntry) {
    archive.mutate({ api: source.api, taskId: task.id }, {
      // The open thread leaves the list; go back to the empty chat.
      onSuccess: () => {
        if (current.name === "thread" && current.taskId === task.id && sameBox(current.box, source.box)) {
          nav.navigate({ name: "new-thread" });
        }
      },
    });
  }

  const header = (
    <View style={styles.header}>
      <View style={styles.brand}>
        <KestrelMark height={22} />
        <Text style={styles.brandText}>Kestrel</Text>
      </View>
      <NavRow icon={SquarePen} label="New thread" route={{ name: "new-thread" }} active={current.name === "new-thread"} />
      <NavRow icon={Workflow} label="Automations" route={{ name: "automations" }} active={current.name === "automations"} />
      <NavRow
        icon={Archive}
        label={archivedCount > 0 ? `Archived (${archivedCount})` : "Archived"}
        route={{ name: "archived" }}
        active={current.name === "archived"}
      />
      {threads.length > 0 ? <Text style={styles.section}>Threads</Text> : null}
      {sources.map((source, i) => {
        const query = tasksByBox[i];
        if (query.error) {
          return (
            <Alert key={source.api.boxScope} style={styles.alert}>
              {`${source.label}: ${errorText(query.error)}`}
            </Alert>
          );
        }
        if (query.isPending) {
          return (
            <Text key={source.api.boxScope} style={styles.empty}>
              Loading {source.label}…
            </Text>
          );
        }
        return null;
      })}
      {archive.error ? <Alert style={styles.alert}>{errorText(archive.error)}</Alert> : null}
      {threads.length === 0 && allLoaded ? <Text style={styles.empty}>No threads yet.</Text> : null}
    </View>
  );

  return (
    <View style={styles.root}>
      <FlatList
        data={threads}
        keyExtractor={({ task, source }) => `${source.api.boxScope}:${task.id}`}
        ListHeaderComponent={header}
        contentContainerStyle={[styles.list, { paddingBottom: bottomInset + 80 }]}
        renderItem={({ item: { task, source } }) => (
          <ThreadRow
            task={task}
            source={source}
            active={current.name === "thread" && current.taskId === task.id && sameBox(current.box, source.box)}
            archiving={
              archive.isPending &&
              archive.variables?.taskId === task.id &&
              archive.variables.api.boxScope === source.api.boxScope
            }
            onArchive={() => archiveThread({ task, source })}
            now={now}
          />
        )}
      />
      <View style={[styles.dock, { bottom: bottomInset + spacing.sm }]} pointerEvents="box-none">
        {user ? (
          <Pressable
            style={({ pressed }) => [styles.accountRow, pressed && styles.accountRowPressed]}
            onPress={() => setSettingsOpen(true)}
            accessibilityRole="button"
            accessibilityLabel="Account menu"
          >
            <View style={styles.avatar}>
              {user.avatarUrl ? (
                <Image source={{ uri: user.avatarUrl }} style={styles.avatarImage} />
              ) : (
                <Text style={styles.avatarLetter}>{user.login.slice(0, 1)}</Text>
              )}
            </View>
            <Text style={styles.accountName} numberOfLines={1}>
              {user.login}
            </Text>
            <ChevronsUpDown size={16} color={colors.mutedForeground} />
          </Pressable>
        ) : null}
      </View>
      <SettingsSheet open={settingsOpen} onClose={() => setSettingsOpen(false)} />
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  list: { paddingHorizontal: spacing.sm },
  header: { paddingBottom: spacing.xs },
  brand: { flexDirection: "row", alignItems: "center", gap: 10, paddingHorizontal: spacing.md, paddingVertical: spacing.lg },
  brandText: { color: colors.foreground, fontSize: 22, fontWeight: "600", letterSpacing: -0.4 },
  row: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    minHeight: 42,
    paddingHorizontal: spacing.md,
    borderRadius: radius.md,
    marginVertical: 1,
  },
  rowActive: { backgroundColor: colors.accent },
  navText: { color: colors.foreground, fontSize: 15, fontWeight: "500" },
  section: {
    color: colors.mutedForeground,
    fontSize: 12,
    fontWeight: "600",
    textTransform: "uppercase",
    letterSpacing: 0.5,
    paddingHorizontal: spacing.md,
    paddingTop: spacing.lg,
    paddingBottom: spacing.xs,
  },
  alert: { marginHorizontal: spacing.sm, marginBottom: spacing.sm },
  empty: { color: colors.mutedForeground, fontSize: 14, paddingHorizontal: spacing.md, paddingVertical: spacing.sm },
  threadRow: {
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    borderRadius: radius.md,
    marginVertical: 1,
  },
  threadInfo: { gap: spacing.xs },
  threadLine: { flexDirection: "row", alignItems: "center", gap: 6, minWidth: 0 },
  threadMeta: { flex: 1, color: colors.mutedForeground, fontSize: 12 },
  threadTime: { color: colors.mutedForeground, fontSize: 12, fontVariant: ["tabular-nums"] },
  hidden: { opacity: 0 },
  threadTitle: { color: colors.mutedForeground, fontSize: 14, fontWeight: "500" },
  threadTitleActive: { color: colors.foreground, fontWeight: "600" },
  archive: { position: "absolute", top: spacing.xs, right: spacing.xs, width: 28, height: 28 },
  dock: {
    position: "absolute",
    left: spacing.md,
    right: spacing.md,
  },
  accountRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    height: 48,
    paddingHorizontal: spacing.md,
    borderRadius: radius.lg,
    backgroundColor: colors.secondary,
    ...shadows.soft,
  },
  accountRowPressed: { backgroundColor: colors.accent },
  accountName: {
    flex: 1,
    color: colors.foreground,
    fontSize: 15,
    fontWeight: "500",
  },
  backdrop: { flex: 1, backgroundColor: colors.scrim, justifyContent: "flex-end" },
  sheet: {
    backgroundColor: colors.secondary,
    borderTopLeftRadius: radius.xxl,
    borderTopRightRadius: radius.xxl,
    padding: spacing.sm,
    paddingBottom: spacing.xxl,
    gap: 2,
  },
  account: { flexDirection: "row", alignItems: "center", gap: 12, padding: spacing.lg },
  avatar: {
    width: 32,
    height: 32,
    borderRadius: 16,
    overflow: "hidden",
    backgroundColor: colors.white08,
    alignItems: "center",
    justifyContent: "center",
  },
  avatarImage: { width: 32, height: 32 },
  avatarLetter: { color: colors.foreground, fontSize: 13, fontWeight: "500", textTransform: "uppercase" },
  signedIn: { flex: 1, color: colors.mutedForeground, fontSize: 15 },
  login: { color: colors.foreground },
  danger: { color: colors.destructive },
});
