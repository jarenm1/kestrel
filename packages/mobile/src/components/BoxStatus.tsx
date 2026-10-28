import React, { useMemo } from "react";
import { StyleSheet, Text, type StyleProp, type ViewStyle } from "react-native";
import { useQuery } from "@tanstack/react-query";
import { useApiClient } from "@/hooks/useApiClient";
import { createQueries } from "@/api/queries";
import { Alert } from "@/components/ui/Alert";
import { colors, fonts } from "@/theme";

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
  const { api } = useApiClient();
  const queries = useMemo(() => createQueries(api), [api]);
  const box = useQuery(queries.box());
  return box.data?.online === false;
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
});
