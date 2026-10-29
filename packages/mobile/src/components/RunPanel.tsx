import React, { type ComponentRef, useEffect, useRef, useState } from "react";
import { Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import type { Run } from "@cloudagents/protocol";
import { StatusIcon } from "@/components/ui/StatusIcon";
import { colors, fonts, radius, spacing } from "@/theme";

interface Props {
  /** Runs sorted oldest -> newest. */
  runs: readonly Run[];
  output: Record<string, string[]>;
}

/** The latest run's raw harness output, open while it runs. Stopping a run lives on the composer's button. */
export function RunPanel({ runs, output }: Props) {
  const current = runs.at(-1) ?? null;
  const running = current?.status === "running";
  const lines = current ? (output[current.id] ?? []) : [];
  const [open, setOpen] = useState(running);
  const logRef = useRef<ComponentRef<typeof ScrollView>>(null);

  // Like the web `<details open={running}>`: a run starting opens the log, finishing closes it.
  useEffect(() => setOpen(running), [running]);

  if (!current) return null;

  return (
    <View style={styles.wrap}>
      <Pressable
        style={styles.summary}
        onPress={() => setOpen((o) => !o)}
        hitSlop={8}
        accessibilityRole="button"
        accessibilityState={{ expanded: open }}
      >
        {running ? <StatusIcon status="running" /> : null}
        <Text style={styles.summaryText}>Live log</Text>
      </Pressable>
      {open ? (
        <ScrollView
          ref={logRef}
          style={styles.log}
          contentContainerStyle={styles.logContent}
          nestedScrollEnabled
          onContentSizeChange={() => logRef.current?.scrollToEnd({ animated: false })}
        >
          {lines.length === 0 ? (
            <Text style={[styles.logText, styles.muted]}>No output yet.</Text>
          ) : (
            <Text style={styles.logText} selectable>
              {lines.join("\n")}
            </Text>
          )}
        </ScrollView>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { paddingHorizontal: spacing.lg, paddingTop: spacing.sm },
  summary: { flexDirection: "row", alignItems: "center", gap: spacing.sm, alignSelf: "flex-start", paddingVertical: 2 },
  summaryText: { color: colors.mutedForeground, fontSize: 14 },
  log: { maxHeight: 180, marginTop: spacing.sm, borderRadius: radius.xl, backgroundColor: colors.code },
  logContent: { paddingHorizontal: 14, paddingVertical: spacing.md },
  logText: { color: colors.foreground, fontFamily: fonts.mono, fontSize: 12, lineHeight: 17 },
  muted: { color: colors.mutedForeground },
});
