import React, { type ReactNode, useEffect, useRef, useState } from "react";
import {
  Image,
  type LayoutChangeEvent,
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  type TextInputKeyPressEvent,
  View,
  useWindowDimensions,
} from "react-native";
import { useQueries } from "@tanstack/react-query";
import Animated, {
  FadeIn,
  FadeInDown,
  FadeInUp,
  FadeOut,
  LayoutAnimationConfig,
  LinearTransition,
  useAnimatedStyle,
  useReducedMotion,
  useSharedValue,
  withTiming,
} from "react-native-reanimated";
import Archive from "lucide-react-native/icons/archive";
import ChevronDown from "lucide-react-native/icons/chevron-down";
import ChevronsUpDown from "lucide-react-native/icons/chevrons-up-down";
import CreditCard from "lucide-react-native/icons/credit-card";
import GitBranch from "lucide-react-native/icons/git-branch";
import GitPullRequest from "lucide-react-native/icons/git-pull-request";
import LogOut from "lucide-react-native/icons/log-out";
import Plug from "lucide-react-native/icons/plug";
import Search from "lucide-react-native/icons/search";
import Settings from "lucide-react-native/icons/settings";
import SquarePen from "lucide-react-native/icons/square-pen";
import Workflow from "lucide-react-native/icons/workflow";
import type { LucideIcon } from "lucide-react-native";
import type { Task } from "@cloudagents/protocol";
import { sameBox } from "@/api/client";
import { isUnreachableError } from "@/api/errors";
import { createQueries } from "@/api/queries";
import { useAuth } from "@/auth/AuthContext";
import { KestrelMark } from "@/components/KestrelMark";
import { ThreadAvatar } from "@/components/ThreadAvatar";
import { Alert } from "@/components/ui/Alert";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import { StatusIcon } from "@/components/ui/StatusIcon";
import { LiveText } from "@/components/ui/LiveText";
import { type BoxSource, useBoxSources } from "@/hooks/useBoxSources";
import { useThreadArchive } from "@/hooks/useThreadArchive";
import { errorText, formatAgo, repoShortName } from "@/lib/format";
import { storage } from "@/lib/storage";
import { groupThreads, matchesThreadQuery, threadKey } from "@/lib/threadLists";
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
 * (it left the dock). Both use the layout primitives so reduced motion turns them into the end state. Built-in presets,
 * not a `Keyframe`: on the web Reanimated pins a custom keyframe's element at its measured size once it ends
 * (`position: absolute`), so a row that later grows (its sub-threads opened) would overlap the rows below.
 */
const INTO_DOCK = FadeInUp.duration(240);
const INTO_LIST = FadeInDown.duration(240);

function useNow(intervalMs: number): number {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(id);
  }, [intervalMs]);
  return now;
}

/** One entry of the account sheet: it closes the sheet, then opens its screen from the sidebar. */
function SheetRow({ icon: Icon, label, route, onClose }: { icon: LucideIcon; label: string; route: Route; onClose: () => void }) {
  const nav = useNavigation();
  return (
    <Pressable
      onPress={() => {
        onClose();
        nav.navigate(route);
      }}
      accessibilityRole="button"
      style={({ pressed }) => [styles.row, pressed && styles.rowActive]}
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
 * archive button out of the keyboard tab order. With sub-threads, the last line leaves room for their toggle.
 */
function ThreadRow({
  task,
  source,
  active,
  archiving,
  onArchive,
  now,
  interactive,
  hasChildren,
}: {
  task: Task;
  source: BoxSource;
  active: boolean;
  archiving: boolean;
  onArchive: () => void;
  now: number;
  interactive: boolean;
  hasChildren: boolean;
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
        <View style={[styles.threadLine, hasChildren && styles.threadLineToggle]}>
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

/** A sub-thread under its parent: only the title and its status, so the list stays short while work runs. */
function SubThreadRow({
  task,
  source,
  active,
  interactive,
  hasChildren,
}: {
  task: Task;
  source: BoxSource;
  active: boolean;
  interactive: boolean;
  hasChildren: boolean;
}) {
  const nav = useNavigation();
  const title = task.title || "Untitled thread";
  return (
    <Pressable
      onPress={() => nav.navigate({ name: "thread", taskId: task.id, box: source.box })}
      focusable={interactive}
      tabIndex={interactive ? 0 : -1}
      accessibilityRole="button"
      accessibilityLabel={`${title} — ${STATUS_LABEL[task.status]}`}
      accessibilityState={{ selected: active }}
      style={({ pressed }) => [styles.subRow, hasChildren && styles.subRowToggle, (pressed || active) && styles.rowActive]}
    >
      <Text style={[styles.subTitle, active && styles.threadTitleActive]} numberOfLines={1}>
        {title}
      </Text>
      <StatusIcon status={task.status} size={14} />
    </Pressable>
  );
}

/**
 * A thread with its sub-threads, as on the web: the sub-threads stay folded under a chevron at the row's lower left
 * until the user opens them.
 */
function ThreadGroup({
  entry,
  sub = false,
  childrenOf,
  interactive,
  renderRow,
}: {
  entry: ThreadEntry;
  sub?: boolean;
  childrenOf: ReadonlyMap<string, ThreadEntry[]>;
  interactive: boolean;
  renderRow: (entry: ThreadEntry, sub: boolean, hasChildren: boolean) => ReactNode;
}) {
  const [expanded, setExpanded] = useState(false);
  const children = childrenOf.get(threadKey(entry.source.api.boxScope, entry.task.id)) ?? [];
  const hasChildren = children.length > 0;
  return (
    <View>
      <View>
        {renderRow(entry, sub, hasChildren)}
        {hasChildren ? (
          <Pressable
            onPress={() => setExpanded((e) => !e)}
            focusable={interactive}
            tabIndex={interactive ? 0 : -1}
            accessibilityRole="button"
            accessibilityLabel={`${expanded ? "Collapse" : "Expand"} sub-threads for ${entry.task.title || "Untitled thread"}`}
            accessibilityState={{ expanded }}
            aria-expanded={expanded}
            hitSlop={8}
            style={({ pressed }) => [styles.subToggle, pressed && styles.subTogglePressed]}
          >
            <View style={!expanded && styles.chevronFolded}>
              <ChevronDown size={14} color={colors.mutedForeground} />
            </View>
          </Pressable>
        ) : null}
      </View>
      {hasChildren && expanded ? (
        <View style={styles.subList}>
          {children.map((child) => (
            <ThreadGroup
              key={child.task.id}
              entry={child}
              sub
              childrenOf={childrenOf}
              interactive={interactive}
              renderRow={renderRow}
            />
          ))}
        </View>
      ) : null}
    </View>
  );
}

/**
 * The web's account menu, behind the account row at the foot of the sidebar: settings and its sections (automations
 * and archived threads among them, for quick access) and sign-out.
 */
function SettingsSheet({ open, onClose }: { open: boolean; onClose: () => void }) {
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
          <SheetRow icon={Settings} label="Settings" route={{ name: "settings" }} onClose={onClose} />
          <SheetRow icon={Plug} label="Connections" route={{ name: "connections" }} onClose={onClose} />
          <SheetRow icon={CreditCard} label="Billing" route={{ name: "settings", section: "billing" }} onClose={onClose} />
          <View style={styles.sheetSeparator} />
          <SheetRow icon={Workflow} label="Automations" route={{ name: "automations" }} onClose={onClose} />
          <SheetRow icon={Archive} label="Archived" route={{ name: "archived" }} onClose={onClose} />
          <View style={styles.sheetSeparator} />
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
 * The web's thread sidebar as the left drawer: a thread search and a new-thread button, then the user's threads most
 * recent first, with sub-threads folded under the thread that started them. Threads waiting on the user get their
 * own group at the top; working threads (running, or with a live run) leave the list for a foldable dock at the
 * bottom; both return to the list when they settle. Threads come from every box the user has. The dock remembers
 * whether the user folded it, caps its height and scrolls, and its rows join the keyboard tab order only while it is
 * open. Threads whose box is still loading or failed say so. The search filters every group.
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
  const scope = (entry: ThreadEntry) => entry.source.api.boxScope;
  const { awaiting, threads, working, children } = groupThreads(entries, scope);
  const allLoaded = tasksByBox.every((query) => query.isSuccess);
  const [search, setSearch] = useState("");
  const [searchFocused, setSearchFocused] = useState(false);
  const query = search.trim().toLowerCase();
  const shown = (list: ThreadEntry[]) => (query ? list.filter((entry) => matchesThreadQuery(entry, query, children, scope)) : list);
  const shownAwaiting = shown(awaiting);
  const shownThreads = shown(threads);
  const shownWorking = shown(working);

  // Both the dock and the list animate; the dock's size is measured, bounded, and folds to its header.
  const { height: windowHeight } = useWindowDimensions();
  const [rootHeight, setRootHeight] = useState(0);
  const [contentHeight, setContentHeight] = useState(0);
  const dockBound = Math.max(0, Math.round((rootHeight || windowHeight) * DOCK_MAX_FRACTION));
  const contentBound = Math.max(0, dockBound - DOCK_HEADER_HEIGHT);
  // Before the scroll view reports its content, a row estimate keeps the dock from flashing as header-only.
  const bodyHeight = Math.min(contentHeight > 0 ? contentHeight : shownWorking.length * DOCK_ROW_ESTIMATE, contentBound);
  const dockOpen = shownWorking.length > 0;
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

  function threadGroup(entry: ThreadEntry, interactive: boolean) {
    return (
      <ThreadGroup
        entry={entry}
        childrenOf={children}
        interactive={interactive}
        renderRow={({ task, source }, sub, hasChildren) => {
          const active = current.name === "thread" && current.taskId === task.id && sameBox(current.box, source.box);
          return sub ? (
            <SubThreadRow task={task} source={source} active={active} interactive={interactive} hasChildren={hasChildren} />
          ) : (
            <ThreadRow
              task={task}
              source={source}
              active={active}
              archiving={
                archive.isPending &&
                archive.variables?.taskId === task.id &&
                archive.variables.api.boxScope === source.api.boxScope
              }
              onArchive={() => archiveThread({ task, source })}
              now={now}
              interactive={interactive}
              hasChildren={hasChildren}
            />
          );
        }}
      />
    );
  }

  return (
    <LayoutAnimationConfig skipEntering>
      <View style={styles.root} onLayout={handleRootLayout}>
        <View style={styles.brand}>
          <KestrelMark height={22} />
          <Text style={styles.brandText}>Kestrel</Text>
        </View>
        <View style={styles.searchRow}>
          {/* Transparent and flat with softened text at rest; focused, it takes the usual grey input look. */}
          <View style={styles.searchField}>
            <Input
              accessibilityLabel="Search threads"
              placeholder="Search threads"
              placeholderTextColor={searchFocused ? colors.mutedForeground + "b3" : colors.foreground + "b3"}
              value={search}
              onChangeText={setSearch}
              onKeyPress={(event: TextInputKeyPressEvent) => {
                if (event.nativeEvent.key === "Escape") setSearch("");
              }}
              onFocus={() => setSearchFocused(true)}
              onBlur={() => setSearchFocused(false)}
              autoCapitalize="none"
              autoCorrect={false}
              returnKeyType="search"
              inputMode="search"
              style={[styles.search, !searchFocused && styles.searchRest]}
            />
            <View style={styles.searchIcon} pointerEvents="none">
              <Search size={16} color={searchFocused ? colors.mutedForeground : colors.foreground + "b3"} />
            </View>
          </View>
          <Pressable
            onPress={() => nav.navigate({ name: "new-thread" })}
            accessibilityRole="button"
            accessibilityLabel="New thread"
            accessibilityState={{ selected: current.name === "new-thread" }}
            style={({ pressed }) => [styles.compose, pressed && styles.composePressed]}
          >
            <SquarePen size={18} color={colors.foreground + "b3"} />
          </Pressable>
        </View>
        <ScrollView style={styles.scroll} contentContainerStyle={styles.list} keyboardShouldPersistTaps="handled">
          {sources.map((source, i) => {
            const boxQuery = tasksByBox[i];
            if (boxQuery.error) {
              // A box that is merely unreachable is already shown by its indicator; only a real refusal is worth a row.
              return isUnreachableError(boxQuery.error) ? null : (
                <Alert key={source.api.boxScope} style={styles.alert}>
                  {`${source.label}: ${errorText(boxQuery.error)}`}
                </Alert>
              );
            }
            if (boxQuery.isPending) {
              return (
                <Text key={source.api.boxScope} style={styles.empty}>
                  Loading {source.label}…
                </Text>
              );
            }
            return null;
          })}
          {archive.error ? <Alert style={styles.alert}>{errorText(archive.error)}</Alert> : null}
          {!query && awaiting.length + threads.length + working.length === 0 && allLoaded ? (
            <Text style={styles.empty}>No threads yet.</Text>
          ) : null}
          {shownAwaiting.length > 0 ? (
            <>
              <View style={styles.groupHeader}>
                <StatusIcon status="needs_input" size={14} />
                <Text style={styles.groupTitle}>Needs input</Text>
                <Text style={styles.groupCount}>{shownAwaiting.length}</Text>
              </View>
              {shownAwaiting.map((entry) => (
                <AnimatedThreadRow key={threadKey(scope(entry), entry.task.id)} entering={INTO_LIST}>
                  {threadGroup(entry, true)}
                </AnimatedThreadRow>
              ))}
              {shownThreads.length > 0 ? <View style={styles.groupSeparator} /> : null}
            </>
          ) : null}
          {shownThreads.map((entry) => (
            <AnimatedThreadRow key={threadKey(scope(entry), entry.task.id)} entering={INTO_LIST}>
              {threadGroup(entry, true)}
            </AnimatedThreadRow>
          ))}
          {query && shownAwaiting.length + shownThreads.length + shownWorking.length === 0 ? (
            <Text style={styles.empty}>No threads match “{search.trim()}”</Text>
          ) : null}
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
            accessibilityLabel={`Working threads, ${shownWorking.length} running`}
            accessibilityHint={dockCollapsed ? "Shows the working threads" : "Folds the working threads"}
            accessibilityState={{ expanded: !dockCollapsed }}
            aria-expanded={!dockCollapsed}
            style={({ pressed }) => [styles.dockHeader, pressed && styles.dockHeaderPressed]}
          >
            <View aria-hidden accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
              <StatusIcon status="running" size={14} />
            </View>
            <Text style={styles.dockTitle}>Working</Text>
            <Text style={styles.dockCount}>{shownWorking.length}</Text>
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
              {shownWorking.map((entry) => (
                <AnimatedThreadRow key={threadKey(scope(entry), entry.task.id)} entering={INTO_DOCK}>
                  {threadGroup(entry, !dockCollapsed && dockOpen)}
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
  brand: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    paddingHorizontal: spacing.lg,
    paddingTop: spacing.lg,
    paddingBottom: spacing.sm,
  },
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
  searchRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    paddingHorizontal: spacing.sm,
    paddingTop: spacing.sm,
    paddingBottom: spacing.sm,
  },
  searchField: { flex: 1, minWidth: 0, justifyContent: "center" },
  search: { minHeight: 38, paddingLeft: 36, paddingRight: 10, paddingVertical: 6, fontSize: 15 },
  searchRest: { backgroundColor: "transparent", borderColor: "transparent" },
  searchIcon: { position: "absolute", left: 11 },
  compose: { width: 38, height: 38, borderRadius: radius.md, alignItems: "center", justifyContent: "center" },
  composePressed: { backgroundColor: colors.white06 },
  groupHeader: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    paddingHorizontal: spacing.md,
    paddingTop: spacing.sm,
    paddingBottom: spacing.xs,
  },
  groupTitle: { color: colors.mutedForeground, fontSize: 12, fontWeight: "600" },
  groupCount: { color: colors.mutedForeground, fontSize: 12, fontVariant: ["tabular-nums"] },
  groupSeparator: { height: 1, backgroundColor: colors.border, marginTop: spacing.sm, marginBottom: spacing.xs },
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
  threadLineToggle: { paddingLeft: 24 },
  threadMeta: { flex: 1, color: colors.mutedForeground, fontSize: 12 },
  threadTime: { color: colors.mutedForeground, fontSize: 12, fontVariant: ["tabular-nums"] },
  hidden: { opacity: 0 },
  threadTitle: { color: colors.mutedForeground, fontSize: 14, fontWeight: "500" },
  threadTitleActive: { color: colors.foreground, fontWeight: "600" },
  archive: { position: "absolute", top: spacing.xs, right: spacing.xs, width: 28, height: 28 },
  subToggle: {
    position: "absolute",
    left: spacing.xs,
    bottom: spacing.xs,
    width: 24,
    height: 24,
    borderRadius: radius.sm,
    alignItems: "center",
    justifyContent: "center",
  },
  subTogglePressed: { backgroundColor: colors.white06 },
  chevronFolded: { transform: [{ rotate: "-90deg" }] },
  subList: { marginLeft: spacing.lg, paddingLeft: spacing.sm, borderLeftWidth: 1, borderLeftColor: colors.border },
  subRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.sm,
    minHeight: 36,
    paddingLeft: spacing.sm,
    paddingRight: spacing.md,
    borderRadius: radius.md,
    marginVertical: 1,
  },
  subRowToggle: { paddingLeft: 36 },
  subTitle: { flex: 1, color: colors.mutedForeground, fontSize: 13 },
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
  sheetSeparator: { height: 1, backgroundColor: colors.border, marginVertical: spacing.xs, marginHorizontal: spacing.md },
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
