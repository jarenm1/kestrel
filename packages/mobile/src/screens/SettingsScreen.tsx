import React from "react";
import { Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import ChevronRight from "lucide-react-native/icons/chevron-right";
import CreditCard from "lucide-react-native/icons/credit-card";
import MessagesSquare from "lucide-react-native/icons/messages-square";
import Plug from "lucide-react-native/icons/plug";
import Server from "lucide-react-native/icons/server";
import User from "lucide-react-native/icons/user";
import type { LucideIcon } from "lucide-react-native";
import { CURRENT_PLAN, PLANS } from "@cloudagents/protocol";
import { useAuth } from "@/auth/AuthContext";
import { ScreenHeader } from "@/components/ScreenHeader";
import { Card } from "@/components/ui/Card";
import { useNavigation, type SettingsSection } from "@/nav/navigation";
import { BoxesScreen } from "@/screens/BoxesScreen";
import { BillingScreen } from "@/screens/BillingScreen";
import { ProfileScreen } from "@/screens/ProfileScreen";
import { ThreadsSettingsScreen } from "@/screens/ThreadsSettingsScreen";
import { colors, spacing } from "@/theme";

/**
 * Each section's page component. `Record<SettingsSection, …>`: adding a section to the route type fails to compile
 * until its page is here, so no section URL can open a blank screen.
 */
const SECTION_PAGES: Record<SettingsSection, React.ComponentType> = {
  profile: ProfileScreen,
  threads: ThreadsSettingsScreen,
  boxes: BoxesScreen,
  billing: BillingScreen,
};

/**
 * Settings, the phone shape of the web app's Settings layout: a hub that lists the sections, each opening its own page
 * with a back control. Choosing a section pushes it, so back returns to the hub; a section URL opened directly lands on
 * that page, and back leaves settings. Connections keeps its own route: the thread sidebar and composer open it
 * directly, and the hub lists it too.
 */
export function SettingsScreen({ section }: { section?: SettingsSection }) {
  if (section === undefined) return <SettingsHome />;
  const Page = SECTION_PAGES[section];
  return <Page />;
}

function SettingsHome() {
  const nav = useNavigation();
  const { user, boxes, activeBoxId } = useAuth();
  const plan = PLANS.find((candidate) => candidate.id === CURRENT_PLAN) ?? PLANS[0];
  const activeBox = activeBoxId === null ? null : boxes.find((box) => box.id === activeBoxId);
  const boxName = activeBoxId === null ? "Kestrel's box" : (activeBox?.name ?? "Your own box");

  return (
    <ScrollView style={styles.screen} contentContainerStyle={styles.content}>
      <ScreenHeader title="Settings" />
      <Card style={styles.card}>
        <SettingsNavRow
          icon={User}
          label="Profile"
          detail={user === null ? "GitHub account" : `@${user.login} · GitHub account`}
          onPress={() => nav.push({ name: "settings", section: "profile" })}
        />
        <View style={styles.divider} />
        <SettingsNavRow
          icon={Plug}
          label="Connections"
          detail="Subscriptions, API keys and models"
          onPress={() => nav.push({ name: "connections" })}
        />
        <View style={styles.divider} />
        <SettingsNavRow
          icon={MessagesSquare}
          label="Threads"
          detail="Titles, streaming and usage limits"
          onPress={() => nav.push({ name: "settings", section: "threads" })}
        />
        <View style={styles.divider} />
        <SettingsNavRow
          icon={Server}
          label="Boxes"
          detail={boxName}
          onPress={() => nav.push({ name: "settings", section: "boxes" })}
        />
        <View style={styles.divider} />
        <SettingsNavRow
          icon={CreditCard}
          label="Billing"
          detail={`${plan.name} plan · ${plan.price} ${plan.period}`}
          onPress={() => nav.push({ name: "settings", section: "billing" })}
        />
      </Card>
      <Text style={styles.hint}>
        The phone app's settings mirror the web app. Repository access and sign-out live under Profile.
      </Text>
    </ScrollView>
  );
}

/** One hub entry: icon, label and a one-line summary, with the chevron that marks a page. */
export function SettingsNavRow({
  icon: Icon,
  label,
  detail,
  onPress,
}: {
  icon: LucideIcon;
  label: string;
  detail: string;
  onPress: () => void;
}) {
  return (
    <Pressable
      style={({ pressed }) => [styles.row, pressed && styles.rowPressed]}
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={detail === "" ? label : `${label}, ${detail}`}
    >
      <Icon size={18} color={colors.mutedForeground} />
      <View style={styles.rowText}>
        <Text style={styles.rowLabel}>{label}</Text>
        <Text style={styles.rowDetail} numberOfLines={1}>
          {detail}
        </Text>
      </View>
      <ChevronRight size={16} color={colors.mutedForeground} />
    </Pressable>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.background },
  content: { paddingBottom: spacing.xxl },
  card: { marginHorizontal: spacing.lg, marginTop: spacing.lg, paddingVertical: 0, paddingHorizontal: 0, gap: 0 },
  row: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.md,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.md,
    minHeight: 56,
  },
  rowPressed: { backgroundColor: colors.white03 },
  rowText: { flex: 1, minWidth: 0, gap: 2 },
  rowLabel: { color: colors.foreground, fontSize: 15, fontWeight: "600" },
  rowDetail: { color: colors.mutedForeground, fontSize: 12 },
  divider: { height: StyleSheet.hairlineWidth, backgroundColor: colors.border, marginLeft: spacing.lg + 18 + spacing.md },
  hint: { color: colors.mutedForeground, fontSize: 12, paddingHorizontal: spacing.lg, paddingTop: spacing.md },
});
