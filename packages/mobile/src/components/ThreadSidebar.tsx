import React, { useMemo, useState } from "react";
import { FlatList, Image, Modal, Pressable, StyleSheet, Text, View } from "react-native";
import { useQuery } from "@tanstack/react-query";
import { Archive, LogOut, type LucideIcon, Plug, Settings, SquarePen, Workflow } from "lucide-react-native";
import type { Task } from "@cloudagents/protocol";
import { createQueries } from "@/api/queries";
import { useAuth } from "@/auth/AuthContext";
import { KestrelMark } from "@/components/KestrelMark";
import { Alert } from "@/components/ui/Alert";
import { Button } from "@/components/ui/Button";
import { StatusIcon } from "@/components/ui/StatusIcon";
import { useApiClient } from "@/hooks/useApiClient";
import { useThreadArchive } from "@/hooks/useThreadArchive";
import { errorText } from "@/lib/format";
import { type Route, useNavigation } from "@/nav/navigation";
import { colors, radius, shadows, spacing } from "@/theme";

/** Thread states worth an icon in the list; idle and done threads show just their title. */
const FLAGGED: Partial<Record<Task["status"], true>> = { running: true, needs_input: true, failed: true };

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
}: {
  task: Task;
  active: boolean;
  archiving: boolean;
  onArchive: () => void;
}) {
  const nav = useNavigation();
  return (
    <Pressable
      onPress={() => nav.navigate({ name: "thread", taskId: task.id })}
      accessibilityRole="button"
      accessibilityLabel={task.title}
      accessibilityState={{ selected: active }}
      style={({ pressed }) => [styles.row, (pressed || active) && styles.rowActive]}
    >
      <Text style={styles.threadTitle} numberOfLines={1}>
        {task.title}
      </Text>
      {FLAGGED[task.status] ? <StatusIcon status={task.status} /> : null}
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
  const queries = useMemo(() => createQueries(api), [api]);
  const tasks = useQuery(queries.tasks());
  const nav = useNavigation();
  const { archive } = useThreadArchive();
  const [settingsOpen, setSettingsOpen] = useState(false);
  const current = nav.current;
  const openTaskId = current.name === "thread" ? current.taskId : undefined;

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
    <View>
      <View style={styles.brand}>
        <KestrelMark height={22} />
        <Text style={styles.brandText}>Kestrel</Text>
      </View>
      <NavRow icon={Workflow} label="Automations" route={{ name: "automations" }} active={current.name === "automations"} />
      <NavRow
        icon={Archive}
        label={archivedCount > 0 ? `Archived (${archivedCount})` : "Archived"}
        route={{ name: "archived" }}
        active={current.name === "archived"}
      />
      <Text style={styles.section}>Threads</Text>
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
        contentContainerStyle={[styles.list, { paddingBottom: bottomInset + 96 }]}
        renderItem={({ item }) => (
          <ThreadRow
            task={item}
            active={item.id === openTaskId}
            archiving={archive.isPending && archive.variables === item.id}
            onArchive={() => archiveThread(item)}
          />
        )}
      />
      <View style={[styles.dock, { bottom: bottomInset + spacing.md }]} pointerEvents="box-none">
        <Pressable
          style={({ pressed }) => [styles.newThread, pressed && styles.newThreadPressed]}
          onPress={() => nav.navigate({ name: "new-thread" })}
          accessibilityRole="button"
          accessibilityLabel="New thread"
        >
          <SquarePen size={20} color={colors.primaryForeground} strokeWidth={2} />
          <Text style={styles.newThreadText}>New thread</Text>
        </Pressable>
        <Pressable
          style={({ pressed }) => [styles.settings, pressed && styles.settingsPressed]}
          onPress={() => setSettingsOpen(true)}
          accessibilityRole="button"
          accessibilityLabel="Settings"
        >
          <Settings size={22} color={colors.foreground} strokeWidth={1.75} />
        </Pressable>
      </View>
      <SettingsSheet open={settingsOpen} onClose={() => setSettingsOpen(false)} />
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  list: { paddingHorizontal: spacing.sm },
  brand: { flexDirection: "row", alignItems: "center", gap: 10, paddingHorizontal: spacing.lg, paddingVertical: spacing.lg },
  brandText: { color: colors.foreground, fontSize: 24, fontWeight: "600", letterSpacing: -0.4 },
  row: {
    flexDirection: "row",
    alignItems: "center",
    gap: 14,
    minHeight: 46,
    paddingHorizontal: spacing.lg,
    borderRadius: radius.lg,
  },
  rowActive: { backgroundColor: colors.accent },
  navText: { color: colors.foreground, fontSize: 17 },
  section: {
    color: colors.foreground,
    fontSize: 16,
    fontWeight: "600",
    paddingHorizontal: spacing.lg,
    paddingTop: spacing.xl,
    paddingBottom: spacing.sm,
  },
  alert: { marginHorizontal: spacing.sm, marginBottom: spacing.sm },
  empty: { color: colors.mutedForeground, fontSize: 15, paddingHorizontal: spacing.lg },
  threadTitle: { flex: 1, color: colors.foreground, fontSize: 16 },
  archive: { marginRight: -spacing.sm, width: 32, height: 32 },
  dock: {
    position: "absolute",
    left: spacing.lg,
    right: spacing.lg,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
  },
  newThread: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    height: 52,
    paddingHorizontal: 22,
    borderRadius: radius.full,
    backgroundColor: colors.primary,
    ...shadows.soft,
  },
  newThreadPressed: { backgroundColor: "#dcdcde" },
  newThreadText: { color: colors.primaryForeground, fontSize: 17, fontWeight: "600" },
  settings: {
    width: 52,
    height: 52,
    borderRadius: 26,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: colors.secondary,
    ...shadows.soft,
  },
  settingsPressed: { backgroundColor: colors.accent },
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
