import React from "react";
import { View, Text, StyleSheet } from "react-native";
import { colors, radius, spacing } from "@/theme";
import type { TaskStatus, RunStatus, DesktopState } from "@/api/types";

type Status = TaskStatus | RunStatus | DesktopState | string;

const STATUS_COLORS: Record<string, { bg: string; text: string }> = {
  running: { bg: colors.info + "22", text: colors.info },
  starting: { bg: colors.info + "22", text: colors.info },
  needs_input: { bg: colors.warning + "22", text: colors.warning },
  done: { bg: colors.success + "22", text: colors.success },
  succeeded: { bg: colors.success + "22", text: colors.success },
  failed: { bg: colors.destructive + "22", text: colors.destructive },
  cancelled: { bg: colors.destructive + "22", text: colors.destructive },
  idle: { bg: colors.muted, text: colors.mutedForeground },
  stopped: { bg: colors.muted, text: colors.mutedForeground },
};

const DEFAULT_COLORS = { bg: colors.muted, text: colors.mutedForeground };

export function StatusBadge({ status }: { status: Status }) {
  const c = STATUS_COLORS[status] ?? DEFAULT_COLORS;
  return (
    <View style={[styles.badge, { backgroundColor: c.bg }]}>
      <Text style={[styles.text, { color: c.text }]}>
        {status.replace("_", " ")}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  badge: {
    paddingHorizontal: spacing.sm,
    paddingVertical: 2,
    borderRadius: radius.sm,
  },
  text: {
    fontSize: 11,
    fontWeight: "600",
    textTransform: "capitalize",
  },
});

