import React, { useMemo } from "react";
import { Image, Linking, Platform, StyleSheet, Text, View } from "react-native";
import { useQuery } from "@tanstack/react-query";
import { ControlPaths } from "@cloudagents/protocol";
import ExternalLink from "lucide-react-native/icons/external-link";
import LogOut from "lucide-react-native/icons/log-out";
import { createQueries } from "@/api/queries";
import { useAuth } from "@/auth/AuthContext";
import { SettingsDivider, SettingsPage, SettingsRow, SettingsSectionHeader } from "@/components/SettingsPage";
import { Alert } from "@/components/ui/Alert";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import { useApiClient } from "@/hooks/useApiClient";
import { errorText } from "@/lib/format";
import { colors, fonts, spacing } from "@/theme";

/** Where the web app's OAuth callback returns after connecting GitHub; the desktop uses the same path. */
const GITHUB_RETURN_PATH = "/settings/profile";

/**
 * The signed-in account: GitHub identity, repository access and sign-out. The web app's `ProfileSettings` without its
 * browser-only turn-sound card (the mobile app plays no turn sounds, so the preference would have nothing to control).
 */
export function ProfileScreen() {
  const { user, serverUrl, signOut } = useAuth();
  const { api } = useApiClient();
  const queries = useMemo(() => createQueries(api), [api]);
  const connections = useQuery(queries.connections());
  const github = connections.data?.find((connection) => connection.provider === "github");
  const web = Platform.OS === "web";
  const connectUrl =
    github === undefined || serverUrl === null
      ? null
      : `${serverUrl}${ControlPaths.connectOAuth(github.provider)}?return=${GITHUB_RETURN_PATH}`;

  /** On the web the OAuth callback returns to this page, so the browser leaves and comes back to it (as on desktop). */
  function connect() {
    if (connectUrl === null || serverUrl === null) return;
    if (web) window.location.assign(connectUrl);
    else void Linking.openURL(`${serverUrl}${GITHUB_RETURN_PATH}`);
  }

  if (!user) return null;

  return (
    <SettingsPage title="Profile" description="Your Kestrel account comes from GitHub.">
      <View style={styles.body}>
        <Card style={styles.profileCard}>
          {user.avatarUrl ? (
            <Image source={{ uri: user.avatarUrl }} style={styles.avatar} accessibilityIgnoresInvertColors />
          ) : (
            <View style={[styles.avatar, styles.avatarPlaceholder]}>
              <Text style={styles.avatarLetter}>{user.login.slice(0, 1).toUpperCase()}</Text>
            </View>
          )}
          <View style={styles.identity}>
            <Text style={styles.name} numberOfLines={1}>
              {user.name ?? user.login}
            </Text>
            <Text style={styles.login} numberOfLines={1}>
              @{user.login}
            </Text>
          </View>
          <Button
            variant="soft"
            size="sm"
            icon={ExternalLink}
            accessibilityLabel={`Open github.com/${user.login}`}
            onPress={() => void Linking.openURL(`https://github.com/${user.login}`)}
          >
            GitHub profile
          </Button>
        </Card>

        <Card style={styles.detailsCard}>
          <SettingsRow label="Name">
            <Text style={user.name === null ? styles.mutedValue : styles.value}>
              {user.name ?? "Not set on GitHub"}
            </Text>
          </SettingsRow>
          <SettingsDivider />
          <SettingsRow label="Username">
            <Text style={[styles.value, styles.mono]}>{user.login}</Text>
          </SettingsRow>
          <SettingsDivider />
          <SettingsRow label="Sign-in">
            <Badge variant="success">github</Badge>
          </SettingsRow>
        </Card>

        <Text style={styles.hint}>Name and avatar update from GitHub each time you sign in.</Text>

        <SettingsSectionHeader
          title="GitHub access"
          description="Let Kestrel work with your GitHub repositories."
        />
        <Card style={styles.accessCard}>
          <View style={styles.accessHead}>
            <Text style={styles.accessLabel}>GitHub</Text>
            {github !== undefined ? (
              <Badge variant={github.expired ? "warning" : github.connected ? "success" : "neutral"}>
                {github.expired ? "expired" : github.connected ? "connected" : "not connected"}
              </Badge>
            ) : null}
            {github?.account !== null && github?.account !== undefined ? (
              <Text style={styles.account} numberOfLines={1}>
                {github.account}
              </Text>
            ) : null}
          </View>
          {github?.expired ? (
            <Alert variant="warning">
              GitHub no longer accepts Kestrel's access, so agents cannot fetch or push repositories.
            </Alert>
          ) : null}
          {connections.error ? <Alert>{errorText(connections.error)}</Alert> : null}
          {connections.isPending ? <Text style={styles.mutedValue}>Loading GitHub access…</Text> : null}
          {github !== undefined && !github.available ? (
            <Text style={styles.mutedValue}>GitHub access needs server configuration.</Text>
          ) : null}
          {github?.available ? (
            web ? (
              <Button variant="soft" onPress={connect} style={styles.accessButton}>
                {github.connected ? "Reconnect GitHub" : "Connect GitHub"}
              </Button>
            ) : (
              <>
                <Text style={styles.mutedValue}>
                  GitHub sign-in needs the browser's session, so connect or reconnect in the web app. Kestrel picks
                  the new access up when the app next refreshes.
                </Text>
                <Button variant="soft" onPress={connect} style={styles.accessButton}>
                  Open web profile
                </Button>
              </>
            )
          ) : null}
        </Card>

        <View>
          <Button variant="soft" icon={LogOut} onPress={() => void signOut()} style={styles.signOut}>
            Sign out
          </Button>
        </View>
      </View>
    </SettingsPage>
  );
}

const styles = StyleSheet.create({
  body: { paddingHorizontal: spacing.lg, paddingTop: spacing.lg, gap: spacing.lg },
  profileCard: { flexDirection: "row", alignItems: "center", gap: spacing.md, flexWrap: "wrap" },
  avatar: { width: 56, height: 56, borderRadius: 28 },
  avatarPlaceholder: { backgroundColor: colors.white08, alignItems: "center", justifyContent: "center" },
  avatarLetter: { color: colors.foreground, fontSize: 20, fontWeight: "600" },
  identity: { flex: 1, minWidth: 120 },
  name: { color: colors.foreground, fontSize: 16, fontWeight: "600" },
  login: { color: colors.mutedForeground, fontSize: 12, fontFamily: fonts.mono, marginTop: 2 },
  detailsCard: { paddingVertical: spacing.md, gap: spacing.md },
  value: { color: colors.foreground, fontSize: 14 },
  mutedValue: { color: colors.mutedForeground, fontSize: 14, lineHeight: 20 },
  mono: { fontFamily: fonts.mono },
  hint: { color: colors.mutedForeground, fontSize: 12, paddingHorizontal: 2 },
  accessCard: { paddingVertical: spacing.md, gap: spacing.md },
  accessHead: { flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: spacing.sm },
  accessLabel: { color: colors.foreground, fontSize: 15, fontWeight: "600" },
  account: { color: colors.mutedForeground, fontSize: 12, fontFamily: fonts.mono },
  accessButton: { alignSelf: "flex-start" },
  signOut: { alignSelf: "flex-start" },
});
