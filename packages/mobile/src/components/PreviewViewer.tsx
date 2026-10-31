import React, { useEffect, useRef, useState } from "react";
import { ActivityIndicator, StyleSheet, Text, View } from "react-native";
import { WebView } from "react-native-webview";
import { RefreshCw } from "lucide-react-native";
import { useApiClient } from "@/hooks/useApiClient";
import { Alert } from "@/components/ui/Alert";
import { Button } from "@/components/ui/Button";
import { colors, fonts, radius, spacing } from "@/theme";

const SafeWebView = WebView as unknown as React.ComponentType<any>;

/**
 * Wraps the preview URL in an iframe with the same sandbox as the web viewer. Without `allow-same-origin`
 * the frame gets an opaque origin, so dev-server scripts cannot reach the app's origin or its data.
 */
function previewFrameHtml(src: string): string {
  const attr = src.replace(/[&"'<>]/g, (char) => `&#${char.charCodeAt(0)};`);
  return `<!DOCTYPE html><html><head><meta name="viewport" content="width=device-width, initial-scale=1"><style>html,body,iframe{margin:0;padding:0;width:100%;height:100%;border:0;background:#ffffff}</style></head><body><iframe src="${attr}" sandbox="allow-scripts allow-forms" referrerpolicy="strict-origin-when-cross-origin"></iframe></body></html>`;
}

/**
 * Sandboxed browser view for a dev server opened by the task's MCP preview tool.
 */
export function PreviewViewer({
  taskId,
  port,
}: {
  taskId: string;
  port: number | undefined;
}) {
  const { api } = useApiClient();
  const [previewToken, setPreviewToken] = useState<string>();
  const [sessionError, setSessionError] = useState<string>();
  const [generation, setGeneration] = useState(0);
  const webViewRef = useRef<{ reload(): void } | null>(null);

  useEffect(() => {
    setPreviewToken(undefined);
    setSessionError(undefined);
    if (port === undefined) return;
    let active = true;
    void api.previewSession(taskId).then(
      ({ token }) => {
        if (active) setPreviewToken(token);
      },
      (error: unknown) => {
        if (active) setSessionError(error instanceof Error ? error.message : String(error));
      }
    );
    return () => {
      active = false;
    };
  }, [api, taskId, port, generation]);

  if (port === undefined) {
    return (
      <View style={styles.empty}>
        <Text style={styles.emptyText}>
          Start the app in this thread and have the agent open its preview to see it here.
        </Text>
      </View>
    );
  }

  const previewUrl = previewToken ? api.previewFrameUrl(taskId, previewToken) : undefined;

  return (
    <View style={styles.container}>
      <View style={styles.toolbar}>
        <Button
          variant="ghost"
          size="sm"
          icon={RefreshCw}
          onPress={() => {
            setGeneration((v) => v + 1);
            webViewRef.current?.reload();
          }}
        >
          Reload
        </Button>
        <Text style={styles.portText}>Port {port}</Text>
      </View>
      {sessionError ? <Alert style={styles.alert}>{sessionError}</Alert> : null}
      <View style={styles.frame}>
        {previewUrl ? (
          <SafeWebView
            ref={webViewRef}
            source={{ html: previewFrameHtml(previewUrl) }}
            style={styles.webview}
            javaScriptEnabled
            domStorageEnabled
          />
        ) : (
          <View style={styles.loading}>
            <ActivityIndicator color={colors.mutedForeground} />
          </View>
        )}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, paddingHorizontal: spacing.md, paddingBottom: spacing.md },
  toolbar: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", paddingVertical: spacing.sm },
  portText: { color: colors.mutedForeground, fontSize: 12, fontFamily: fonts.mono },
  alert: { marginBottom: spacing.sm },
  frame: { flex: 1, borderRadius: radius.xl, overflow: "hidden", backgroundColor: "#ffffff" },
  webview: { flex: 1 },
  loading: { flex: 1, alignItems: "center", justifyContent: "center", backgroundColor: colors.card },
  empty: { flex: 1, alignItems: "center", justifyContent: "center", padding: spacing.xl },
  emptyText: { color: colors.mutedForeground, fontSize: 14, textAlign: "center", lineHeight: 20 },
});

