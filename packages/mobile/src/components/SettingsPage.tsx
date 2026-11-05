import React, { type ReactNode } from "react";
import { ScrollView, StyleSheet, Text, View } from "react-native";
import { ScreenHeader } from "@/components/ScreenHeader";
import { useNavigation } from "@/nav/navigation";
import { colors, spacing } from "@/theme";

/**
 * A settings page inside the stack: a back control, the page title, the web app's `SectionHeader` description, then
 * the section. The root settings page (the hub) draws its own header, since nothing sits under it to go back to.
 */
export function SettingsPage({
  title,
  description,
  children,
}: {
  title: string;
  description?: string;
  children: ReactNode;
}) {
  const nav = useNavigation();
  return (
    <ScrollView style={styles.screen} contentContainerStyle={styles.content}>
      <ScreenHeader title={title} onBack={() => nav.back()} />
      {description !== undefined ? <Text style={styles.description}>{description}</Text> : null}
      {children}
    </ScrollView>
  );
}

/** A heading inside a settings page (the web app's `SectionHeader`), e.g. Billing's Plans block. */
export function SettingsSectionHeader({ title, description }: { title: string; description?: string }) {
  return (
    <View style={styles.sectionHeader}>
      <Text style={styles.sectionTitle}>{title}</Text>
      {description !== undefined ? <Text style={styles.description}>{description}</Text> : null}
    </View>
  );
}

/** A label/value line, the web app's settings `Row` (`w-32` label, value filling the rest). */
export function SettingsRow({ label, children }: { label: string; children: ReactNode }) {
  return (
    <View style={styles.row}>
      <Text style={styles.rowLabel}>{label}</Text>
      <View style={styles.rowValue}>{children}</View>
    </View>
  );
}

/** Thin divider between rows of one card. */
export function SettingsDivider() {
  return <View style={styles.divider} />;
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.background },
  content: { paddingBottom: spacing.xxl },
  description: { color: colors.mutedForeground, fontSize: 14, lineHeight: 20, paddingHorizontal: spacing.lg, paddingTop: spacing.sm },
  sectionHeader: { gap: 2 },
  sectionTitle: { color: colors.foreground, fontSize: 16, fontWeight: "600" },
  row: { flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: 12 },
  rowLabel: { width: 96, color: colors.mutedForeground, fontSize: 14 },
  rowValue: { flex: 1, minWidth: 120, flexDirection: "row", alignItems: "center", gap: spacing.sm },
  divider: { height: StyleSheet.hairlineWidth, backgroundColor: colors.border },
});
