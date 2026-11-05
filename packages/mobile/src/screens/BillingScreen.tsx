import React, { useMemo } from "react";
import { ActivityIndicator, StyleSheet, Text, View } from "react-native";
import { useQuery } from "@tanstack/react-query";
import { Check } from "lucide-react-native";
import { CURRENT_PLAN, PLANS, type Plan, type Usage } from "@cloudagents/protocol";
import { createQueries } from "@/api/queries";
import { SettingsDivider, SettingsPage, SettingsRow, SettingsSectionHeader } from "@/components/SettingsPage";
import { Alert } from "@/components/ui/Alert";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import { useApiClient } from "@/hooks/useApiClient";
import { errorText } from "@/lib/format";
import { useNavigation } from "@/nav/navigation";
import { colors, fonts, radius, spacing } from "@/theme";

const dateFormat = new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric", timeZone: "UTC" });

/** The web app's compact agent-hours figure: one decimal under 10 h, `<0.1` for a started hour. */
function hours(seconds: number): string {
  const h = seconds / 3600;
  if (h > 0 && h < 0.1) return "<0.1";
  return h < 10 ? h.toFixed(1) : Math.round(h).toString();
}

/** The plan and this month's agent usage, as the web app's Billing settings; quotas stay one tap away. */
export function BillingScreen() {
  const nav = useNavigation();
  const { api } = useApiClient();
  const queries = useMemo(() => createQueries(api), [api]);
  const usageQuery = useQuery(queries.usage());
  const usage = usageQuery.data;
  const current = PLANS.find((plan) => plan.id === CURRENT_PLAN) ?? PLANS[0];

  return (
    <SettingsPage title="Billing" description="Your plan and this month's agent usage.">
      <View style={styles.body}>
        <Card style={styles.planCard}>
          <View style={styles.planHead}>
            <View style={styles.planBlock}>
              <View style={styles.planLabelRow}>
                <Text style={styles.planLabel}>CURRENT PLAN</Text>
                <Badge variant="success">active</Badge>
              </View>
              <Text style={styles.planName}>{current.name}</Text>
              <Text style={styles.muted}>{current.desc}</Text>
            </View>
            <View style={styles.priceBlock}>
              <Text style={styles.price}>{current.price}</Text>
              <Text style={styles.muted}>{current.period}</Text>
            </View>
          </View>
          <SettingsDivider />
          {usageQuery.error ? <Alert>{errorText(usageQuery.error)}</Alert> : null}
          {usageQuery.isPending ? <ActivityIndicator size="small" color={colors.mutedForeground} /> : null}
          {usage ? <UsageSummary usage={usage} plan={current} /> : null}
        </Card>

        <Card style={styles.quotaCard}>
          <View style={styles.quotaRow}>
            <View style={styles.planBlock}>
              <Text style={styles.rowTitle}>Quotas</Text>
              <Text style={styles.muted}>Claude Code and Codex limits, banked resets and activity.</Text>
            </View>
            <Button variant="soft" size="sm" onPress={() => nav.push({ name: "usage" })}>
              Open
            </Button>
          </View>
        </Card>

        <View style={styles.section}>
          <SettingsSectionHeader
            title="Plans"
            description="Paid plans open when billing goes live; everyone is on Hobby for now."
          />
          {PLANS.map((plan) => (
            <PlanCard key={plan.id} plan={plan} current={plan.id === CURRENT_PLAN} />
          ))}
        </View>

        <View style={styles.section}>
          <SettingsSectionHeader title="Payment and invoices" description="Cards and receipts for paid plans." />
          <Card style={styles.detailsCard}>
            <SettingsRow label="Payment method">
              <Text style={styles.muted}>None. The Hobby plan needs no card.</Text>
            </SettingsRow>
            <SettingsDivider />
            <SettingsRow label="Invoices">
              <Text style={styles.muted}>No invoices yet.</Text>
            </SettingsRow>
          </Card>
        </View>
      </View>
    </SettingsPage>
  );
}

function UsageSummary({ usage, plan }: { usage: Usage; plan: Plan }) {
  const usedHours = usage.agentSeconds / 3600;
  const share = plan.agentHours === null ? 0 : Math.min(1, usedHours / plan.agentHours);
  const lastDay = new Date(Date.parse(usage.periodEnd) - 1);

  return (
    <View style={styles.usage}>
      <View style={styles.usageHead}>
        <Text style={styles.rowTitle}>Agent hours</Text>
        <Text style={styles.muted}>
          <Text style={styles.usageValue}>{hours(usage.agentSeconds)}</Text>
          {plan.agentHours === null ? " used" : ` of ${plan.agentHours} h`}
        </Text>
      </View>
      <View
        accessibilityRole="progressbar"
        accessibilityLabel="Agent hours used"
        accessibilityValue={{ min: 0, max: 100, now: Math.round(share * 100) }}
        style={styles.track}
      >
        <View
          style={[styles.fill, { width: `${share * 100}%`, backgroundColor: share >= 1 ? colors.warning : colors.primary }]}
        />
      </View>
      <Text style={styles.period}>
        {dateFormat.format(new Date(usage.periodStart))} – {dateFormat.format(lastDay)} (UTC). Resets on{" "}
        {dateFormat.format(new Date(usage.periodEnd))}.
      </Text>
      <View style={styles.statGrid}>
        <Stat label="Agent runs" value={usage.runs} />
        <Stat label="Threads with runs" value={usage.threads} />
      </View>
    </View>
  );
}

function Stat({ label, value }: { label: string; value: number }) {
  return (
    <View style={styles.stat}>
      <Text style={styles.statValue}>{value}</Text>
      <Text style={styles.statLabel}>{label}</Text>
    </View>
  );
}

function PlanCard({ plan, current }: { plan: Plan; current: boolean }) {
  return (
    <Card style={styles.planListCard}>
      <View style={styles.planListHead}>
        <Text style={styles.rowTitle}>{plan.name}</Text>
        {current ? <Badge variant="info">current</Badge> : null}
      </View>
      <View style={styles.priceRow}>
        <Text style={styles.planListPrice}>{plan.price}</Text>
        <Text style={styles.muted}>{plan.period}</Text>
      </View>
      <View style={styles.features}>
        {plan.features.map((feature) => (
          <View key={feature} style={styles.featureRow}>
            <Check size={12} color={colors.mutedForeground} />
            <Text style={styles.feature}>{feature}</Text>
          </View>
        ))}
      </View>
      <Button variant={current ? "soft" : "default"} size="sm" disabled>
        {current ? "Your plan" : "Coming soon"}
      </Button>
    </Card>
  );
}

const styles = StyleSheet.create({
  body: { paddingHorizontal: spacing.lg, paddingTop: spacing.lg, gap: spacing.lg },
  section: { gap: spacing.sm },
  planCard: { gap: spacing.md },
  planHead: { flexDirection: "row", alignItems: "flex-start", gap: spacing.md },
  planBlock: { flex: 1, minWidth: 0, gap: 2 },
  planLabelRow: { flexDirection: "row", alignItems: "center", gap: spacing.sm },
  planLabel: { color: colors.mutedForeground, fontSize: 10, fontWeight: "600", letterSpacing: 0.8 },
  planName: { color: colors.foreground, fontSize: 22, fontWeight: "700" },
  muted: { color: colors.mutedForeground, fontSize: 13, lineHeight: 18 },
  priceBlock: { alignItems: "flex-end" },
  price: { color: colors.foreground, fontSize: 24, fontWeight: "700" },
  quotaCard: { paddingVertical: spacing.md },
  quotaRow: { flexDirection: "row", alignItems: "center", gap: spacing.md },
  rowTitle: { color: colors.foreground, fontSize: 15, fontWeight: "600" },
  usage: { gap: spacing.md },
  usageHead: { flexDirection: "row", alignItems: "baseline", justifyContent: "space-between", gap: spacing.sm },
  usageValue: { color: colors.foreground, fontWeight: "600" },
  track: { height: 8, borderRadius: radius.full, backgroundColor: colors.white06, overflow: "hidden" },
  fill: { height: "100%", borderRadius: radius.full },
  period: { color: colors.mutedForeground, fontSize: 11 },
  statGrid: { flexDirection: "row", gap: spacing.sm },
  stat: { flex: 1, backgroundColor: colors.white03, borderRadius: radius.md, padding: spacing.md },
  statValue: { color: colors.foreground, fontSize: 20, fontWeight: "700", fontFamily: fonts.mono },
  statLabel: { color: colors.mutedForeground, fontSize: 11, marginTop: 2 },
  detailsCard: { paddingVertical: spacing.md, gap: spacing.md },
  planListCard: { gap: spacing.sm },
  planListHead: { flexDirection: "row", alignItems: "center", justifyContent: "space-between" },
  priceRow: { flexDirection: "row", alignItems: "baseline", gap: spacing.xs },
  planListPrice: { color: colors.foreground, fontSize: 20, fontWeight: "700" },
  features: { gap: 6 },
  featureRow: { flexDirection: "row", alignItems: "flex-start", gap: 6 },
  feature: { flex: 1, color: colors.foreground, fontSize: 12, opacity: 0.85 },
});
