import React, { useEffect, useState } from "react";
import { Alert, Text, TextInput, View } from "react-native";
import * as WebBrowser from "expo-web-browser";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import type { CliLoginStart, CliProvider, Connection } from "@cloudagents/protocol";
import { keys } from "@/api/queries";
import { useApiClient } from "@/hooks/useApiClient";
import { colors } from "@/theme";
import {
  ActionButton,
  ConnectionRowFrame,
  connectionStyles,
} from "@/components/ConnectionsShared";

/** While a codex sign-in is pending, connections are re-read at this interval until the box reports the login. */
const CLI_POLL_MS = 3000;

const CLI_INTRO: Record<CliProvider, string> = {
  "claude-cli": "Use your own Claude Pro or Max subscription.",
  "codex-cli": "Use your own ChatGPT subscription.",
};

interface Props {
  connection: Connection;
  provider: CliProvider;
}

/** Subscription logins of the official CLIs. The sign-in runs on the agent box; this row only relays the provider's own steps. */
export function ConnectionsCliRow({ connection, provider }: Props) {
  const { api } = useApiClient();
  const queryClient = useQueryClient();
  const [login, setLogin] = useState<CliLoginStart | null>(null);
  const [expired, setExpired] = useState(false);
  const [code, setCode] = useState("");

  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey: keys.connections });
  };

  const openPage = useMutation({
    mutationFn: (url: string) => WebBrowser.openBrowserAsync(url),
  });
  const submitCode = useMutation({
    mutationFn: (value: string) => api.cliLoginCode(provider, { code: value }),
    onSuccess: (status) => {
      // Keep the pending sign-in unless the box confirms it took; the user can retry or cancel.
      if (status.loggedIn) {
        setLogin(null);
        setCode("");
      }
      refresh();
    },
  });
  const logout = useMutation({
    mutationFn: () => api.cliLogout(provider),
    onSuccess: () => {
      setLogin(null);
      refresh();
    },
  });
  const start = useMutation({
    mutationFn: () => api.cliLoginStart(provider),
    onSuccess: (next) => {
      submitCode.reset();
      logout.reset();
      setLogin(next);
      setExpired(false);
      setCode("");
    },
  });

  const busy = start.isPending || submitCode.isPending || logout.isPending;
  const error = openPage.error ?? start.error ?? submitCode.error ?? logout.error;

  useEffect(() => {
    if (connection.connected) setLogin(null);
  }, [connection.connected]);

  useEffect(() => {
    if (!login) return;
    const id = setTimeout(() => setExpired(true), Math.max(0, Date.parse(login.expiresAt) - Date.now()));
    return () => clearTimeout(id);
  }, [login]);

  const polling = login?.provider === "codex-cli" && !expired && !connection.connected;
  useEffect(() => {
    if (!polling) return;
    const id = setInterval(() => {
      void queryClient.invalidateQueries({ queryKey: keys.connections });
    }, CLI_POLL_MS);
    return () => clearInterval(id);
  }, [polling, queryClient]);

  function cancel() {
    start.reset();
    submitCode.reset();
    setLogin(null);
    setCode("");
  }

  function confirmDisconnect() {
    Alert.alert("Disconnect this subscription?", "Agent runs will stop using it.", [
      { text: "Cancel", style: "cancel" },
      { text: "Disconnect", style: "destructive", onPress: () => logout.mutate() },
    ]);
  }

  function stepContent() {
    if (!connection.available) {
      return (
        <>
          <Text style={connectionStyles.muted}>Agent box is offline.</Text>
          <ActionButton label="Check again" tone="secondary" onPress={refresh} />
        </>
      );
    }
    if (connection.connected) {
      return (
        <>
          <Text style={connectionStyles.muted}>
            {connection.account ? `Signed in as ${connection.account}` : "Signed in"}
          </Text>
          <ActionButton label="Disconnect" tone="secondary" disabled={busy} onPress={confirmDisconnect} />
        </>
      );
    }
    if (login && expired) {
      return (
        <>
          <Text style={connectionStyles.muted}>This sign-in expired.</Text>
          <ActionButton label="Try again" disabled={busy} onPress={() => start.mutate()} />
        </>
      );
    }
    if (login?.needsCode) {
      return (
        <>
          <ActionButton
            label="Open sign-in page"
            tone="secondary"
            onPress={() => openPage.mutate(login.url)}
          />
          <Text style={connectionStyles.muted}>
            Sign in on Anthropic's page, then paste the code it shows you.
          </Text>
          <TextInput
            style={connectionStyles.input}
            value={code}
            onChangeText={setCode}
            placeholder="Code"
            placeholderTextColor={colors.mutedForeground}
            accessibilityLabel="Code from the Claude sign-in page"
            autoCapitalize="none"
            autoCorrect={false}
          />
          <View style={connectionStyles.actions}>
            <ActionButton
              label="Submit code"
              disabled={busy || code.trim().length === 0}
              onPress={() => submitCode.mutate(code.trim())}
            />
            <ActionButton label="Cancel" tone="secondary" onPress={cancel} />
          </View>
        </>
      );
    }
    if (login) {
      return (
        <>
          <ActionButton
            label="Open sign-in page"
            tone="secondary"
            onPress={() => openPage.mutate(login.url)}
          />
          <Text style={connectionStyles.muted}>Enter this code on the OpenAI page:</Text>
          {login.userCode ? (
            <Text selectable style={connectionStyles.code}>
              {login.userCode}
            </Text>
          ) : null}
          <Text style={connectionStyles.hint}>Waiting for you to approve the sign-in…</Text>
          <ActionButton label="Cancel" tone="secondary" onPress={cancel} />
        </>
      );
    }
    return (
      <>
        <Text style={connectionStyles.muted}>{CLI_INTRO[provider]}</Text>
        <ActionButton label="Connect" disabled={busy} onPress={() => start.mutate()} />
      </>
    );
  }

  return (
    <ConnectionRowFrame connection={connection} error={error}>
      {stepContent()}
    </ConnectionRowFrame>
  );
}
