import React, { type ReactNode, useEffect, useRef, useState } from "react";
import {
  Image,
  type LayoutChangeEvent,
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
  useWindowDimensions,
} from "react-native";
import { useQueries } from "@tanstack/react-query";
import Animated, {
  FadeIn,
  FadeOut,
  Keyframe,
  LayoutAnimationConfig,
  LinearTransition,
  useAnimatedStyle,
  useReducedMotion,
  useSharedValue,
  withTiming,
} from "react-native-reanimated";
import {
  Archive,
  ChevronDown,
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
import { isUnreachableError } from "@/api/errors";
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
import { storage } from "@/lib/storage";
import { groupThreads } from "@/lib/threadLists";
import { type Route, useNavigation } from "@/nav/navigation";
import { colors, radius, shadows, spacing } from "@/theme";

const STATUS_LABEL: Record<Task["status"], string> = {
  idle: "Idle",
  running: "Working",
  needs_input: "Needs input",
  done: "Done",
  failed: "Failed",
};

/** How often the "5m ago" labels and live ordering refresh. */
const CLOCK_TICK_MS = 30_000;
/** Remembers that the user folded the working dock, shared with the web app's key. */
const DOCK_COLLAPSED_KEY = "kestrel.workingDockCollapsed";
/** The dock may take at most this share of the sidebar, then it scrolls. */
const DOCK_MAX_FRACTION = 0.45;
/** Height of the "Working · 3 ⌄" header; the folded dock is exactly this tall. */
const DOCK_HEADER_HEIGHT = 36;
const DOCK_ANIM_MS = 260;
/** A dock row's typical height, so the dock can open at its real size before the first measurement lands. */
const DOCK_ROW_ESTIMATE = 76;

/** Rows fade in and out as they join or leave a section; `layout` slides the rest into place. */
const ROW_ENTER = FadeIn.duration(220);
const ROW_EXIT = FadeOut.duration(160);
const ROW_LAYOUT = LinearTransition.duration(300);
/**
 * A thread joining the dock arrives from above (it left the list); a thread returning to the list comes from below
 * (it left the dock). Both use the layout primitives so reduced motion turns them into the end state.
 */
const INTO_DOCK = new Keyframe({
  0: { opacity: 0, transform: [{ translateY: -14 }] },
  100: { opacity: 1, transform: [{ translateY: 0 }] },
}).duration(240);
const INTO_LIST = new Keyframe({
  0: { opacity: 0, transform: [{ translateY: 14 }] },
  100: { opacity: 1, transform: [{ translateY: 0 }] },
}).duration(240);

function useNow(intervalMs: number): number {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(id);
  }, [intervalMs]);
  return now;
}

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
 * line names the status instead. `interactive` is false while the working dock is folded, which takes the row and its
 * archive button out of the keyboard tab order.
 */
function ThreadRow({
  task,
  source,
  active,
  archiving,
  onArchive,
  now,
  interactive,
}: {
  task: Task;
  source: BoxSource;
  active: boolean;
  archiving: boolean;
  onArchive: () => void;
  now: number;
  interactive: boolean;
}) {
  const nav = useNavigation();
  const [checkout, ...otherCheckouts] = task.checkouts;
  const pullRequest = checkout === undefined ? undefined : (task.pullRequests ?? []).filter((pr) => pr.checkoutId === checkout.id).at(-1);
  const checkoutsLabel = task.checkouts.map((c) => `${c.repo}, ${c.branch}`).join("; ");
  return (
    <Pressable
      onPress={() => nav.navigate({ name: "thread", taskId: task.id, box: source.box })}
      focusable={interactive}
      tabIndex={interactive ? 0 : -1}
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
              {pullRequest ? (
                <GitPullRequest size={14} color={colors.mutedForeground} />
              ) : (
                <GitBranch size={14} color={colors.mutedForeground} />
              )}
              <Text style={styles.threadMeta} numberOfLines={1}>
                {checkout.branch}
                {pullRequest ? ` #${pullRequest.number}` : null}
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
          focusable={interactive}
          tabIndex={interactive ? 0 : -1}
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

/** Rows fade as they join or leave the list; `layout` slides the neighbours into place. */
function AnimatedThreadRow({ entering, children }: { entering: typeof ROW_ENTER | typeof INTO_DOCK | typeof INTO_LIST; children: ReactNode }) {
  return (
    <Animated.View layout={ROW_LAYOUT} entering={entering} exiting={ROW_EXIT}>
      {children}
    </Animated.View>
  );
}

/**
 * The user's threads under the workspace pages, the left drawer: most recent first, with running threads in a
 * foldable dock at the bottom. Threads come from every box the user has; a running thread leaves the list and appears
 * once in the dock, and returns to the list when the run ends. The dock remembers whether the user folded it, caps its
 * height and scrolls, and its rows join the keyboard tab order only while it is open. Threads whose box is still
 * loading or failed say so.
 */
export function ThreadSidebar({ bottomInset }: { bottomInset: number }) {
  const { user } = useAuth();
  const sources = useBoxSources();
  const tasksByBox = useQueries({ queries: sources.map((source) => createQueries(source.api).tasks()) });
  const nav = useNavigation();
  const { archive } = useThreadArchive();
  const [settingsOpen, setSettingsOpen] = useState(false);
  const current = nav.current;
  const now = useNow(CLOCK_TICK_MS);

  const entries: ThreadEntry[] = sources.flatMap((source, i) =>
    (tasksByBox[i].data ?? []).map((task) => ({ task, source }))
  );
  const { threads, working, archivedCount } = groupThreads(entries);
  const allLoaded = tasksByBox.every((query) => query.isSuccess);

  // Both the dock and the list animate; the dock's size is measured, bounded, and folds to its header.
  const { height: windowHeight } = useWindowDimensions();
  const [rootHeight, setRootHeight] = useState(0);
  const [contentHeight, setContentHeight] = useState(0);
  const dockBound = Math.max(0, Math.round((rootHeight || windowHeight) * DOCK_MAX_FRACTION));
  const contentBound = Math.max(0, dockBound - DOCK_HEADER_HEIGHT);
  // Before the scroll view reports its content, a row estimate keeps the dock from flashing as header-only.
  const bodyHeight = Math.min(contentHeight > 0 ? contentHeight : working.length * DOCK_ROW_ESTIMATE, contentBound);
  const dockOpen = working.length > 0;
  const reduceMotion = useReducedMotion();

  const [dockCollapsed, setDockCollapsed] = useState(true);
  // Folded until the saved preference is read: a restored fold must be the dock's first visible state, never an
  // animated reveal of its rows that the user (or a keyboard) could touch on the way.
  const fold = useSharedValue(0);
  const dockPreference = useRef({ loaded: false, toggled: false });
  useEffect(() => {
    let cancelled = false;
    void storage.getItem(DOCK_COLLAPSED_KEY).then((stored) => {
      if (cancelled || dockPreference.current.toggled) return;
      dockPreference.current.loaded = true;
      const collapsed = stored === "1";
      setDockCollapsed(collapsed);
      // A restored preference is the dock's opening state, not a fold to animate.
      fold.value = collapsed ? 0 : 1;
    }).catch(() => {
      // A failed read means "no saved preference": open at the default without animating, and keep saving choices.
      if (cancelled || dockPreference.current.toggled) return;
      dockPreference.current.loaded = true;
      setDockCollapsed(false);
      fold.value = 1;
    });
    return () => {
      cancelled = true;
    };
  }, []);
  useEffect(() => {
    // Nothing to save until the saved value has been read, unless the user already chose for this session.
    if (!dockPreference.current.loaded && !dockPreference.current.toggled) return;
    if (dockCollapsed) void storage.setItem(DOCK_COLLAPSED_KEY, "1");
    else void storage.deleteItem(DOCK_COLLAPSED_KEY);
  }, [dockCollapsed]);
  function toggleDock() {
    dockPreference.current.toggled = true;
    const collapsed = !dockCollapsed;
    setDockCollapsed(collapsed);
    // Only a user's tap animates the fold; the persisted state is applied directly above.
    fold.value = withTiming(collapsed ? 0 : 1, { duration: reduceMotion ? 0 : DOCK_ANIM_MS });
  }

  const presence = useSharedValue(dockOpen ? 1 : 0);
  const body = useSharedValue(0);
  const bodyMeasured = useRef(false);
  useEffect(() => {
    presence.value = withTiming(dockOpen ? 1 : 0, { duration: reduceMotion ? 0 : DOCK_ANIM_MS });
  }, [dockOpen, presence, reduceMotion]);
  useEffect(() => {
    // The first real measurement is the dock's opening size, not a change: growing it would make the drawer's
    // reveal stutter. Later row changes animate.
    if (!bodyMeasured.current) {
      if (bodyHeight === 0) return;
      bodyMeasured.current = true;
      body.value = bodyHeight;
      return;
    }
    body.value = withTiming(bodyHeight, { duration: reduceMotion ? 0 : DOCK_ANIM_MS });
  }, [bodyHeight, body, reduceMotion]);

  const dockStyle = useAnimatedStyle(() => ({
    height: presence.value * (DOCK_HEADER_HEIGHT + fold.value * body.value),
    opacity: presence.value,
  }));
  const chevronStyle = useAnimatedStyle(() => ({ transform: [{ rotate: `${(1 - fold.value) * -90}deg` }] }));

  function handleRootLayout(event: LayoutChangeEvent) {
    const height = Math.round(event.nativeEvent.layout.height);
    setRootHeight((previous) => (Math.abs(previous - height) > 1 ? height : previous));
  }

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

  function threadRow({ task, source }: ThreadEntry, interactive: boolean) {
    return (
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
        interactive={interactive}
      />
    );
  }

  return (
    <LayoutAnimationConfig skipEntering>
      <View style={styles.root} onLayout={handleRootLayout}>
        <ScrollView style={styles.scroll} contentContainerStyle={styles.list}>
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
                // A box that is merely unreachable is already shown by its indicator; only a real refusal is worth a row.
                return isUnreachableError(query.error) ? null : (
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
            {threads.length === 0 && working.length === 0 && allLoaded ? (
              <Text style={styles.empty}>No threads yet.</Text>
            ) : null}
          </View>
          {threads.map((entry) => (
            <AnimatedThreadRow key={`${entry.source.api.boxScope}:${entry.task.id}`} entering={INTO_LIST}>
              {threadRow(entry, true)}
            </AnimatedThreadRow>
          ))}
        </ScrollView>
        {/* The dock stays mounted so its height, not a remount, is what folds: collapsed it is the header alone. */}
        <Animated.View
          style={[styles.dockSection, dockStyle]}
          pointerEvents={dockOpen ? "auto" : "none"}
          aria-hidden={dockOpen ? undefined : true}
          accessibilityElementsHidden={!dockOpen}
          importantForAccessibility={dockOpen ? "auto" : "no-hide-descendants"}
        >
          <Pressable
            onPress={toggleDock}
            disabled={!dockOpen}
            focusable={dockOpen}
            tabIndex={dockOpen ? 0 : -1}
            accessibilityRole="button"
            accessibilityLabel={`Working threads, ${working.length} running`}
            accessibilityHint={dockCollapsed ? "Shows the working threads" : "Folds the working threads"}
            accessibilityState={{ expanded: !dockCollapsed }}
            aria-expanded={!dockCollapsed}
            style={({ pressed }) => [styles.dockHeader, pressed && styles.dockHeaderPressed]}
          >
            <View aria-hidden accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
              <StatusIcon status="running" size={14} />
            </View>
            <Text style={styles.dockTitle}>Working</Text>
            <Text style={styles.dockCount}>{working.length}</Text>
            <Animated.View style={[styles.dockChevron, chevronStyle]}>
              <ChevronDown size={14} color={colors.mutedForeground} />
            </Animated.View>
          </Pressable>
          <View
            style={[styles.dockBody, { height: bodyHeight }]}
            pointerEvents={dockCollapsed || !dockOpen ? "none" : "auto"}
            aria-hidden={dockCollapsed || !dockOpen}
            accessibilityElementsHidden={dockCollapsed || !dockOpen}
            importantForAccessibility={dockCollapsed || !dockOpen ? "no-hide-descendants" : "auto"}
          >
            <ScrollView
              nestedScrollEnabled
              style={styles.dockScroll}
              contentContainerStyle={styles.dockList}
              onContentSizeChange={(_width, height) => {
                const rounded = Math.round(height);
                setContentHeight((previous) => (Math.abs(previous - rounded) > 0.5 ? rounded : previous));
              }}
            >
              {working.map((entry) => (
                <AnimatedThreadRow key={`${entry.source.api.boxScope}:${entry.task.id}`} entering={INTO_DOCK}>
                  {threadRow(entry, !dockCollapsed && dockOpen)}
                </AnimatedThreadRow>
              ))}
            </ScrollView>
          </View>
        </Animated.View>
        <View style={[styles.accountArea, { paddingBottom: bottomInset + spacing.sm }]}>
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
    </LayoutAnimationConfig>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  scroll: { flex: 1 },
  list: { paddingHorizontal: spacing.sm, paddingBottom: spacing.sm },
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
  dockSection: {
    flexShrink: 0,
    overflow: "hidden",
    marginHorizontal: spacing.md,
  },
  dockHeader: {
    height: DOCK_HEADER_HEIGHT,
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    paddingHorizontal: spacing.sm,
    borderRadius: radius.md,
    borderTopWidth: 1,
    borderTopColor: colors.border,
  },
  dockHeaderPressed: { backgroundColor: colors.white03 },
  dockTitle: { flex: 1, color: colors.mutedForeground, fontSize: 12, fontWeight: "600" },
  dockCount: { color: colors.mutedForeground, fontSize: 12, fontVariant: ["tabular-nums"] },
  dockChevron: { width: 14, alignItems: "center", justifyContent: "center" },
  dockBody: { overflow: "hidden" },
  dockScroll: { flex: 1 },
  dockList: { paddingBottom: spacing.xs },
  accountArea: { paddingHorizontal: spacing.sm, paddingTop: spacing.xs },
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
