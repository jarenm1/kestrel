import React, { useEffect, useRef, useState } from "react";
import { ActivityIndicator, StyleSheet, Text, View } from "react-native";
import { WebView } from "react-native-webview";
import { RefreshCw } from "lucide-react-native";
import { Paths } from "@cloudagents/protocol";
import { useApiClient } from "@/hooks/useApiClient";
import { Alert } from "@/components/ui/Alert";
import { Button } from "@/components/ui/Button";
import { colors, fonts, radius, spacing } from "@/theme";

const SafeWebView = WebView as unknown as React.ComponentType<any>;

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
  const { api, serverUrl } = useApiClient();
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

  const previewUrl = previewToken ? serverUrl + Paths.taskPreviewFrame(previewToken, taskId) : undefined;

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
            source={{ uri: previewUrl }}
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

