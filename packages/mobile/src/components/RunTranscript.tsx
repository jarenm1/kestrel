import React, { type ReactNode, useMemo, useState } from "react";
import { Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { useQuery } from "@tanstack/react-query";
import { ChevronRight } from "lucide-react-native";
import type { AgentItem } from "@cloudagents/protocol";
import { createQueries } from "@/api/queries";
import { Markdown } from "@/components/Markdown";
import { Alert } from "@/components/ui/Alert";
import { useApiClient } from "@/hooks/useApiClient";
import { colors, fonts, radius, shadows, spacing } from "@/theme";

interface Tree {
  roots: readonly AgentItem[];
  children: ReadonlyMap<string, readonly AgentItem[]>;
}

/** Items in arrival order; a tool's subagent items (`parentToolId`) hang under it instead of the top level. */
function buildTree(items: readonly AgentItem[]): Tree {
  const toolIds = new Set(items.filter((item) => item._tag === "tool").map((item) => item.id));
  const roots: AgentItem[] = [];
  const children = new Map<string, AgentItem[]>();
  for (const item of items) {
    const parentToolId = item._tag === "turn" || item._tag === "error" ? null : item.parentToolId;
    if (parentToolId !== null && toolIds.has(parentToolId)) {
      const list = children.get(parentToolId) ?? [];
      list.push(item);
      children.set(parentToolId, list);
    } else {
      roots.push(item);
    }
  }
  return { roots, children };
}

function turnSummary(item: Extract<AgentItem, { _tag: "turn" }>): string {
  const parts: string[] = [];
  if (item.durationMs !== null) parts.push(`${(item.durationMs / 1000).toFixed(1)}s`);
  if (item.inputTokens !== null || item.outputTokens !== null) {
    parts.push(`${item.inputTokens ?? "?"} in · ${item.outputTokens ?? "?"} out`);
  }
  if (item.costUsd !== null) parts.push(`$${item.costUsd.toFixed(4)}`);
  if (item.isError) parts.push("failed");
  return parts.join(" · ");
}

/** The web app's `<details>`: a tappable summary line that shows its body while open. */
function Disclosure({ summary, children }: { summary: ReactNode; children: ReactNode }) {
  const [open, setOpen] = useState(false);
  return (
    <View>
      <Pressable
        style={styles.summary}
        onPress={() => setOpen((o) => !o)}
        hitSlop={6}
        accessibilityRole="button"
        accessibilityState={{ expanded: open }}
      >
        <View style={open ? styles.chevronOpen : undefined}>
          <ChevronRight size={14} color={colors.mutedForeground} />
        </View>
        {summary}
      </Pressable>
      {open ? children : null}
    </View>
  );
}

function Pre({ text }: { text: string }) {
  return (
    <ScrollView style={styles.pre} nestedScrollEnabled>
      <Text style={styles.preText} selectable>
        {text}
      </Text>
    </ScrollView>
  );
}

function ItemView({ item, tree }: { item: AgentItem; tree: Tree }) {
  switch (item._tag) {
    case "text":
      return <Markdown text={item.text} />;
    case "thinking":
      return (
        <Disclosure summary={<Text style={styles.summaryText}>Thinking</Text>}>
          <Text style={styles.thinking}>{item.text}</Text>
        </Disclosure>
      );
    case "tool":
      return (
        <View style={styles.tool}>
          <Disclosure
            summary={
              <Text
                style={[styles.summaryText, styles.mono, item.status === "error" && styles.error]}
                numberOfLines={1}
              >
                {item.name} · {item.status}
              </Text>
            }
          >
            <View style={styles.toolBody}>
              <Pre text={JSON.stringify(item.input, null, 2)} />
              {item.output !== null ? <Pre text={item.output} /> : null}
              {(tree.children.get(item.id) ?? []).map((child) => (
                <ItemView key={child.id} item={child} tree={tree} />
              ))}
            </View>
          </Disclosure>
        </View>
      );
    case "turn": {
      const summary = turnSummary(item);
      if (summary === "") return null;
      return <Text style={[styles.turn, item.isError && styles.error]}>{summary}</Text>;
    }
    case "error":
      return <Alert>{item.text}</Alert>;
  }
}

/** One run's normalized items, in order: the agent's reply as markdown, with thinking and tools collapsed. */
export function RunTranscript({ runId }: { runId: string }) {
  const { api } = useApiClient();
  const queries = useMemo(() => createQueries(api), [api]);
  const { data } = useQuery(queries.runItems(runId));
  const tree = useMemo(() => buildTree(data ?? []), [data]);

  if (data === undefined || data.length === 0) return null;

  return (
    <View style={styles.root}>
      {tree.roots.map((item) => (
        <ItemView key={item.id} item={item} tree={tree} />
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  root: { gap: spacing.md },
  summary: { flexDirection: "row", alignItems: "center", gap: 6, minHeight: 24 },
  chevronOpen: { transform: [{ rotate: "90deg" }] },
  summaryText: { color: colors.mutedForeground, fontSize: 12, flexShrink: 1 },
  mono: { fontFamily: fonts.mono },
  error: { color: colors.destructive },
  thinking: {
    color: colors.mutedForeground,
    fontSize: 14,
    lineHeight: 20,
    fontStyle: "italic",
    marginTop: spacing.xs,
  },
  tool: {
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.card + "66",
    borderRadius: radius.xl,
    paddingHorizontal: 14,
    paddingVertical: spacing.sm,
    ...shadows.soft,
  },
  toolBody: { marginTop: spacing.sm, gap: spacing.sm },
  pre: { maxHeight: 288, backgroundColor: colors.code, borderRadius: radius.sm, paddingHorizontal: 12, paddingVertical: 8 },
  preText: { color: colors.foreground, fontFamily: fonts.mono, fontSize: 11, lineHeight: 16 },
  turn: { color: colors.mutedForeground, fontSize: 11 },
});
