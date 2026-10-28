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

  // Minimal MSE page for the desktop fMP4 stream. Every binary frame (init or fragment) goes into one
  // FIFO that is drained only while the SourceBuffer is idle: dropping a fragment corrupts H.264 decoding.
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
    const KEEP_BEHIND_S = 10;
    const LIVE_EDGE_S = 0.5;
    const CATCH_UP_S = 0.08;
    const ws = new WebSocket("${wsUrl}");
    ws.binaryType = "arraybuffer";
    const video = document.getElementById("v");
    const statusEl = document.getElementById("s");
    let ms = null, sb = null, mime = null;
    const queue = [];

    function pump() {
      if (!sb || sb.updating) return;
      const ranges = sb.buffered;
      if (ranges.length > 0 && video.currentTime - KEEP_BEHIND_S > ranges.start(0)) {
        sb.remove(0, video.currentTime - KEEP_BEHIND_S);
        return;
      }
      const chunk = queue.shift();
      if (!chunk) return;
      try {
        sb.appendBuffer(chunk);
      } catch (e) {
        queue.unshift(chunk);
        const from = ranges.length > 0 ? ranges.start(0) : 0;
        if (video.currentTime - 1 > from) sb.remove(from, video.currentTime - 1);
        else statusEl.textContent = String(e);
      }
    }

    // Chase the live edge and recover from timestamp gaps. Underrun at the end of the last range is
    // left alone: the playhead then waits for more data. A small lag is caught up by playing slightly
    // fast (no visible jump); only a large lag seeks.
    function follow() {
      if (!sb || sb.buffered.length === 0) return;
      const b = sb.buffered;
      const last = b.length - 1;
      const t = video.currentTime;
      let inside = false;
      for (let i = 0; i < b.length; i++) if (t >= b.start(i) && t < b.end(i)) inside = true;
      if (!inside) {
        for (let i = 0; i < b.length; i++) {
          if (b.start(i) > t) { video.currentTime = b.start(i); return; }
        }
      }
      const lag = b.end(last) - t;
      if (lag > LIVE_EDGE_S) video.currentTime = b.end(last) - 0.05;
      else video.playbackRate = lag > CATCH_UP_S ? 1.25 : 1;
    }

    function start() {
      if (ms || !mime) return;
      if (!MediaSource.isTypeSupported(mime)) {
        statusEl.textContent = "cannot play " + mime;
        return;
      }
      ms = new MediaSource();
      video.src = URL.createObjectURL(ms);
      ms.addEventListener("sourceopen", function() {
        sb = ms.addSourceBuffer(mime);
        sb.addEventListener("updateend", function() { follow(); pump(); });
        pump();
      });
    }

    ws.onmessage = function(e) {
      if (typeof e.data === "string") {
        try {
          const st = JSON.parse(e.data);
          if (st.state === "running" && st.mime) {
            mime = st.mime;
            statusEl.textContent = "";
            start();
          } else {
            statusEl.textContent = st.state || "";
          }
        } catch (err) {}
        return;
      }
      queue.push(new Uint8Array(e.data));
      start();
      pump();
    };

    ws.onclose = function() {
      statusEl.textContent = "disconnected";
    };

    video.addEventListener("waiting", follow);
    setInterval(follow, 100);
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

