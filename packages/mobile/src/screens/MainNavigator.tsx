import React, { type ReactNode, useEffect, useMemo, useState } from "react";
import { ActivityIndicator, BackHandler, StatusBar, StyleSheet, Text, View, SafeAreaView } from "react-native";
import { useQueryClient } from "@tanstack/react-query";
import { useAuth } from "@/auth/AuthContext";
import { type Navigation, NavigationContext, type Route } from "@/nav/navigation";
import { colors, spacing } from "@/theme";
import { ArchivedScreen } from "@/screens/ArchivedScreen";
import { AutomationsScreen } from "@/screens/AutomationsScreen";
import { ConnectionsScreen } from "@/screens/ConnectionsScreen";
import { LoginScreen } from "@/screens/LoginScreen";
import { NewThreadScreen } from "@/screens/NewThreadScreen";
import { TaskScreen } from "@/screens/TaskScreen";
import { ThreadsScreen } from "@/screens/ThreadsScreen";

const HOME: Route = { name: "threads" };

/** Stack navigation without a router: the top route is what is shown; back pops it. */
export function MainNavigator() {
  const { user, loading } = useAuth();
  const queryClient = useQueryClient();
  const [stack, setStack] = useState<readonly Route[]>([HOME]);

  const nav = useMemo<Navigation>(
    () => ({
      push: (route) => setStack((s) => [...s, route]),
      replace: (route) => setStack((s) => [...s.slice(0, -1), route]),
      back: () => setStack((s) => (s.length > 1 ? s.slice(0, -1) : s)),
    }),
    []
  );

  const canGoBack = stack.length > 1;
  useEffect(() => {
    if (!canGoBack) return;
    const sub = BackHandler.addEventListener("hardwareBackPress", () => {
      nav.back();
      return true;
    });
    return () => sub.remove();
  }, [canGoBack, nav]);

  // Signing out drops the cached account data and returns to the home list.
  useEffect(() => {
    if (user) return;
    queryClient.clear();
    setStack([HOME]);
  }, [user, queryClient]);

  if (loading) {
    return (
      <View style={styles.center}>
        <ActivityIndicator color={colors.mutedForeground} />
        <Text style={styles.muted}>Loading…</Text>
      </View>
    );
  }
  if (!user) return <LoginScreen />;

  const route = stack.at(-1) ?? HOME;
  return (
    <NavigationContext.Provider value={nav}>
      <SafeAreaView style={styles.safe}>
        <StatusBar barStyle="light-content" />
        <View style={styles.screen}>{screenFor(route)}</View>
      </SafeAreaView>
    </NavigationContext.Provider>
  );
}

function screenFor(route: Route): ReactNode {
  switch (route.name) {
    case "threads":
      return <ThreadsScreen />;
    case "new-thread":
      return <NewThreadScreen />;
    case "thread":
      return <TaskScreen key={route.taskId} taskId={route.taskId} />;
    case "archived":
      return <ArchivedScreen />;
    case "automations":
      return <AutomationsScreen />;
    case "connections":
      return <ConnectionsScreen />;
  }
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: colors.background },
  screen: { flex: 1, backgroundColor: colors.background },
  center: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    gap: spacing.sm,
    backgroundColor: colors.background,
  },
  muted: { color: colors.mutedForeground },
});
