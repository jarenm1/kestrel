import React, { type ReactNode } from "react";
import { StyleSheet, Text, View } from "react-native";
import { Menu } from "lucide-react-native";
import { BoxOfflineBanner } from "@/components/BoxStatus";
import { KestrelMark } from "@/components/KestrelMark";
import { Button } from "@/components/ui/Button";
import { useShell } from "@/nav/navigation";
import { colors, radius, spacing } from "@/theme";

/**
 * The web app's header (`h-11`, on the page background), with the button that opens the thread sidebar.
 * Without a title it shows the Kestrel mark, as the web header does.
 */
export function TopBar({ title, right }: { title?: string; right?: ReactNode }) {
  const shell = useShell();
  return (
    <View style={styles.bar}>
      <Button
        variant="ghost"
        size="icon"
        icon={Menu}
        accessibilityLabel="Open threads"
        onPress={shell.openSidebar}
      />
      {title === undefined ? (
        <View style={styles.mark}>
          <KestrelMark height={20} color={colors.foreground + "e6"} />
        </View>
      ) : (
        <Text style={styles.title} numberOfLines={1}>
          {title}
        </Text>
      )}
      <View style={styles.spacer} />
      {right}
    </View>
  );
}

/**
 * The raised panel every page sits in (web WorkspaceLayout: `rounded-2xl bg-card`), under the box offline banner.
 * It runs to the bottom edge; `bottomInset` keeps its content clear of the home indicator.
 */
export function ContentPanel({ children, bottomInset }: { children: ReactNode; bottomInset: number }) {
  return (
    <>
      <BoxOfflineBanner style={styles.banner} />
      <View style={[styles.panel, { paddingBottom: bottomInset }]}>{children}</View>
    </>
  );
}

const styles = StyleSheet.create({
  banner: { marginHorizontal: spacing.md, marginBottom: spacing.sm, width: "auto" },
  bar: {
    height: 48,
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.xs,
    paddingHorizontal: spacing.sm,
  },
  mark: { paddingHorizontal: spacing.xs },
  title: { flexShrink: 1, color: colors.foreground, fontSize: 15, fontWeight: "600", paddingHorizontal: spacing.xs },
  spacer: { flex: 1 },
  panel: {
    flex: 1,
    overflow: "hidden",
    backgroundColor: colors.card,
    borderTopLeftRadius: radius.xxl,
    borderTopRightRadius: radius.xxl,
  },
});
