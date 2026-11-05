import React, { useMemo } from "react";
import { StyleSheet, Text, View, type StyleProp, type ViewStyle } from "react-native";
import { useQuery } from "@tanstack/react-query";
import { Server } from "lucide-react-native";
import { useApiClient } from "@/hooks/useApiClient";
import { createQueries } from "@/api/queries";
import { Alert } from "@/components/ui/Alert";
import { colors, fonts, radius, spacing } from "@/theme";

/** Warning shown only once the box is known to be offline, the web app's `BoxOfflineBanner`. */
export function BoxOfflineBanner({ style }: { style?: StyleProp<ViewStyle> }) {
  const offline = useBoxOffline();
  if (!offline) return null;
  return (
    <Alert variant="warning" style={style}>
      <Text style={styles.bannerText}>
        Agent box offline. Start it with <Text style={styles.code}>nix run .#box</Text>
      </Text>
    </Alert>
  );
}

export function useBoxOffline(): boolean {
  return useBoxOnline() === false;
}

/** Whether the box the app talks to answers; undefined until it is known. */
export function useBoxOnline(): boolean | undefined {
  const { api } = useApiClient();
  const queries = useMemo(() => createQueries(api), [api]);
  return useQuery(queries.box()).data?.online;
}

/**
 * The box a thread runs on, with its online dot: the web app's `ThreadBoxIndicator`. The web floats it over the chat;
 * here it takes its own line above the chat, so it never covers the first message. It sits close under the panel's top
 * edge and on the chat's `spacing.lg` column, clear of the panel's rounded corner. Each thread runs on the box it was
 * opened from, so the indicator names that box.
 */
export function ThreadBoxIndicator({ name, style }: { name: string; style?: StyleProp<ViewStyle> }) {
  const online = useBoxOnline();
  const state = online === undefined ? "checking" : online ? "online" : "offline";
  return (
    <View style={[styles.indicator, style]} pointerEvents="none" accessibilityLabel={`Running on ${name}, ${state}`}>
      <Server size={12} color={colors.mutedForeground} />
      <Text style={styles.indicatorText} numberOfLines={1}>
        {name}
      </Text>
      <View
        style={[
          styles.dot,
          { backgroundColor: online === undefined ? colors.mutedForeground + "66" : online ? colors.success : colors.destructive },
        ]}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  bannerText: {
    color: colors.warning,
    fontSize: 14,
    lineHeight: 20,
  },
  code: {
    color: colors.foreground,
    fontFamily: fonts.mono,
  },
  indicator: {
    alignSelf: "flex-start",
    marginTop: spacing.sm,
    marginLeft: spacing.lg,
    maxWidth: 192,
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    paddingHorizontal: spacing.sm,
    paddingVertical: 2,
    borderRadius: radius.full,
    backgroundColor: colors.white06,
  },
  indicatorText: { flexShrink: 1, color: colors.mutedForeground, fontSize: 11 },
  dot: { width: 6, height: 6, borderRadius: 3 },
});
