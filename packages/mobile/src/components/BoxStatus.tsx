import React from "react";
import { View, Text, StyleSheet, ActivityIndicator } from "react-native";
import { useQuery } from "@tanstack/react-query";
import { useMemo } from "react";
import { useApiClient } from "@/hooks/useApiClient";
import { createQueries } from "@/api/queries";
import { colors, radius, spacing } from "@/theme";

export function BoxPill() {
  const { api } = useApiClient();
  const queries = useMemo(() => createQueries(api), [api]);
  const box = useQuery(queries.box());

  if (box.isPending) {
    return (
      <View style={styles.pill}>
        <ActivityIndicator size="small" color={colors.mutedForeground} />
      </View>
    );
  }

  const online = box.data?.online ?? false;
  return (
    <View style={[styles.pill, { backgroundColor: online ? colors.success + "22" : colors.destructive + "22" }]}>
      <View style={[styles.dot, { backgroundColor: online ? colors.success : colors.destructive }]} />
      <Text style={[styles.text, { color: online ? colors.success : colors.destructive }]}>
        {online ? "Box online" : "Box offline"}
      </Text>
    </View>
  );
}

export function BoxOfflineBanner() {
  const { api } = useApiClient();
  const queries = useMemo(() => createQueries(api), [api]);
  const box = useQuery(queries.box());

  if (box.data?.online !== false) return null;

  return (
    <View style={styles.banner}>
      <Text style={styles.bannerText}>
        Agent box is offline. Some features are unavailable.
      </Text>
    </View>
  );
}

export function useBoxOffline(): boolean {
  const { api } = useApiClient();
  const queries = useMemo(() => createQueries(api), [api]);
  const box = useQuery(queries.box());
  return box.data?.online === false;
}

const styles = StyleSheet.create({
  pill: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    paddingHorizontal: spacing.sm,
    paddingVertical: 3,
    borderRadius: radius.xl,
  },
  dot: {
    width: 6,
    height: 6,
    borderRadius: 3,
  },
  text: {
    fontSize: 11,
    fontWeight: "500",
  },
  banner: {
    backgroundColor: colors.destructive + "15",
    borderBottomWidth: 1,
    borderBottomColor: colors.destructive + "33",
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.sm,
  },
  bannerText: {
    color: colors.destructive,
    fontSize: 12,
  },
});

