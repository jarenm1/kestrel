import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ActivityIndicator, AppState, ScrollView, StyleSheet, Text, View } from "react-native";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useApiClient } from "@/hooks/useApiClient";
import { createQueries, boxKeys, type ThreadCall } from "@/api/queries";
import { Alert } from "@/components/ui/Alert";
import { Button } from "@/components/ui/Button";
import { HtmlView, type HtmlViewHandle } from "@/components/ui/HtmlView";
import { StatusIcon } from "@/components/ui/StatusIcon";
import { ThreadGraphs } from "@/components/ThreadGraphs";
import { colors, fonts, radius, spacing } from "@/theme";
import type { DesktopStatus } from "@cloudagents/protocol";

/** A second `auth-expired` inside this window means the fresh URL was rejected too: stop retrying. */
const AUTH_REFRESH_WINDOW_MS = 5_000;
/** The embed keeps retrying an unreachable stream by itself; a fresh URL, in case its token expired, is minted this often. */
const UNREACHABLE_REFRESH_MS = 30_000;

/** Messages the desktop embed page (`<app host>/embed/desktop`) posts to the host. */
type EmbedEvent = { event: "status"; state: string } | { event: "auth-expired" } | { event: "unreachable" };

function embedEvent(data: unknown): EmbedEvent | null {
  if (typeof data !== "object" || data === null) return null;
  const message = data as { type?: unknown; event?: unknown; state?: unknown };
  if (message.type !== "kestrel-desktop") return null;
  if (message.event === "auth-expired") return { event: "auth-expired" };
  if (message.event === "unreachable") return { event: "unreachable" };
  if (message.event === "status" && typeof message.state === "string") return { event: "status", state: message.state };
  return null;
}

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
  const status = desktop.data ?? null;
  const [embed, setEmbed] = useState<{ taskId: string; url: string } | null>(null);
  const [streamError, setStreamError] = useState<unknown>(null);
  const [viewerState, setViewerState] = useState<string | null>(null);
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
    onSuccess: (next, { api, taskId }) => queryClient.setQueryData(boxKeys(api.boxScope).desktop(taskId), next),
  });

  useEffect(() => {
    const sub = AppState.addEventListener("change", (state) => setInForeground(state !== "background"));
    return () => sub.remove();
  }, []);

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
        setStreamError(null);
        setEmbed((prev) => (prev?.taskId === taskId && prev.url === url ? prev : { taskId, url }));
      },
      (error: unknown) => {
        if (current) setStreamError(error);
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
      if (message?.event === "status") {
        setViewerState(message.state);
      } else if (message?.event === "unreachable") {
        const now = Date.now();
        if (now - lastUnreachableRefresh.current < UNREACHABLE_REFRESH_MS) return;
        lastUnreachableRefresh.current = now;
        api.desktopSocketUrl(taskId, { fresh: true }).then(
          (ws) => webView.current?.postMessage({ type: "kestrel-desktop", ws }),
          () => {}
        );
      } else if (message?.event === "auth-expired") {
        const now = Date.now();
        if (now - lastAuthRefresh.current < AUTH_REFRESH_WINDOW_MS) {
          setStreamError(new Error("The desktop stream rejected a fresh sign-in. Stop and start the desktop to retry."));
          return;
        }
        lastAuthRefresh.current = now;
        api.desktopSocketUrl(taskId, { fresh: true }).then(
          (ws) => webView.current?.postMessage({ type: "kestrel-desktop", ws }),
          (error: unknown) => setStreamError(error)
        );
      }
    },
    [api, taskId]
  );

  const actionError = toggle.error ?? desktop.error ?? streamError;
  const error = actionError
    ? actionError instanceof Error
      ? actionError.message
      : String(actionError)
    : status?.error ?? null;

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
            {status.width}×{status.height} · {status.fps} fps{viewerState ? ` · ${viewerState}` : ""}
          </Text>
        ) : null}
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
  alert: { marginBottom: spacing.sm },
  well: { width: "100%", marginBottom: spacing.md, borderRadius: radius.xl, overflow: "hidden", backgroundColor: "#000" },
  webview: { flex: 1, backgroundColor: "#000" },
  placeholder: { flex: 1, alignItems: "center", justifyContent: "center" },
  placeholderText: { color: colors.mutedForeground, fontSize: 14, textAlign: "center" },
});
