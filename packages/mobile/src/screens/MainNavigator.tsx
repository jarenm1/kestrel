import React, { type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ActivityIndicator, Pressable, StatusBar, StyleSheet, Text, View, useWindowDimensions } from "react-native";
import { onBackPress, showRoute, takeLaunchRoute } from "@/nav/history";
import { GestureDetector, usePanGesture } from "react-native-gesture-handler";
import Animated, { interpolate, interpolateColor, useAnimatedStyle } from "react-native-reanimated";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useQueryClient } from "@tanstack/react-query";
import { useAuth } from "@/auth/AuthContext";
import { ThreadSidebar } from "@/components/ThreadSidebar";
import { ContentPanel, TopBar } from "@/components/TopBar";
import { useSwipePanel } from "@/hooks/useSwipePanel";
import { type Navigation, NavigationContext, type Route, type Shell, ShellContext } from "@/nav/navigation";
import { colors, radius, spacing } from "@/theme";
import { ArchivedScreen } from "@/screens/ArchivedScreen";
import { AutomationsScreen } from "@/screens/AutomationsScreen";
import { ConnectionsScreen } from "@/screens/ConnectionsScreen";
import { LoginScreen } from "@/screens/LoginScreen";
import { NewThreadScreen } from "@/screens/NewThreadScreen";
import { SettingsScreen } from "@/screens/SettingsScreen";
import { TaskScreen } from "@/screens/TaskScreen";
import { UsageScreen } from "@/screens/UsageScreen";

/** Home is the empty chat, as on the web ("/"). */
const HOME: Route = { name: "new-thread" };
const SIDEBAR_MAX_WIDTH = 360;

/**
 * The signed-in workspace: the thread sidebar on the page background, revealed by swiping right (or the top bar
 * button), and the current screen in a raised panel that slides aside for it. Navigation is a small stack
 * without a router; back (Android's button, the browser's on the web) closes the sidebar first, then pops.
 */
export function MainNavigator() {
  const { user, loading, activeBox } = useAuth();
  const queryClient = useQueryClient();
  const insets = useSafeAreaInsets();
  const { width } = useWindowDimensions();
  const [stack, setStack] = useState<readonly Route[]>([HOME]);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [swipeLocked, setSwipeLocked] = useState(false);
  const backInterceptor = useRef<(() => boolean) | null>(null);
  const sidebarWidth = Math.min(Math.round(width * 0.78), SIDEBAR_MAX_WIDTH);

  const current = stack.at(-1) ?? HOME;
  const nav = useMemo<Navigation>(
    () => ({
      current,
      navigate: (route) => {
        setStack(route.name === HOME.name ? [HOME] : [HOME, route]);
        setSidebarOpen(false);
      },
      push: (route) => setStack((s) => [...s, route]),
      replace: (route) => setStack((s) => [...s.slice(0, -1), route]),
      back: () => setStack((s) => (s.length > 1 ? s.slice(0, -1) : s)),
    }),
    [current]
  );
  const shell = useMemo<Shell>(
    () => ({
      openSidebar: () => setSidebarOpen(true),
      lockSidebarSwipe: setSwipeLocked,
      interceptBack: (handler) => {
        backInterceptor.current = handler;
      },
    }),
    []
  );
  const closeSidebar = useCallback(() => setSidebarOpen(false), []);

  const swipe = useSwipePanel({
    open: sidebarOpen,
    onOpenChange: setSidebarOpen,
    side: "left",
    distance: sidebarWidth,
    enabled: !swipeLocked,
  });
  const openPan = usePanGesture(swipe.openGesture);
  const sidebarClosePan = usePanGesture(swipe.closeGesture);
  const scrimClosePan = usePanGesture(swipe.closeGesture);

  const canGoBack = stack.length > 1;
  useEffect(
    () =>
      onBackPress(() => {
        if (sidebarOpen) {
          setSidebarOpen(false);
          return true;
        }
        if (backInterceptor.current?.()) return true;
        if (!canGoBack) return false;
        nav.back();
        return true;
      }),
    [sidebarOpen, canGoBack, nav]
  );

  // Signing out drops the cached account data and returns to the empty chat; signing in opens the launch link's thread.
  useEffect(() => {
    if (user) {
      const launch = takeLaunchRoute();
      // The box is applied together with the user, so `activeBox` is the box the link's thread lives on.
      if (launch) setStack([HOME, launch.name === "thread" ? { ...launch, box: activeBox } : launch]);
      return;
    }
    queryClient.clear();
    setStack([HOME]);
    setSidebarOpen(false);
  }, [user, queryClient]);

  useEffect(() => {
    if (user) showRoute(current);
  }, [user, current]);

  const contentStyle = useAnimatedStyle(() => ({
    transform: [{ translateX: swipe.progress.value * sidebarWidth }],
    // Pushed aside, the screen reads as a card: rounded, with a faint edge (as in the ChatGPT app).
    borderRadius: interpolate(swipe.progress.value, [0, 1], [0, radius.xxl + 16]),
    // interpolateColor, not a formatted string: near the end of a close the alpha gets tiny enough to print as
    // `9.2e-7`, which Reanimated rejects as an invalid color and Expo Go crashes on.
    borderColor: interpolateColor(swipe.progress.value, [0, 1], ["rgba(255,255,255,0)", "rgba(255,255,255,0.1)"]),
  }));
  const sidebarStyle = useAnimatedStyle(() => ({
    opacity: swipe.progress.value,
    transform: [{ translateX: interpolate(swipe.progress.value, [0, 1], [-spacing.xl, 0]) }],
  }));
  const scrimStyle = useAnimatedStyle(() => ({ opacity: swipe.progress.value }));

  if (loading) {
    return (
      <View style={styles.center}>
        <ActivityIndicator color={colors.mutedForeground} />
        <Text style={styles.muted}>Loading…</Text>
      </View>
    );
  }
  if (!user) return <LoginScreen />;

  return (
    <NavigationContext.Provider value={nav}>
      <ShellContext.Provider value={shell}>
        <View style={styles.root}>
          <StatusBar barStyle="light-content" />
          {swipe.visible ? (
            <GestureDetector gesture={sidebarClosePan}>
              <Animated.View
                style={[
                  styles.sidebar,
                  { width: sidebarWidth, paddingTop: insets.top + spacing.sm },
                  sidebarStyle,
                ]}
              >
                <ThreadSidebar bottomInset={insets.bottom} />
              </Animated.View>
            </GestureDetector>
          ) : null}
          <GestureDetector gesture={openPan}>
            <Animated.View style={[styles.content, { paddingTop: insets.top }, contentStyle]}>
              {screenFor(current, insets.bottom)}
              {swipe.visible ? (
                <GestureDetector gesture={scrimClosePan}>
                  <Animated.View style={[styles.scrim, scrimStyle]}>
                    <Pressable
                      style={StyleSheet.absoluteFill}
                      onPress={closeSidebar}
                      accessibilityRole="button"
                      accessibilityLabel="Close threads"
                    />
                  </Animated.View>
                </GestureDetector>
              ) : null}
            </Animated.View>
          </GestureDetector>
        </View>
      </ShellContext.Provider>
    </NavigationContext.Provider>
  );
}

/** The thread screen draws its own top bar (title and panel buttons); every other screen gets the plain one. */
function screenFor(route: Route, bottomInset: number): ReactNode {
  if (route.name === "thread") {
    return (
      <TaskScreen
        key={`${route.box?.id ?? "relay"}:${route.taskId}`}
        taskId={route.taskId}
        box={route.box}
        bottomInset={bottomInset}
      />
    );
  }
  return (
    <>
      <TopBar />
      <ContentPanel bottomInset={bottomInset}>{pageFor(route)}</ContentPanel>
    </>
  );
}

function pageFor(route: Exclude<Route, { name: "thread" }>): ReactNode {
  switch (route.name) {
    case "new-thread":
      return <NewThreadScreen />;
    case "archived":
      return <ArchivedScreen />;
    case "automations":
      return <AutomationsScreen />;
    case "connections":
      return <ConnectionsScreen />;
    case "settings":
      return <SettingsScreen />;
    case "usage":
      return <UsageScreen />;
  }
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.background },
  sidebar: { position: "absolute", top: 0, bottom: 0, left: 0 },
  content: { flex: 1, overflow: "hidden", borderWidth: 1, backgroundColor: colors.background },
  scrim: { position: "absolute", top: 0, right: 0, bottom: 0, left: 0, backgroundColor: "rgba(0,0,0,0.25)" },
  center: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    gap: spacing.sm,
    backgroundColor: colors.background,
  },
  muted: { color: colors.mutedForeground },
});
