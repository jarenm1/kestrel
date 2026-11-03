import React, { useMemo } from "react";
import { ScrollView, StyleSheet, Text, View } from "react-native";
import { useMutation, useQuery } from "@tanstack/react-query";
import type { CliProvider } from "@cloudagents/protocol";
import { USAGE_REFRESH_MS, resetActionOf, usageSubtitle } from "@cloudagents/ui/usage";
import { createQueries, queryClient } from "@/api/queries";
import { useAuth } from "@/auth/AuthContext";
import UsageQuotasDom from "@/components/UsageQuotasDom";
import { useApiClient } from "@/hooks/useApiClient";
import { boxLabel } from "@/hooks/useBoxSources";
import { errorText } from "@/lib/format";
import { useNavigation } from "@/nav/navigation";
import { colors } from "@/theme";

/**
 * Plan limits, banked resets and activity on the active box: the desktop's quotas panel, drawn by the same shared
 * component (`UsageQuotasDom`). This screen only owns the data, as the desktop's `UsagePanel` does.
 */
export function UsageScreen() {
  const { activeBox, boxes, managedBox } = useAuth();
  const nav = useNavigation();
  const { api } = useApiClient();
  const queries = useMemo(() => createQueries(api), [api]);
  const usage = useQuery({ ...queries.providerUsage(), refetchInterval: USAGE_REFRESH_MS });
  const activity = useQuery({ ...queries.usageActivity(), refetchInterval: USAGE_REFRESH_MS });
  const spendReset = useMutation({
    mutationFn: ({ provider, resetId }: { provider: CliProvider; resetId: string }) =>
      api.useBankedReset(provider, { resetId }),
    onSettled: () => void queryClient.invalidateQueries({ queryKey: queries.providerUsage().queryKey }),
  });

  return (
    <ScrollView style={styles.screen} contentContainerStyle={styles.content}>
      <View style={styles.heading}>
        <Text style={styles.title}>Quotas</Text>
        <Text style={styles.description}>
          {usageSubtitle(boxLabel(activeBox, boxes, managedBox), usage.data?.length ?? null)}
        </Text>
      </View>
      <UsageQuotasDom
        usage={usage.data}
        usageError={usage.error ? errorText(usage.error) : null}
        updatedAt={usage.dataUpdatedAt}
        activity={activity.data?.days}
        activityError={activity.error ? errorText(activity.error) : null}
        resetAction={resetActionOf(spendReset)}
        onUseReset={async (provider, resetId) => spendReset.mutate({ provider, resetId })}
        onOpenConnections={async () => nav.push({ name: "connections" })}
        // The WebView takes its content's height; this ScrollView scrolls the page.
        dom={{ matchContents: true, scrollEnabled: false }}
      />
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.background },
  content: { padding: 16, gap: 16 },
  heading: { gap: 2 },
  title: { color: colors.foreground, fontSize: 20, fontWeight: "600", letterSpacing: -0.5 },
  description: { color: colors.mutedForeground, fontSize: 14 },
});
