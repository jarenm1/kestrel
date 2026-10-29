import React from "react";
import { StyleSheet, Text, View } from "react-native";
import type { ContextUsage } from "@cloudagents/protocol";
import { colors, fonts, radius } from "@/theme";

const tokens = new Intl.NumberFormat("en", { notation: "compact", maximumFractionDigits: 1 });

/**
 * How full the thread's agent session is, drawn on the composer's top edge: a straight hairline
 * filled up to the used share, with the percentage above the head and the window size above the far end.
 */
export function ContextBar({ context }: { context: ContextUsage }) {
  const percent = Math.min(100, Math.max(0, (context.usedTokens / context.windowTokens) * 100));
  const percentLabel = `${Math.round(percent)}%`;
  const windowLabel = tokens.format(context.windowTokens);

  const fillColor =
    percent >= 90 ? colors.destructive : percent >= 75 ? colors.warning : "rgba(255,255,255,0.6)";

  return (
    <View style={styles.container} pointerEvents="none" accessibilityRole="progressbar">
      <View style={styles.labelsRow}>
        <Text style={styles.label}>{percentLabel}</Text>
        <Text style={styles.label}>{windowLabel}</Text>
      </View>
      <View style={styles.track}>
        <View style={[styles.fill, { width: `${percent}%`, backgroundColor: fillColor }]} />
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    position: "absolute",
    top: 0,
    left: radius.xxl,
    right: radius.xxl,
    zIndex: 10,
  },
  labelsRow: {
    position: "absolute",
    bottom: 2,
    left: 0,
    right: 0,
    flexDirection: "row",
    justifyContent: "space-between",
  },
  label: {
    fontSize: 10,
    fontFamily: fonts.mono,
    color: colors.mutedForeground,
  },
  track: {
    height: 1,
    backgroundColor: "rgba(255,255,255,0.1)",
    overflow: "hidden",
  },
  fill: {
    height: "100%",
  },
});
