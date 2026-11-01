import React, { useMemo } from "react";
import { StyleSheet, Text, type StyleProp, type ViewStyle } from "react-native";
import { useQuery } from "@tanstack/react-query";
import { useApiClient } from "@/hooks/useApiClient";
import { createQueries } from "@/api/queries";
import { useAuth } from "@/auth/AuthContext";
import { Alert } from "@/components/ui/Alert";
import { colors } from "@/theme";

/** Warning shown only once the box is known to be offline, the web app's `BoxOfflineBanner`. */
export function BoxOfflineBanner({ style }: { style?: StyleProp<ViewStyle> }) {
  const offline = useBoxOffline();
  const { activeBoxId } = useAuth();
  if (!offline) return null;
  return (
    <Alert variant="warning" style={style}>
      <Text style={styles.bannerText}>
        {activeBoxId === null
          ? "Kestrel's box is unavailable right now."
          : "Your box is offline. Check that it is running and reachable from this device."}
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
});
