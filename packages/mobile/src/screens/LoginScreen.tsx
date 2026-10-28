import React, { useState } from "react";
import { View, Text, StyleSheet, ActivityIndicator, ScrollView, Modal } from "react-native";
import { KeyboardAvoidingView } from "react-native-keyboard-controller";
import { SafeAreaView } from "react-native-safe-area-context";
import { WebView, type WebViewProps } from "react-native-webview";
import type { ShouldStartLoadRequest } from "react-native-webview/lib/WebViewTypes";
import { useAuth } from "@/auth/AuthContext";
import { KestrelMark } from "@/components/KestrelMark";
import { Alert } from "@/components/ui/Alert";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import { colors, fonts, radius } from "@/theme";

// The WebView class's generic props are not inferred through `React.ComponentType`; the props we pass are the public `WebViewProps`.
const SafeWebView = WebView as unknown as React.ComponentType<WebViewProps>;

/** Where the control plane's /auth/mobile-callback page sends the session id. */
const CALLBACK_PREFIX = "kestrel://auth-callback";
/**
 * The WebView must let `kestrel://` through its origin whitelist: otherwise it hands the URL to Linking before our
 * should-start callback runs, and Expo Go cannot open an app-specific scheme, so the session would be lost.
 */
const ORIGIN_WHITELIST = ["http://*", "https://*", "kestrel://*"];

export function LoginScreen() {
  const { serverUrl, setServerUrl, setSessionCookie, loading, error } = useAuth();
  const [url, setUrl] = useState(serverUrl ?? "https://app.kestrel-agent.com");
  const [showWebView, setShowWebView] = useState(false);
  const [showTokenInput, setShowTokenInput] = useState(false);
  const [manualToken, setManualToken] = useState("");

  const handleSetUrl = async () => {
    if (url.trim()) {
      await setServerUrl(url.trim());
    }
  };

  const currentServerUrl = serverUrl || url.trim() || "https://app.kestrel-agent.com";
  const loginUrl = `${currentServerUrl}/auth/github/login?return=/auth/mobile-callback`;

  /**
   * Catches the callback redirect inside the WebView: the session id comes from the URL, since the session cookie is
   * HttpOnly and unreadable from page JavaScript. The redirect itself is never loaded.
   */
  const onShouldStartLoadWithRequest = (request: ShouldStartLoadRequest): boolean => {
    if (!request.url.startsWith(CALLBACK_PREFIX)) return true;
    const session = new URL(request.url.replace("kestrel://", "http://callback/")).searchParams.get("session");
    setShowWebView(false);
    if (session) void setSessionCookie(session);
    return false;
  };

  const handleManualTokenSubmit = () => {
    if (manualToken.trim()) {
      void setSessionCookie(manualToken.trim());
    }
  };

  return (
    <KeyboardAvoidingView
      style={styles.container}
      behavior="padding"
    >
      <ScrollView
        contentContainerStyle={styles.content}
        keyboardShouldPersistTaps="handled"
      >
        <View style={styles.hero}>
          {/* The glow sits on a wrapper, as on the web: the mark itself has no background to cast it. */}
          <View style={styles.glow} accessibilityRole="header" accessibilityLabel="Kestrel">
            <KestrelMark height={64} />
          </View>
          <Text style={styles.tagline}>
            Run your own agent harness in a sandboxed cloud box with a live desktop.
          </Text>
        </View>

        <View style={styles.form}>
          <Text style={styles.label}>Server URL</Text>
          <Input
            value={url}
            onChangeText={setUrl}
            placeholder="https://app.kestrel-agent.com"
            autoCapitalize="none"
            autoCorrect={false}
            keyboardType="url"
            returnKeyType="done"
            onSubmitEditing={handleSetUrl}
            onBlur={handleSetUrl}
          />

          {error ? <Alert>{error}</Alert> : null}

          <Button
            size="lg"
            style={styles.centered}
            disabled={loading}
            onPress={() => {
              void handleSetUrl();
              setShowWebView(true);
            }}
          >
            {loading ? <ActivityIndicator color={colors.primaryForeground} /> : "Sign in with GitHub"}
          </Button>

          <Button
            variant="ghost"
            size="sm"
            style={styles.centered}
            onPress={() => setShowTokenInput(!showTokenInput)}
          >
            {showTokenInput ? "Hide token sign-in" : "Sign in with session token directly"}
          </Button>

          {showTokenInput ? (
            <View style={styles.tokenBox}>
              <Text style={styles.tokenHelp}>
                Paste the 'session' cookie token from your web browser:
              </Text>
              <Input
                style={styles.tokenInput}
                value={manualToken}
                onChangeText={setManualToken}
                placeholder="Session cookie value…"
                autoCapitalize="none"
                autoCorrect={false}
              />
              <Button
                variant="soft"
                disabled={!manualToken.trim()}
                onPress={handleManualTokenSubmit}
              >
                Authenticate Token
              </Button>
            </View>
          ) : null}
        </View>
      </ScrollView>

      {/* GitHub Auth WebView Modal */}
      <Modal
        visible={showWebView}
        animationType="slide"
        presentationStyle="pageSheet"
        onRequestClose={() => setShowWebView(false)}
      >
        <SafeAreaView style={styles.modalContainer}>
          <View style={styles.modalHeader}>
            <Text style={styles.modalTitle}>Sign in with GitHub</Text>
            <Button variant="soft" size="sm" onPress={() => setShowWebView(false)}>
              Done
            </Button>
          </View>
          <SafeWebView
            source={{ uri: loginUrl }}
            style={styles.webview}
            originWhitelist={ORIGIN_WHITELIST}
            onShouldStartLoadWithRequest={onShouldStartLoadWithRequest}
            sharedCookiesEnabled
            thirdPartyCookiesEnabled
            javaScriptEnabled
            domStorageEnabled
            startInLoadingState
            renderLoading={() => (
              <View style={styles.loadingOverlay}>
                <ActivityIndicator size="large" color={colors.primary} />
              </View>
            )}
          />
        </SafeAreaView>
      </Modal>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: colors.background,
  },
  content: {
    flexGrow: 1,
    justifyContent: "center",
    alignItems: "center",
    padding: 24,
    gap: 24,
  },
  hero: {
    alignItems: "center",
    gap: 12,
  },
  /** `drop-shadow-[0_0_24px_rgb(255_255_255/0.25)]`: a white glow behind the mark. */
  glow: {
    shadowColor: "#ffffff",
    shadowOpacity: 0.25,
    shadowRadius: 12,
    shadowOffset: { width: 0, height: 0 },
  },
  tagline: {
    maxWidth: 340,
    color: colors.mutedForeground,
    fontSize: 14,
    textAlign: "center",
  },
  form: {
    width: "100%",
    maxWidth: 340,
    gap: 12,
  },
  label: {
    color: colors.foreground,
    fontSize: 14,
    fontWeight: "500",
  },
  centered: {
    alignSelf: "center",
  },
  tokenBox: {
    backgroundColor: colors.card,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.border,
    padding: 12,
    gap: 8,
  },
  tokenHelp: {
    color: colors.mutedForeground,
    fontSize: 12,
  },
  tokenInput: {
    fontFamily: fonts.mono,
    fontSize: 12,
  },
  modalContainer: {
    flex: 1,
    backgroundColor: colors.background,
  },
  modalHeader: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    backgroundColor: colors.card,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
    paddingHorizontal: 16,
    paddingVertical: 12,
  },
  modalTitle: {
    color: colors.foreground,
    fontSize: 16,
    fontWeight: "600",
  },
  webview: {
    flex: 1,
    backgroundColor: colors.background,
  },
  loadingOverlay: {
    position: "absolute",
    top: 0,
    bottom: 0,
    left: 0,
    right: 0,
    justifyContent: "center",
    alignItems: "center",
    backgroundColor: colors.background,
  },
});
