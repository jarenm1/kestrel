import React, { useMemo } from "react";
import { ActivityIndicator, Image, ScrollView, StyleSheet, Text, View } from "react-native";
import { useMutation, useQuery } from "@tanstack/react-query";
import { CreditCard, LogOut, Monitor, Plug, User } from "lucide-react-native";
import { CURRENT_PLAN, PLANS } from "@cloudagents/protocol";
import { createQueries } from "@/api/queries";
import { useAuth } from "@/auth/AuthContext";
import { ScreenHeader } from "@/components/ScreenHeader";
import { Alert } from "@/components/ui/Alert";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import { useApiClient } from "@/hooks/useApiClient";
import { errorText } from "@/lib/format";
import { useNavigation } from "@/nav/navigation";
import { colors, fonts, radius, spacing } from "@/theme";

export function SettingsScreen() {
  const { user, signOut, boxes, activeBoxId, setActiveBox } = useAuth();
  const nav = useNavigation();
  const { api } = useApiClient();
  const queries = useMemo(() => createQueries(api), [api]);
  const usageQuery = useQuery(queries.usage());
  const usage = usageQuery.data;

  const switchBox = useMutation({
    mutationFn: (boxId: string | null) => setActiveBox(boxId),
  });

  const currentPlan = PLANS.find((p) => p.id === CURRENT_PLAN) ?? PLANS[0];
  const hoursUsed = usage ? (usage.agentSeconds / 3600).toFixed(1) : "0";

  return (
    <ScrollView style={styles.scroll} contentContainerStyle={styles.container}>
      <ScreenHeader title="Settings" />

      {/* Profile Section */}
      <View style={styles.section}>
        <View style={styles.sectionTitleRow}>
          <User size={16} color={colors.mutedForeground} />
          <Text style={styles.sectionTitle}>Profile</Text>
        </View>
        <Card style={styles.card}>
          <View style={styles.profileRow}>
            {user?.avatarUrl ? (
              <Image source={{ uri: user.avatarUrl }} style={styles.avatar} />
            ) : (
              <View style={[styles.avatar, styles.avatarPlaceholder]}>
                <Text style={styles.avatarLetter}>{user?.login?.slice(0, 1) ?? "U"}</Text>
              </View>
            )}
            <View style={styles.profileInfo}>
              <Text style={styles.loginText}>{user?.login ?? "Signed in"}</Text>
              <Text style={styles.subText}>GitHub Account</Text>
            </View>
            <Button
              variant="ghost"
              size="sm"
              icon={LogOut}
              onPress={() => void signOut()}
              accessibilityLabel="Sign out"
            >
              Sign out
            </Button>
          </View>
        </Card>
      </View>
      {/* Box Section */}
      <View style={styles.section}>
        <View style={styles.sectionTitleRow}>
          <Monitor size={16} color={colors.mutedForeground} />
          <Text style={styles.sectionTitle}>Box</Text>
        </View>
        <Card style={styles.card}>
          <BoxRow
            name="Kestrel's box"
            detail="Hosted by Kestrel"
            active={activeBoxId === null}
            disabled={switchBox.isPending}
            onUse={() => switchBox.mutate(null)}
          />
          {boxes.map((box) => (
            <BoxRow
              key={box.id}
              name={box.name}
              detail={box.url}
              active={activeBoxId === box.id}
              disabled={switchBox.isPending}
              onUse={() => switchBox.mutate(box.id)}
            />
          ))}
          {switchBox.error ? <Alert variant="destructive">{errorText(switchBox.error)}</Alert> : null}
          <Text style={styles.subText}>Boxes are created and deleted on the web app.</Text>
        </Card>
      </View>

      {/* Billing & Usage Section */}
      <View style={styles.section}>
        <View style={styles.sectionTitleRow}>
          <CreditCard size={16} color={colors.mutedForeground} />
          <Text style={styles.sectionTitle}>Billing & Usage</Text>
        </View>
        <Card style={styles.card}>
          <View style={styles.planHeader}>
            <View>
              <Text style={styles.planName}>{currentPlan?.name ?? "Hobby"} Plan</Text>
              <Text style={styles.planDesc}>{currentPlan?.desc}</Text>
            </View>
            <Badge variant="neutral">Current</Badge>
          </View>

          <View style={styles.usageDivider} />

          {usageQuery.isPending ? (
            <ActivityIndicator size="small" color={colors.mutedForeground} />
          ) : (
            <View style={styles.usageGrid}>
              <View style={styles.statBox}>
                <Text style={styles.statNumber}>{hoursUsed}h</Text>
                <Text style={styles.statLabel}>Agent hours</Text>
              </View>
              <View style={styles.statBox}>
                <Text style={styles.statNumber}>{usage?.threads ?? 0}</Text>
                <Text style={styles.statLabel}>Threads</Text>
              </View>
              <View style={styles.statBox}>
                <Text style={styles.statNumber}>{usage?.runs ?? 0}</Text>
                <Text style={styles.statLabel}>Runs executed</Text>
              </View>
            </View>
          )}
        </Card>
      </View>

      {/* Connections Link */}
      <View style={styles.section}>
        <View style={styles.sectionTitleRow}>
          <Plug size={16} color={colors.mutedForeground} />
          <Text style={styles.sectionTitle}>Providers</Text>
        </View>
        <Card style={styles.card}>
          <View style={styles.connectionsRow}>
            <View style={styles.connectionsInfo}>
              <Text style={styles.cardTitle}>Model & CLI Connections</Text>
              <Text style={styles.subText}>Manage Anthropic, OpenAI, GitHub and devbox logins.</Text>
            </View>
            <Button variant="soft" size="sm" onPress={() => nav.navigate({ name: "connections" })}>
              Open
            </Button>
          </View>
        </Card>
      </View>
    </ScrollView>
  );
}

function BoxRow({
  name,
  detail,
  active,
  disabled,
  onUse,
}: {
  name: string;
  detail: string;
  active: boolean;
  disabled: boolean;
  onUse: () => void;
}) {
  return (
    <View style={styles.connectionsRow}>
      <View style={styles.connectionsInfo}>
        <Text style={styles.cardTitle}>{name}</Text>
        <Text style={styles.monoText} numberOfLines={1}>
          {detail}
        </Text>
      </View>
      {active ? (
        <Badge variant="success">Active</Badge>
      ) : (
        <Button variant="soft" size="sm" disabled={disabled} onPress={onUse}>
          Use
        </Button>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  scroll: { flex: 1 },
  container: { padding: spacing.md, gap: spacing.lg, paddingBottom: spacing.xxl },
  section: { gap: spacing.sm },
  sectionTitleRow: { flexDirection: "row", alignItems: "center", gap: spacing.xs, paddingHorizontal: 2 },
  sectionTitle: { fontSize: 13, fontWeight: "600", color: colors.mutedForeground },
  card: { padding: spacing.md, gap: spacing.md },
  profileRow: { flexDirection: "row", alignItems: "center", gap: spacing.md },
  avatar: { width: 44, height: 44, borderRadius: 22 },
  avatarPlaceholder: { backgroundColor: colors.white12, alignItems: "center", justifyContent: "center" },
  avatarLetter: { color: colors.foreground, fontSize: 18, fontWeight: "600" },
  profileInfo: { flex: 1 },
  loginText: { color: colors.foreground, fontSize: 16, fontWeight: "600" },
  subText: { color: colors.mutedForeground, fontSize: 12, marginTop: 2 },
  planHeader: { flexDirection: "row", justifyContent: "space-between", alignItems: "flex-start" },
  planName: { color: colors.foreground, fontSize: 16, fontWeight: "600" },
  planDesc: { color: colors.mutedForeground, fontSize: 12, marginTop: 2, maxWidth: 220 },
  usageDivider: { height: StyleSheet.hairlineWidth, backgroundColor: colors.border },
  usageGrid: { flexDirection: "row", justifyContent: "space-between", gap: spacing.sm },
  statBox: { flex: 1, alignItems: "center", padding: spacing.sm, backgroundColor: colors.white03, borderRadius: radius.md },
  statNumber: { color: colors.foreground, fontSize: 18, fontWeight: "700", fontFamily: fonts.mono },
  statLabel: { color: colors.mutedForeground, fontSize: 10, textAlign: "center", marginTop: 4 },
  connectionsRow: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: spacing.md },
  connectionsInfo: { flex: 1 },
  cardTitle: { color: colors.foreground, fontSize: 14, fontWeight: "600" },
  monoText: { color: colors.mutedForeground, fontSize: 12, fontFamily: fonts.mono, marginTop: 2 },
});
