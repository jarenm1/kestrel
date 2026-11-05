import React, { useEffect, useState } from "react";
import { Text, View } from "react-native";
import * as WebBrowser from "expo-web-browser";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { MODEL_PROVIDERS, type CliLoginStart, type CliProvider, type Connection } from "@cloudagents/protocol";
import { confirmDestructive } from "@/lib/confirm";
import { useApiClient } from "@/hooks/useApiClient";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import { ModelPicker } from "@/components/ConnectionsModelPicker";
import {
  CLI_INTRO,
  ConnectionRowFrame,
  connectionStyles,
  harnessForConnection,
  invalidateConnections,
} from "@/components/ConnectionsShared";

/** While a device-code sign-in is pending, connections are re-read at this interval until the box reports the login. */
const CLI_POLL_MS = 3000;

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
  // The harness's own mark and the provider whose chat models this sign-in unlocks.
  const harness = harnessForConnection(connection.provider);
  const modelProvider = MODEL_PROVIDERS.find(
    (candidate) =>
      candidate.id === connection.provider || candidate.connections.includes(connection.provider)
  );

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
      invalidateConnections(queryClient, api.boxScope);
    },
  });
  const logout = useMutation({
    mutationFn: () => api.cliLogout(provider),
    onSuccess: () => {
      setLogin(null);
      invalidateConnections(queryClient, api.boxScope);
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

  // A device-code sign-in finishes on the provider's page, so only a re-read shows it.
  const polling = login !== null && !login.needsCode && !expired && !connection.connected;
  useEffect(() => {
    if (!polling) return;
    const id = setInterval(() => {
      invalidateConnections(queryClient, api.boxScope);
    }, CLI_POLL_MS);
    return () => clearInterval(id);
  }, [polling, queryClient, api.boxScope]);

  function cancel() {
    start.reset();
    submitCode.reset();
    logout.reset();
    setLogin(null);
    setCode("");
  }

  function confirmDisconnect() {
    confirmDestructive("Disconnect this subscription?", "Agent runs will stop using it.", "Disconnect", () =>
      logout.mutate()
    );
  }

  function stepContent() {
    if (!connection.available) {
      return (
        <>
          <Text style={connectionStyles.muted}>{connection.error ?? "Agent box is offline."}</Text>
          <Button
            variant="soft"
            style={connectionStyles.fit}
            onPress={() => invalidateConnections(queryClient, api.boxScope)}
          >
            Check again
          </Button>
        </>
      );
    }
    if (connection.connected) {
      return (
        <>
          <Text style={connectionStyles.muted}>
            {connection.account ? `Signed in as ${connection.account}` : "Signed in"}
          </Text>
          <Button variant="soft" style={connectionStyles.fit} disabled={busy} onPress={confirmDisconnect}>
            Disconnect
          </Button>
        </>
      );
    }
    if (login && expired) {
      return (
        <>
          <Text style={connectionStyles.muted}>This sign-in expired.</Text>
          <Button style={connectionStyles.fit} disabled={busy} onPress={() => start.mutate()}>
            Try again
          </Button>
        </>
      );
    }
    if (login?.needsCode) {
      return (
        <>
          <Button
            variant="soft"
            style={connectionStyles.fit}
            onPress={() => openPage.mutate(login.url)}
          >
            Open sign-in page
          </Button>
          <Text style={connectionStyles.muted}>
            Sign in on that page, then paste the code it shows you.
          </Text>
          <Input
            value={code}
            onChangeText={setCode}
            placeholder="Code"
            accessibilityLabel="Code from the sign-in page"
            autoCapitalize="none"
            autoCorrect={false}
          />
          <View style={connectionStyles.actions}>
            <Button
              disabled={busy || code.trim().length === 0}
              onPress={() => submitCode.mutate(code.trim())}
            >
              Submit code
            </Button>
            <Button variant="soft" onPress={cancel}>
              Cancel
            </Button>
          </View>
        </>
      );
    }
    if (login) {
      return (
        <>
          <Button
            variant="soft"
            style={connectionStyles.fit}
            onPress={() => openPage.mutate(login.url)}
          >
            Open sign-in page
          </Button>
          <Text style={connectionStyles.muted}>Enter this code on the sign-in page:</Text>
          <View style={connectionStyles.actions}>
            {login.userCode ? (
              <Text selectable style={connectionStyles.code}>
                {login.userCode}
              </Text>
            ) : null}
            <Button variant="ghost" size="sm" onPress={cancel}>
              Cancel
            </Button>
          </View>
          <Text style={connectionStyles.hint}>Waiting for you to approve the sign-in…</Text>
        </>
      );
    }
    return (
      <>
        <Text style={connectionStyles.muted}>{CLI_INTRO[provider]}</Text>
        <Button style={connectionStyles.fit} disabled={busy} onPress={() => start.mutate()}>
          Connect
        </Button>
      </>
    );
  }

  return (
    <ConnectionRowFrame
      connection={connection}
      error={error}
      harness={harness}
      showAccount={false}
      headerExtra={modelProvider ? <ModelPicker provider={modelProvider} /> : undefined}
    >
      {stepContent()}
    </ConnectionRowFrame>
  );
}
