import React, { useState, useRef } from "react";
import {
  View,
  Text,
  TextInput,
  Pressable,
  StyleSheet,
  ActivityIndicator,
  KeyboardAvoidingView,
  Platform,
  ScrollView,
  Modal,
  SafeAreaView,
} from "react-native";
import { WebView } from "react-native-webview";
import { useAuth } from "@/auth/AuthContext";
import { colors, radius, spacing } from "@/theme";

const SafeWebView = WebView as unknown as React.ComponentType<any>;

export function LoginScreen() {
  const { serverUrl, setServerUrl, setSessionCookie, setUser, loading, error } =
    useAuth();
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
  // Attempt mobile-callback first, falling back to /
  const loginUrl = `${currentServerUrl}/auth/github/login?return=/auth/mobile-callback`;

  const onNavigationStateChange = (navState: any) => {
    const currentUrl: string = navState.url;

    // Check for custom protocol redirect: kestrel://auth-callback?session=...
    if (currentUrl.startsWith("kestrel://") || currentUrl.includes("auth-callback")) {
      try {
        const parsed = new URL(currentUrl.replace("kestrel://", "http://placeholder/"));
        const session = parsed.searchParams.get("session");
        if (session) {
          setShowWebView(false);
          void setSessionCookie(session);
          return;
        }
      } catch {
        // Fall through
      }
    }
  };

  const injectedJavaScript = `
    (function() {
      // Check if user is on the main app page or api/me after auth
      if (window.location.pathname === '/' || window.location.pathname.startsWith('/api/me') || window.location.pathname.startsWith('/auth/mobile-callback')) {
        fetch('/api/me', { credentials: 'include' })
          .then(function(res) { return res.ok ? res.json() : null; })
          .then(function(user) {
            if (user && user.login) {
              window.ReactNativeWebView.postMessage(JSON.stringify({
                type: 'AUTH_SUCCESS',
                user: user,
                cookies: document.cookie
              }));
            }
          })
          .catch(function(e) {});
      }
    })();
    true;
  `;

  const onMessage = (event: any) => {
    try {
      const data = JSON.parse(event.nativeEvent.data);
      if (data.type === "AUTH_SUCCESS" && data.user) {
        setShowWebView(false);
        setUser(data.user);
        // If cookie has session=..., save it
        if (data.cookies) {
          const match = /session=([^;]+)/.exec(data.cookies);
          if (match && match[1]) {
            void setSessionCookie(match[1]);
          }
        }
      }
    } catch {
      // Ignore
    }
  };

  const handleManualTokenSubmit = () => {
    if (manualToken.trim()) {
      void setSessionCookie(manualToken.trim());
    }
  };

  return (
    <KeyboardAvoidingView
      style={styles.container}
      behavior={Platform.OS === "ios" ? "padding" : "height"}
    >
      <ScrollView
        contentContainerStyle={styles.content}
        keyboardShouldPersistTaps="handled"
      >
        <View style={styles.header}>
          <Text style={styles.title}>Kestrel</Text>
          <Text style={styles.subtitle}>
            Your Cloud Agent Harness & Desktop
          </Text>
        </View>

        <View style={styles.form}>
          <Text style={styles.label}>Server URL</Text>
          <TextInput
            style={styles.input}
            value={url}
            onChangeText={setUrl}
            placeholder="https://app.kestrel-agent.com"
            placeholderTextColor={colors.mutedForeground}
            autoCapitalize="none"
            autoCorrect={false}
            keyboardType="url"
            returnKeyType="done"
            onSubmitEditing={handleSetUrl}
            onBlur={handleSetUrl}
          />

          {error && (
            <View style={styles.errorBox}>
              <Text style={styles.errorText}>{error}</Text>
            </View>
          )}

          <Pressable
            style={[styles.signInBtn, loading && styles.btnDisabled]}
            onPress={() => {
              void handleSetUrl();
              setShowWebView(true);
            }}
            disabled={loading}
          >
            {loading ? (
              <ActivityIndicator color={colors.primaryForeground} />
            ) : (
              <Text style={styles.signInText}>Sign in with GitHub</Text>
            )}
          </Pressable>

          <Pressable
            style={styles.tokenToggle}
            onPress={() => setShowTokenInput(!showTokenInput)}
          >
            <Text style={styles.tokenToggleText}>
              {showTokenInput ? "Hide token sign-in" : "Sign in with session token directly"}
            </Text>
          </Pressable>

          {showTokenInput && (
            <View style={styles.tokenBox}>
              <Text style={styles.tokenHelp}>
                Paste the 'session' cookie token from your web browser:
              </Text>
              <TextInput
                style={styles.tokenInput}
                value={manualToken}
                onChangeText={setManualToken}
                placeholder="Session cookie value…"
                placeholderTextColor={colors.mutedForeground}
                autoCapitalize="none"
                autoCorrect={false}
              />
              <Pressable
                style={[
                  styles.tokenBtn,
                  !manualToken.trim() && styles.btnDisabled,
                ]}
                onPress={handleManualTokenSubmit}
                disabled={!manualToken.trim()}
              >
                <Text style={styles.tokenBtnText}>Authenticate Token</Text>
              </Pressable>
            </View>
          )}
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
            <Pressable
              onPress={() => setShowWebView(false)}
              style={styles.closeBtn}
            >
              <Text style={styles.closeBtnText}>Done</Text>
            </Pressable>
          </View>
          <SafeWebView
            source={{ uri: loginUrl }}
            style={styles.webview}
            onNavigationStateChange={onNavigationStateChange}
            injectedJavaScript={injectedJavaScript}
            onMessage={onMessage}
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
    flex: 1,
    justifyContent: "center",
    alignItems: "center",
    paddingHorizontal: spacing.xl,
    gap: spacing.xxl,
  },
  header: {
    alignItems: "center",
    gap: spacing.sm,
  },
  title: {
    fontSize: 34,
    fontWeight: "700",
    color: colors.foreground,
    letterSpacing: -0.5,
  },
  subtitle: {
    fontSize: 14,
    color: colors.mutedForeground,
    textAlign: "center",
    maxWidth: 280,
  },
  form: {
    width: "100%",
    maxWidth: 340,
    gap: spacing.md,
  },
  label: {
    color: colors.foreground,
    fontSize: 13,
    fontWeight: "500",
  },
  input: {
    backgroundColor: colors.secondary,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.md,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.md,
    color: colors.foreground,
    fontSize: 14,
  },
  errorBox: {
    backgroundColor: colors.destructive + "18",
    borderRadius: radius.md,
    padding: spacing.md,
  },
  errorText: {
    color: colors.destructive,
    fontSize: 13,
  },
  signInBtn: {
    backgroundColor: colors.primary,
    borderRadius: radius.md,
    paddingVertical: spacing.md + 2,
    alignItems: "center",
    marginTop: spacing.sm,
  },
  btnDisabled: {
    opacity: 0.5,
  },
  signInText: {
    color: colors.primaryForeground,
    fontSize: 16,
    fontWeight: "600",
  },
  tokenToggle: {
    alignItems: "center",
    paddingVertical: spacing.xs,
  },
  tokenToggleText: {
    color: colors.mutedForeground,
    fontSize: 12,
  },
  tokenBox: {
    backgroundColor: colors.card,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.border,
    padding: spacing.md,
    gap: spacing.sm,
  },
  tokenHelp: {
    color: colors.mutedForeground,
    fontSize: 11,
  },
  tokenInput: {
    backgroundColor: colors.background,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.sm,
    paddingHorizontal: spacing.sm,
    paddingVertical: spacing.xs + 2,
    color: colors.foreground,
    fontSize: 12,
    fontFamily: "monospace",
  },
  tokenBtn: {
    backgroundColor: colors.secondary,
    borderRadius: radius.sm,
    borderWidth: 1,
    borderColor: colors.border,
    paddingVertical: spacing.sm,
    alignItems: "center",
  },
  tokenBtnText: {
    color: colors.foreground,
    fontSize: 12,
    fontWeight: "600",
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
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.md,
  },
  modalTitle: {
    color: colors.foreground,
    fontSize: 16,
    fontWeight: "600",
  },
  closeBtn: {
    paddingVertical: 4,
    paddingHorizontal: spacing.sm,
  },
  closeBtnText: {
    color: colors.primary,
    fontSize: 15,
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
