import React, { useEffect, useState } from "react";
import { Pressable, Text, View } from "react-native";
import * as WebBrowser from "expo-web-browser";
import { ChevronDown, Plus } from "lucide-react-native";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { MODEL_PROVIDERS, type CliLoginStart, type CliProvider, type Connection } from "@cloudagents/protocol";
import { confirmDestructive } from "@/lib/confirm";
import { useApiClient } from "@/hooks/useApiClient";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import { ModelPicker } from "@/components/ConnectionsModelPicker";
import { PickerSheet } from "@/components/PickerSheet";
import { colors } from "@/theme";
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
  const [loginOrigin, setLoginOrigin] = useState({ connected: false, account: null as string | null });
  const [expired, setExpired] = useState(false);
  const [code, setCode] = useState("");
  const [accountMenu, setAccountMenu] = useState(false);
  const [disconnectMenu, setDisconnectMenu] = useState(false);
  // The harness's own mark and the provider whose chat models this sign-in unlocks.
  const harness = harnessForConnection(connection.provider);
  const modelProvider = MODEL_PROVIDERS.find(
    (candidate) =>
      candidate.id === connection.provider || candidate.connections.includes(connection.provider)
  );
  // Older boxes report one login without the account list; keep its Disconnect menu working.
  const accounts: readonly { id: string; account: string | null }[] = connection.accounts?.length
    ? connection.accounts
    : connection.connected
      ? [{ id: connection.activeAccountId ?? "default", account: connection.account }]
      : [];
  const activeAccountId = connection.activeAccountId
    ?? accounts.find((account) => account.account === connection.account)?.id
    ?? accounts[0]?.id;
  // The account a sign-in is adding; another login may already keep the connection connected.
  const pendingAccountId = login?.accountId;
  const completed = login !== null && (pendingAccountId === undefined
    ? connection.connected && (!loginOrigin.connected || connection.account !== loginOrigin.account)
    : connection.accounts?.some((account) => account.id === pendingAccountId) === true);

  const openPage = useMutation({
    mutationFn: (url: string) => WebBrowser.openBrowserAsync(url),
  });
  const submitCode = useMutation({
    mutationFn: (value: string) =>
      api.cliLoginCode(provider, {
        code: value,
        ...(pendingAccountId === undefined ? {} : { accountId: pendingAccountId }),
      }),
    onSuccess: (status) => {
      // Keep the pending sign-in unless the box confirms it took; the user can retry or cancel.
      const done = pendingAccountId === undefined
        ? status.loggedIn
        : status.accounts?.some((account) => account.id === pendingAccountId) === true;
      if (done) {
        setLogin(null);
        setCode("");
      }
      invalidateConnections(queryClient, api.boxScope);
    },
  });
  const logout = useMutation({
    mutationFn: (accountId?: string) => api.cliLogout(provider, accountId),
    onSuccess: () => {
      setLogin(null);
      invalidateConnections(queryClient, api.boxScope);
    },
  });
  const select = useMutation({
    mutationFn: (accountId: string) => api.cliSelectAccount(provider, accountId),
    onSuccess: () => invalidateConnections(queryClient, api.boxScope),
  });
  const start = useMutation({
    mutationFn: () => api.cliLoginStart(provider),
    // Older boxes have no attempt id: an unchanged existing login is not completion of this attempt.
    onMutate: () => setLoginOrigin({ connected: connection.connected, account: connection.account }),
    onSuccess: (next) => {
      submitCode.reset();
      logout.reset();
      select.reset();
      cancelLogin.reset();
      setLogin(next);
      setExpired(false);
      setCode("");
    },
  });
  // Backing out must stop the CLI on the box too; otherwise it could finish and add the account after the cancel.
  const cancelLogin = useMutation({
    mutationFn: () => api.cliLoginCancel(provider),
    onSuccess: () => invalidateConnections(queryClient, api.boxScope),
  });
  const busy = start.isPending || submitCode.isPending || logout.isPending || select.isPending;
  const error = openPage.error ?? start.error ?? submitCode.error ?? logout.error ?? select.error ?? cancelLogin.error;

  // The pending account appearing in the box's list is the completion signal, which a second account never blurs.
  useEffect(() => {
    if (!completed) return;
    setLogin(null);
    setCode("");
  }, [completed]);

  useEffect(() => {
    if (!login) return;
    const id = setTimeout(() => setExpired(true), Math.max(0, Date.parse(login.expiresAt) - Date.now()));
    return () => clearTimeout(id);
  }, [login]);

  // A device-code sign-in finishes on the provider's page, so only a re-read shows it.
  const polling = login !== null && !login.needsCode && !expired && !completed;
  useEffect(() => {
    if (!polling) return;
    const id = setInterval(() => {
      invalidateConnections(queryClient, api.boxScope);
    }, CLI_POLL_MS);
    return () => clearInterval(id);
  }, [polling, queryClient, api.boxScope]);

  function cancel() {
    cancelLogin.mutate();
    start.reset();
    submitCode.reset();
    logout.reset();
    select.reset();
    setAccountMenu(false);
    setDisconnectMenu(false);
    setLogin(null);
    setCode("");
  }

  function confirmDisconnect(accountId: string) {
    confirmDestructive("Disconnect this subscription?", "Agent runs will stop using it.", "Disconnect", () =>
      logout.mutate(accountId)
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
    if (login && expired) {
      return (
        <>
          <Text style={connectionStyles.muted}>This sign-in expired.</Text>
          <View style={connectionStyles.actions}>
            <Button style={connectionStyles.fit} disabled={busy} onPress={() => start.mutate()}>
              Try again
            </Button>
            {connection.connected ? (
              <Button variant="soft" style={connectionStyles.fit} onPress={cancel}>
                Cancel
              </Button>
            ) : null}
          </View>
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
    if (connection.connected) {
      return (
        <>
          {accounts.length > 1 ? (
            <Pressable
              style={connectionStyles.actions}
              accessibilityRole="button"
              accessibilityLabel="Switch account"
              disabled={busy}
              accessibilityState={{ disabled: busy }}
              onPress={() => setAccountMenu(true)}
            >
              <Text style={connectionStyles.muted}>
                {connection.account ? `Signed in as ${connection.account}` : "Signed in"}
              </Text>
              <ChevronDown size={14} color={colors.mutedForeground} />
            </Pressable>
          ) : (
            <Text style={connectionStyles.muted}>
              {connection.account ? `Signed in as ${connection.account}` : "Signed in"}
            </Text>
          )}
          <View style={connectionStyles.actions}>
            <Button
              variant="soft"
              style={connectionStyles.fit}
              disabled={busy}
              onPress={() => setDisconnectMenu(true)}
            >
              Disconnect
            </Button>
            <Button
              variant="soft"
              size="icon"
              icon={Plus}
              disabled={busy}
              accessibilityLabel="Sign in to another account"
              onPress={() => start.mutate()}
            />
          </View>
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
    <>
      <ConnectionRowFrame
        connection={connection}
        error={error}
        harness={harness}
        showAccount={false}
        headerExtra={modelProvider ? <ModelPicker provider={modelProvider} /> : undefined}
      >
        {stepContent()}
      </ConnectionRowFrame>
      <PickerSheet
        open={accountMenu && accounts.length > 1}
        onClose={() => setAccountMenu(false)}
        title={connection.label}
        options={accounts.map((account, index) => ({
          key: account.id,
          label: account.account ?? `Account ${index + 1}`,
        }))}
        selected={activeAccountId}
        onSelect={(accountId) => {
          if (accountId !== activeAccountId) select.mutate(accountId);
        }}
      />
      <PickerSheet
        open={disconnectMenu}
        onClose={() => setDisconnectMenu(false)}
        title={connection.label}
        options={accounts.map((account, index) => ({
          key: account.id,
          label: account.account ?? `Account ${index + 1}`,
        }))}
        selected={undefined}
        onSelect={confirmDisconnect}
      />
    </>
  );
}
