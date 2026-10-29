import React, { useMemo, useState } from "react";
import { FlatList, Image, Modal, Pressable, StyleSheet, Text, View } from "react-native";
import { useQuery } from "@tanstack/react-query";
import { Archive, ChevronsUpDown, LogOut, type LucideIcon, Plug, Settings, SquarePen, Workflow } from "lucide-react-native";
import type { Task } from "@cloudagents/protocol";
import { createQueries } from "@/api/queries";
import { useAuth } from "@/auth/AuthContext";
import { KestrelMark } from "@/components/KestrelMark";
import { Alert } from "@/components/ui/Alert";
import { Button } from "@/components/ui/Button";
import { StatusIcon } from "@/components/ui/StatusIcon";
import { useApiClient } from "@/hooks/useApiClient";
import { useThreadArchive } from "@/hooks/useThreadArchive";
import { errorText, formatAgo, repoShortName } from "@/lib/format";
import { type Route, useNavigation } from "@/nav/navigation";
import { colors, fonts, radius, shadows, spacing } from "@/theme";

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

function ThreadRow({
  task,
  active,
  archiving,
  onArchive,
  now,
}: {
  task: Task;
  active: boolean;
  archiving: boolean;
  onArchive: () => void;
  now: number;
}) {
  const nav = useNavigation();
  const checkouts = task.checkouts ?? [];
  return (
    <Pressable
      onPress={() => nav.navigate({ name: "thread", taskId: task.id })}
      accessibilityRole="button"
      accessibilityLabel={task.title}
      accessibilityState={{ selected: active }}
      style={({ pressed }) => [styles.threadRow, (pressed || active) && styles.rowActive]}
    >
      <View style={styles.statusWrap}>
        <StatusIcon status={task.status} size={15} />
      </View>
      <View style={styles.threadInfo}>
        <Text style={[styles.threadTitle, active && styles.threadTitleActive]} numberOfLines={1}>
          {task.title || "Untitled thread"}
        </Text>
        <Text style={styles.threadMeta} numberOfLines={1}>
          {STATUS_LABEL[task.status]} · {formatAgo(task.updatedAt, now)}
        </Text>
        {checkouts.length > 0 ? (
          <View style={styles.chipRow}>
            {checkouts.map((checkout) => (
              <View key={checkout.id} style={styles.repoChip}>
                <Text style={styles.repoChipText} numberOfLines={1}>
                  {repoShortName(checkout.repo)}
                  {checkout.pullRequest ? ` #${checkout.pullRequest.number}` : null}
                </Text>
              </View>
            ))}
          </View>
        ) : null}
      </View>
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

/** The user's threads, most recent first, under the workspace pages: the left drawer. */
export function ThreadSidebar({ bottomInset }: { bottomInset: number }) {
  const { api } = useApiClient();
  const { user } = useAuth();
  const queries = useMemo(() => createQueries(api), [api]);
  const tasks = useQuery(queries.tasks());
  const nav = useNavigation();
  const { archive } = useThreadArchive();
  const [settingsOpen, setSettingsOpen] = useState(false);
  const current = nav.current;
  const openTaskId = current.name === "thread" ? current.taskId : undefined;
  const now = Date.now();

  // Ordered by updatedAt, which also moves when a run finishes; Task has no `lastMessageAt` to sort by yet.
  const byRecent = [...(tasks.data ?? [])].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  const threads = byRecent.filter((task) => task.archivedAt === undefined);
  const archivedCount = byRecent.length - threads.length;

  function archiveThread(task: Task) {
    archive.mutate(task.id, {
      // The open thread leaves the list; go back to the empty chat.
      onSuccess: () => {
        if (task.id === openTaskId) nav.navigate({ name: "new-thread" });
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
      {tasks.error ? <Alert style={styles.alert}>{errorText(tasks.error)}</Alert> : null}
      {archive.error ? <Alert style={styles.alert}>{errorText(archive.error)}</Alert> : null}
      {tasks.data && threads.length === 0 ? <Text style={styles.empty}>No threads yet.</Text> : null}
    </View>
  );

  return (
    <View style={styles.root}>
      <FlatList
        data={threads}
        keyExtractor={(task) => task.id}
        ListHeaderComponent={header}
        contentContainerStyle={[styles.list, { paddingBottom: bottomInset + 80 }]}
        renderItem={({ item }) => (
          <ThreadRow
            task={item}
            active={item.id === openTaskId}
            archiving={archive.isPending && archive.variables === item.id}
            onArchive={() => archiveThread(item)}
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
    flexDirection: "row",
    alignItems: "flex-start",
    gap: 10,
    paddingHorizontal: spacing.md,
    paddingVertical: 10,
    borderRadius: radius.md,
    marginVertical: 1,
  },
  statusWrap: {
    marginTop: 2,
  },
  threadInfo: {
    flex: 1,
    gap: 2,
    minWidth: 0,
  },
  threadTitle: {
    color: colors.mutedForeground,
    fontSize: 14,
    fontWeight: "500",
  },
  threadTitleActive: {
    color: colors.foreground,
    fontWeight: "600",
  },
  threadMeta: {
    color: colors.mutedForeground,
    fontSize: 12,
    opacity: 0.8,
  },
  chipRow: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 4,
    marginTop: 4,
  },
  repoChip: {
    backgroundColor: colors.white06,
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: radius.full,
  },
  repoChipText: {
    color: colors.mutedForeground,
    fontSize: 10,
    fontFamily: fonts.mono,
  },
  archive: { width: 28, height: 28, alignSelf: "center", marginRight: -spacing.xs },
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
