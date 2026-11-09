import React, { useCallback, useEffect, useMemo, useReducer, useRef, useState } from "react";
import { ActivityIndicator, AppState, ScrollView, StyleSheet, Text, View } from "react-native";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useApiClient } from "@/hooks/useApiClient";
import { createQueries, boxKeys, type ThreadCall } from "@/api/queries";
import { Alert } from "@/components/ui/Alert";
import { Button } from "@/components/ui/Button";
import { HtmlView, type HtmlViewHandle } from "@/components/ui/HtmlView";
import { StatusIcon } from "@/components/ui/StatusIcon";
import { ThreadGraphs } from "@/components/ThreadGraphs";
import { embedEvent, initialViewerView, reduceViewer } from "@/lib/desktopViewer";
import { applyDesktopStatus, type DesktopStatusValue } from "@cloudagents/protocol";
import { colors, fonts, radius, spacing } from "@/theme";
import type { DesktopStatus } from "@cloudagents/protocol";

/** A second `auth-expired` inside this window means the fresh URL was rejected too: stop retrying. */
const AUTH_REFRESH_WINDOW_MS = 5_000;
/** The embed keeps retrying an unreachable stream by itself; a fresh URL, in case its token expired, is minted this often. */
const UNREACHABLE_REFRESH_MS = 30_000;

/**
 * Desktop viewer. The stream plays in the desktop embed page, loaded in an HtmlView: a WebView on native, an iframe on
 * the web. The embed negotiates WebRTC and handles touch input; this component starts and stops the desktop, relays
 * the embed's status, and answers `auth-expired` with a fresh stream URL.
 */
export function DesktopViewer({ taskId }: { taskId: string }) {
  const { api } = useApiClient();
  const queryClient = useQueryClient();
  const queries = useMemo(() => createQueries(api), [api]);
  const desktop = useQuery(queries.desktop(taskId));
  const status = desktop.data?.status ?? null;
  const [embed, setEmbed] = useState<{ taskId: string; url: string } | null>(null);
  const [viewer, dispatchViewer] = useReducer(reduceViewer, initialViewerView);
  // The embed is unmounted while the app is backgrounded, which closes its connections; it remounts on foreground.
  const [inForeground, setInForeground] = useState(true);
  const webView = useRef<HtmlViewHandle | null>(null);
  const lastAuthRefresh = useRef(0);
  const lastUnreachableRefresh = useRef(0);

  const active = status?.state === "running" || status?.state === "starting";

  const toggle = useMutation({
    mutationFn: async ({ api, taskId, active }: ThreadCall & { active: boolean }): Promise<DesktopStatus> => {
      if (!active) return api.startDesktop(taskId);
      await api.stopDesktop(taskId);
      return api.getDesktop(taskId);
    },
    onMutate: ({ api, taskId }) =>
      queryClient.getQueryData<DesktopStatusValue>(boxKeys(api.boxScope).desktop(taskId)),
    onSuccess: (next, { api, taskId }, base) => {
      const key = boxKeys(api.boxScope).desktop(taskId);
      const current = queryClient.getQueryData<DesktopStatusValue>(key);
      queryClient.setQueryData(key, applyDesktopStatus(current, next, "mutation", base));
    },
  });

  useEffect(() => {
    const sub = AppState.addEventListener("change", (state) => setInForeground(state !== "background"));
    return () => sub.remove();
  }, []);

  // A stream's status and errors belong to its embed URL. A new URL starts from nothing, so a restarted desktop cannot
  // inherit the old stream's "live", "unreachable" or sign-in failure.
  useEffect(() => {
    dispatchViewer({ _tag: "embedChanged" });
  }, [embed?.url]);

  // The embed URL carries the stream's ws URL, and that carries its token. It is resolved outside render and kept
  // while unchanged, so the WebView does not reload. It is re-resolved on each desktop state change and on foreground,
  // so a restarted stream or a resumed app gets a token that has not expired.
  useEffect(() => {
    if (!inForeground) return;
    let current = true;
    api.desktopSocketUrl(taskId).then(
      (ws) => {
        if (!current) return;
        const url = api.desktopEmbedUrl(taskId, ws);
        setEmbed((prev) => (prev?.taskId === taskId && prev.url === url ? prev : { taskId, url }));
      },
      (error: unknown) => {
        if (current) {
          dispatchViewer({
            _tag: "failed",
            reason: error instanceof Error ? error.message : String(error),
          });
        }
      }
    );
    return () => {
      current = false;
    };
  }, [api, taskId, status?.state, inForeground]);

  // The embed's socket was rejected (its token expired): mint a new one and hand the embed its new ws URL. The embed
  // keeps its page, so its WebRTC session is re-established without a reload. A handshake that merely failed may be a
  // network or box that is down, so it is not an error: the embed shows that and keeps retrying, and a new URL is minted
  // now and then in case the token is what failed.
  const onEmbedMessage = useCallback(
    (data: unknown) => {
      const message = embedEvent(data);
      if (message === null) return;
      dispatchViewer({ _tag: "message", message });
      if (message.event === "unreachable") {
        const now = Date.now();
        if (now - lastUnreachableRefresh.current < UNREACHABLE_REFRESH_MS) return;
        lastUnreachableRefresh.current = now;
        api.desktopSocketUrl(taskId, { fresh: true }).then(
          (ws) => webView.current?.postMessage({ type: "kestrel-desktop", ws }),
          () => {}
        );
      } else if (message.event === "auth-expired") {
        const now = Date.now();
        if (now - lastAuthRefresh.current < AUTH_REFRESH_WINDOW_MS) {
          dispatchViewer({
            _tag: "failed",
            reason: "The desktop stream rejected a fresh sign-in. Stop and start the desktop to retry.",
          });
          return;
        }
        lastAuthRefresh.current = now;
        api.desktopSocketUrl(taskId, { fresh: true }).then(
          (ws) => webView.current?.postMessage({ type: "kestrel-desktop", ws }),
          (error: unknown) =>
            dispatchViewer({
              _tag: "failed",
              reason: error instanceof Error ? error.message : String(error),
            })
        );
      }
    },
    [api, taskId]
  );

  const actionError = toggle.error ?? desktop.error;
  const error = actionError
    ? actionError instanceof Error
      ? actionError.message
      : String(actionError)
    : viewer.error ?? status?.error ?? null;

  const aspect = status?.width && status?.height ? status.width / status.height : 16 / 9;
  const showViewer = status?.state === "running" && inForeground && embed?.taskId === taskId;

  return (
    <ScrollView style={styles.scroll} contentContainerStyle={styles.container}>
      <View style={styles.toolbar}>
        <Button
          variant={active ? "soft" : "default"}
          size="sm"
          onPress={() => toggle.mutate({ api, taskId, active })}
          disabled={toggle.isPending || !status}
        >
          {active ? "Stop" : "Start"}
        </Button>
        {status ? <StatusIcon status={status.state} /> : null}
        {status?.state === "running" ? (
          <Text style={styles.info}>
            {status.width}×{status.height} · {status.fps} fps{viewer.state ? ` · ${viewer.state}` : ""}
          </Text>
        ) : null}
        {viewer.unreachable ? <Text style={styles.warning}>Stream unreachable. Retrying…</Text> : null}
      </View>
      {error ? <Alert style={styles.alert}>{error}</Alert> : null}
      <View style={[styles.well, { aspectRatio: aspect }]}>
        {showViewer && embed ? (
          <HtmlView
            ref={webView}
            uri={embed.url}
            onMessage={onEmbedMessage}
            style={styles.webview}
          />
        ) : (
          <View style={styles.placeholder}>
            {toggle.isPending ? (
              <ActivityIndicator color={colors.mutedForeground} />
            ) : (
              <Text style={styles.placeholderText}>{status?.state ?? "loading"}</Text>
            )}
          </View>
        )}
      </View>
      <ThreadGraphs taskId={taskId} />
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  scroll: { flex: 1 },
  container: { paddingHorizontal: spacing.md, paddingBottom: spacing.lg },
  toolbar: { flexDirection: "row", alignItems: "center", gap: spacing.sm, paddingVertical: spacing.sm },
  info: { color: colors.mutedForeground, fontSize: 12, fontFamily: fonts.mono },
  warning: { color: colors.warning, fontSize: 12 },
  alert: { marginBottom: spacing.sm },
  well: { width: "100%", marginBottom: spacing.md, borderRadius: radius.xl, overflow: "hidden", backgroundColor: "#000" },
  webview: { flex: 1, backgroundColor: "#000" },
  placeholder: { flex: 1, alignItems: "center", justifyContent: "center" },
  placeholderText: { color: colors.mutedForeground, fontSize: 14, textAlign: "center" },
});
