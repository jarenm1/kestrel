import React, { useCallback, useMemo, useRef, useState } from "react";
import {
  View,
  Text,
  StyleSheet,
  Pressable,
  Dimensions,
  ActivityIndicator,
} from "react-native";
import { WebView } from "react-native-webview";
const SafeWebView = WebView as unknown as React.ComponentType<any>;
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useApiClient } from "@/hooks/useApiClient";
import { createQueries, keys } from "@/api/queries";
import { StatusBadge } from "./StatusBadge";
import { colors, radius, spacing } from "@/theme";
import type { DesktopStatus } from "@/api/types";

/**
 * Desktop viewer for mobile — renders the desktop stream in a WebView.
 * The desktop stream uses fMP4 over WebSocket + MediaSource Extensions,
 * which isn't natively supported in React Native, so we use a minimal
 * HTML page inside a WebView to handle video playback.
 */
export function DesktopViewer({ taskId }: { taskId: string }) {
  const { api, serverUrl } = useApiClient();
  const queryClient = useQueryClient();
  const queries = useMemo(() => createQueries(api), [api]);
  const desktop = useQuery(queries.desktop(taskId));
  const status = desktop.data ?? null;

  const active = status?.state === "running" || status?.state === "starting";

  const toggle = useMutation({
    mutationFn: async (): Promise<DesktopStatus> => {
      if (!active) return api.startDesktop(taskId);
      await api.stopDesktop(taskId);
      return api.getDesktop(taskId);
    },
    onSuccess: (next) => queryClient.setQueryData(keys.desktop(taskId), next),
  });

  // Build a minimal HTML page that connects to the desktop WebSocket stream.
  // This runs MediaSource Extensions inside the WebView which supports them.
  const desktopHtml = useMemo(() => {
    if (!serverUrl || !status || status.state !== "running") return null;

    const wsUrl = serverUrl.replace(/^http/, "ws") + `/api/tasks/${taskId}/desktop/stream`;

    return `
<!DOCTYPE html>
<html>
<head>
  <meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1">
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body { background: #000; display: flex; align-items: center; justify-content: center; height: 100vh; overflow: hidden; }
    video { width: 100%; height: 100%; object-fit: contain; }
    .status { position: absolute; top: 50%; left: 50%; transform: translate(-50%,-50%); color: #8a93a6; font-family: system-ui; }
  </style>
</head>
<body>
  <video id="v" muted autoplay playsinline></video>
  <div id="s" class="status"></div>
  <script>
    const ws = new WebSocket("${wsUrl}");
    ws.binaryType = "arraybuffer";
    const video = document.getElementById("v");
    const statusEl = document.getElementById("s");
    let ms, sb, mime, inited = false;

    ws.onmessage = function(e) {
      if (typeof e.data === "string") {
        try {
          const st = JSON.parse(e.data);
          if (st.state === "running" && st.mime) {
            mime = st.mime;
            statusEl.textContent = "";
          } else {
            statusEl.textContent = st.state || "";
          }
        } catch(e) {}
        return;
      }
      if (!inited && mime && MediaSource.isTypeSupported(mime)) {
        inited = true;
        ms = new MediaSource();
        video.src = URL.createObjectURL(ms);
        ms.addEventListener("sourceopen", function() {
          sb = ms.addSourceBuffer(mime);
          sb.mode = "sequence";
          sb.appendBuffer(new Uint8Array(e.data));
        });
        return;
      }
      if (sb && !sb.updating) {
        try { sb.appendBuffer(new Uint8Array(e.data)); } catch(e) {}
      }
    };

    ws.onclose = function() {
      statusEl.textContent = "disconnected";
    };
  </script>
</body>
</html>`;
  }, [serverUrl, taskId, status?.state]);

  const actionError = toggle.error ?? desktop.error;
  const error = actionError
    ? actionError instanceof Error
      ? actionError.message
      : String(actionError)
    : status?.error ?? null;

  return (
    <View style={styles.container}>
      <View style={styles.toolbar}>
        <Pressable
          style={[styles.toggleBtn, active && styles.toggleBtnActive]}
          onPress={() => toggle.mutate()}
          disabled={toggle.isPending || !status}
        >
          <Text style={[styles.toggleText, active && styles.toggleTextActive]}>
            {active ? "Stop" : "Start"}
          </Text>
        </Pressable>
        {status && <StatusBadge status={status.state} />}
        {status?.state === "running" && (
          <Text style={styles.info}>
            {status.width}×{status.height} · {status.fps} fps
          </Text>
        )}
      </View>
      {error && (
        <View style={styles.errorBar}>
          <Text style={styles.errorText}>{error}</Text>
        </View>
      )}
      <View style={styles.videoContainer}>
        {status?.state === "running" && desktopHtml ? (
          <SafeWebView
            source={{ html: desktopHtml }}
            style={styles.webview}
            javaScriptEnabled
            mediaPlaybackRequiresUserAction={false}
            allowsInlineMediaPlayback
            scrollEnabled={false}
          />
        ) : (
          <View style={styles.placeholder}>
            {toggle.isPending ? (
              <ActivityIndicator color={colors.mutedForeground} />
            ) : (
              <Text style={styles.placeholderText}>
                {status?.state ?? "loading"}
              </Text>
            )}
          </View>
        )}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: colors.background,
  },
  toolbar: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.sm,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
  },
  toggleBtn: {
    backgroundColor: colors.primary,
    borderRadius: radius.md,
    paddingHorizontal: spacing.md,
    paddingVertical: 4,
  },
  toggleBtnActive: {
    backgroundColor: "transparent",
    borderWidth: 1,
    borderColor: colors.border,
  },
  toggleText: {
    color: colors.primaryForeground,
    fontSize: 12,
    fontWeight: "600",
  },
  toggleTextActive: {
    color: colors.foreground,
  },
  info: {
    color: colors.mutedForeground,
    fontSize: 11,
    fontFamily: "monospace",
  },
  errorBar: {
    backgroundColor: colors.destructive + "18",
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.xs,
  },
  errorText: {
    color: colors.destructive,
    fontSize: 12,
  },
  videoContainer: {
    flex: 1,
    backgroundColor: "#000",
  },
  webview: {
    flex: 1,
    backgroundColor: "#000",
  },
  placeholder: {
    flex: 1,
    justifyContent: "center",
    alignItems: "center",
  },
  placeholderText: {
    color: colors.mutedForeground,
    fontSize: 14,
  },
});

