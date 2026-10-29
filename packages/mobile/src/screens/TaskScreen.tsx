import React, { useEffect, useState } from "react";
import { Linking, StyleSheet, Text, View, useWindowDimensions } from "react-native";
import { GestureDetector, usePanGesture } from "react-native-gesture-handler";
import Animated, { useAnimatedStyle } from "react-native-reanimated";
import { GitCompare, GitPullRequest, type LucideIcon, Monitor, PanelRightClose } from "lucide-react-native";
import { ChatPanel } from "@/components/ChatPanel";
import { DesktopViewer } from "@/components/DesktopViewer";
import { DiffView } from "@/components/DiffView";
import { ContentPanel, TopBar } from "@/components/TopBar";
import { Alert } from "@/components/ui/Alert";
import { Button } from "@/components/ui/Button";
import { useSwipePanel } from "@/hooks/useSwipePanel";
import { useTaskState } from "@/hooks/useTaskState";
import { repoShortName } from "@/lib/format";
import { useShell } from "@/nav/navigation";
import { colors, radius, spacing } from "@/theme";

type TabId = "desktop" | "diff";

// Add a panel tab by adding an entry here and a case in PanelBody.
const PANEL_TABS: readonly { id: TabId; label: string; icon: LucideIcon }[] = [
  { id: "desktop", label: "Desktop", icon: Monitor },
  { id: "diff", label: "Diff", icon: GitCompare },
];

/** Gap around the panel, as the web aside's `m-2`. */
const PANEL_INSET = spacing.sm;
/** Left strip of the open panel that takes a right swipe to close it; the rest of its body keeps its own touches. */
const CLOSE_EDGE_WIDTH = 18;

interface Props {
  taskId: string;
  /** Bottom safe-area inset, passed to the content panel. */
  bottomInset: number;
}

/**
 * One thread (task): the web app's ThreadView. Chat fills the screen; the Desktop/Diff panel slides in from the
 * right on a left swipe over the chat (or its top bar buttons) and leaves on a right swipe over its header or left
 * edge. Its content only mounts while it can be seen, so the desktop stream does not connect until it is opened.
 */
export function TaskScreen({ taskId, bottomInset }: Props) {
  const state = useTaskState(taskId);
  const shell = useShell();
  const { width } = useWindowDimensions();
  const [open, setOpen] = useState(false);
  const [tab, setTab] = useState<TabId>("desktop");

  // The agent opened the desktop: show it. Only a new count reopens, so a reconnect with a running desktop does not.
  useEffect(() => {
    if (state.desktopOpens === 0) return;
    setTab("desktop");
    setOpen(true);
  }, [state.desktopOpens]);

  // While the panel is open, a right swipe belongs to it, and Android back closes it before leaving the thread.
  useEffect(() => {
    shell.lockSidebarSwipe(open);
    shell.interceptBack(
      open
        ? () => {
            setOpen(false);
            return true;
          }
        : null
    );
  }, [open, shell]);
  useEffect(
    () => () => {
      shell.lockSidebarSwipe(false);
      shell.interceptBack(null);
    },
    [shell]
  );

  const swipe = useSwipePanel({ open, onOpenChange: setOpen, side: "right", distance: width });
  const openPan = usePanGesture(swipe.openGesture);
  const edgeOpenPan = usePanGesture(swipe.openGesture);
  const headerClosePan = usePanGesture(swipe.closeGesture);
  const edgeClosePan = usePanGesture(swipe.closeGesture);
  const panelStyle = useAnimatedStyle(() => ({
    transform: [{ translateX: (1 - swipe.progress.value) * width }],
  }));

  function openTab(next: TabId) {
    setTab(next);
    setOpen(true);
  }

  // A checkout with a pull request gets its own link; with several repos checked out, the link names its repo.
  const checkouts = state.task?.checkouts ?? [];
  const pullRequests = checkouts.flatMap((checkout) => {
    if (!checkout.pullRequest) return [];
    const repo = checkouts.length > 1 ? `${repoShortName(checkout.repo)} ` : "";
    return [{ id: checkout.id, url: checkout.pullRequest.url, label: `${repo}PR #${checkout.pullRequest.number}` }];
  });
  // Archived threads keep their history; their desktop was torn down, so it does not start again.
  const archivedTask = state.task?.archivedAt ? state.task : undefined;

  // The web's collapsed panel rail: one button per tab, and the pull request links.
  const rail = (
    <>
      {PANEL_TABS.map((t) => (
        <Button key={t.id} variant="ghost" size="icon" icon={t.icon} accessibilityLabel={t.label} onPress={() => openTab(t.id)} />
      ))}
      {pullRequests.map((pr) => (
        <Button
          key={pr.id}
          variant="ghost"
          size="icon"
          icon={GitPullRequest}
          accessibilityLabel={pr.label}
          onPress={() => void Linking.openURL(pr.url)}
        />
      ))}
    </>
  );

  return (
    <>
      <TopBar title={state.task?.title ?? ""} right={rail} />
      <ContentPanel bottomInset={bottomInset}>
        <GestureDetector gesture={openPan}>
          <View style={styles.flex}>
            {state.error ? <Alert style={styles.error}>{state.error}</Alert> : null}
            <ChatPanel
              taskId={taskId}
              taskStatus={state.task?.status}
              messages={state.messages}
              runs={state.runs}
              output={state.output}
              archivedTask={archivedTask}
            />
          </View>
        </GestureDetector>
        <GestureDetector gesture={edgeOpenPan}>
          <View pointerEvents={open ? "none" : "auto"} style={[styles.openEdge, { bottom: bottomInset }]} />
        </GestureDetector>
        {swipe.visible ? (
          <Animated.View style={[styles.panel, { bottom: bottomInset + PANEL_INSET }, panelStyle]}>
            <GestureDetector gesture={headerClosePan}>
              <View style={styles.panelHeader}>
                {PANEL_TABS.map((t) => (
                  <Button
                    key={t.id}
                    variant={tab === t.id ? "soft" : "ghost"}
                    size="sm"
                    icon={t.icon}
                    active={tab === t.id}
                    onPress={() => setTab(t.id)}
                  >
                    {t.label}
                  </Button>
                ))}
                <View style={styles.prLinks}>
                  {pullRequests.map((pr) => (
                    <Button key={pr.id} variant="ghost" size="sm" icon={GitPullRequest} onPress={() => void Linking.openURL(pr.url)}>
                      {pr.label}
                    </Button>
                  ))}
                </View>
                <Button
                  variant="ghost"
                  size="icon"
                  icon={PanelRightClose}
                  accessibilityLabel="Close panel"
                  onPress={() => setOpen(false)}
                />
              </View>
            </GestureDetector>
            <PanelBody tab={tab} taskId={taskId} archived={archivedTask !== undefined} running={state.task?.status === "running"} />
            <GestureDetector gesture={edgeClosePan}>
              <View style={styles.closeEdge} />
            </GestureDetector>
          </Animated.View>
        ) : null}
      </ContentPanel>
    </>
  );
}

function PanelBody({ tab, taskId, archived, running }: { tab: TabId; taskId: string; archived: boolean; running: boolean }) {
  switch (tab) {
    case "desktop":
      if (archived) {
        return <Text style={styles.note}>The desktop is off while this thread is archived.</Text>;
      }
      return <DesktopViewer taskId={taskId} />;
    case "diff":
      return <DiffView taskId={taskId} running={running} />;
  }
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  error: { marginHorizontal: spacing.lg, marginTop: spacing.md, width: "auto" },
  panel: {
    position: "absolute",
    top: PANEL_INSET,
    left: PANEL_INSET,
    right: PANEL_INSET,
    overflow: "hidden",
    borderRadius: radius.xl,
    backgroundColor: colors.background,
  },
  panelHeader: { flexDirection: "row", alignItems: "center", gap: 6, padding: spacing.sm },
  prLinks: { flex: 1, flexDirection: "row", justifyContent: "flex-end", gap: spacing.xs, overflow: "hidden" },
  // This target is outside the chat ScrollView, so the native scroll recognizer cannot consume its left swipe.
  openEdge: { position: "absolute", top: 0, right: 0, width: CLOSE_EDGE_WIDTH },
  closeEdge: { position: "absolute", top: 52, bottom: 0, left: 0, width: CLOSE_EDGE_WIDTH },
  note: { color: colors.mutedForeground, fontSize: 14, padding: spacing.lg },
});
