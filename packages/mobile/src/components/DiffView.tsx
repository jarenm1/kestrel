import React, { useMemo, useState } from "react";
import { ActivityIndicator, FlatList, Pressable, StyleSheet, Text, View } from "react-native";
import { useQuery } from "@tanstack/react-query";
import type { CheckoutDiff } from "@cloudagents/protocol";
import { createQueries } from "@/api/queries";
import { useApiClient } from "@/hooks/useApiClient";
import { type DiffFile, type DiffLine, displayPath, parseDiff } from "@/lib/diff";
import { errorText, repoShortName } from "@/lib/format";
import { colors, radius, spacing } from "@/theme";

/** Files with more changed lines than this start collapsed, as on the web. */
const LARGE_FILE_LINES = 1500;

type Row =
  | { kind: "checkout"; key: string; repo: string; baseBranch: string; files: number; additions: number; deletions: number }
  | { kind: "file"; key: string; file: DiffFile; collapsed: boolean }
  | { kind: "note"; key: string; text: string }
  | { kind: "hunk"; key: string; range: string; section: string }
  | { kind: "line"; key: string; line: DiffLine };

function fileNotes(file: DiffFile): string[] {
  const notes: string[] = [];
  if (file.modeChange) notes.push(`Mode ${file.modeChange.from} → ${file.modeChange.to}`);
  if (file.binary) notes.push("Binary file not shown.");
  else if (file.hunks.length === 0 && file.status === "renamed") notes.push("Renamed without changes.");
  else if (file.hunks.length === 0 && file.status === "added") notes.push("Empty file.");
  else if (file.hunks.length === 0 && file.status === "deleted") notes.push("Empty file deleted.");
  return notes;
}

/** Flattens checkouts → files → hunks → lines into one list for virtualised rendering. */
function buildRows(checkouts: readonly CheckoutDiff[], overrides: ReadonlyMap<string, boolean>): Row[] {
  const rows: Row[] = [];
  for (const checkout of checkouts) {
    const files = parseDiff(checkout.diff);
    rows.push({
      kind: "checkout",
      key: `co:${checkout.checkoutId}`,
      repo: checkout.repo,
      baseBranch: checkout.baseBranch,
      files: files.length,
      additions: files.reduce((sum, f) => sum + f.additions, 0),
      deletions: files.reduce((sum, f) => sum + f.deletions, 0),
    });
    if (files.length === 0) rows.push({ kind: "note", key: `co:${checkout.checkoutId}:none`, text: "No changes." });
    for (const [index, file] of files.entries()) {
      const key = `${checkout.checkoutId}:${index}`;
      const collapsed = overrides.get(key) ?? file.additions + file.deletions > LARGE_FILE_LINES;
      rows.push({ kind: "file", key, file, collapsed });
      if (collapsed) continue;
      for (const text of fileNotes(file)) rows.push({ kind: "note", key: `${key}:note:${text}`, text });
      for (const [h, hunk] of file.hunks.entries()) {
        rows.push({ kind: "hunk", key: `${key}:h${h}`, range: hunk.range, section: hunk.section });
        for (const [l, line] of hunk.lines.entries()) rows.push({ kind: "line", key: `${key}:h${h}:l${l}`, line });
        if (hunk.lines.at(-1)?.noNewline) {
          rows.push({ kind: "note", key: `${key}:h${h}:eof`, text: "No newline at end of file" });
        }
      }
    }
  }
  return rows;
}

const STATUS_LETTER: Record<DiffFile["status"], { letter: string; color: string }> = {
  added: { letter: "A", color: colors.success },
  deleted: { letter: "D", color: colors.destructive },
  modified: { letter: "M", color: colors.warning },
  renamed: { letter: "R", color: colors.info },
};

interface DiffViewProps {
  taskId: string;
  /** Polls while the agent is working so the diff follows its edits. */
  running: boolean;
}

export function DiffView({ taskId, running }: DiffViewProps) {
  const { api } = useApiClient();
  const diff = useQuery(createQueries(api).diff(taskId, running));
  const [overrides, setOverrides] = useState<ReadonlyMap<string, boolean>>(new Map());
  const checkouts = diff.data?.checkouts;
  const rows = useMemo(() => buildRows(checkouts ?? [], overrides), [checkouts, overrides]);

  function toggle(key: string, collapsed: boolean) {
    setOverrides((prev) => new Map(prev).set(key, !collapsed));
  }

  if (diff.isPending) {
    return (
      <View style={styles.center}>
        <ActivityIndicator color={colors.mutedForeground} />
      </View>
    );
  }
  if (diff.error) {
    return (
      <View style={styles.center}>
        <Text style={styles.error}>{errorText(diff.error)}</Text>
      </View>
    );
  }
  return (
    <FlatList
      style={styles.flex}
      contentContainerStyle={styles.list}
      data={rows}
      keyExtractor={(r) => r.key}
      renderItem={({ item }) => <RowView row={item} onToggle={toggle} />}
      ListEmptyComponent={<Text style={styles.note}>No checkouts yet. The agent checks out a repository when it needs one.</Text>}
    />
  );
}

function RowView({ row, onToggle }: { row: Row; onToggle: (key: string, collapsed: boolean) => void }) {
  switch (row.kind) {
    case "checkout":
      return (
        <View style={styles.checkout}>
          <Text style={styles.checkoutName} numberOfLines={1}>
            {repoShortName(row.repo)}
          </Text>
          <Text style={styles.muted}>
            vs {row.baseBranch} · {row.files} {row.files === 1 ? "file" : "files"} · <Text style={styles.add}>+{row.additions}</Text>{" "}
            <Text style={styles.del}>−{row.deletions}</Text>
          </Text>
        </View>
      );
    case "file": {
      const { file, collapsed } = row;
      const status = STATUS_LETTER[file.status];
      return (
        <Pressable style={styles.file} onPress={() => onToggle(row.key, collapsed)} accessibilityRole="button">
          <Text style={styles.chevron}>{collapsed ? "▸" : "▾"}</Text>
          <View style={[styles.statusBox, { borderColor: status.color }]}>
            <Text style={[styles.statusText, { color: status.color }]}>{status.letter}</Text>
          </View>
          <Text style={styles.filePath} numberOfLines={2}>
            {displayPath(file)}
          </Text>
          <Text style={styles.muted}>
            <Text style={styles.add}>+{file.additions}</Text> <Text style={styles.del}>−{file.deletions}</Text>
          </Text>
        </Pressable>
      );
    }
    case "note":
      return <Text style={styles.note}>{row.text}</Text>;
    case "hunk":
      return (
        <Text style={styles.hunk} numberOfLines={1}>
          {row.range}
          {row.section ? ` ${row.section}` : ""}
        </Text>
      );
    case "line":
      return <LineView line={row.line} />;
  }
}

function LineView({ line }: { line: DiffLine }) {
  const marker = line.kind === "add" ? "+" : line.kind === "del" ? "−" : " ";
  const bg = line.kind === "add" ? styles.lineAdd : line.kind === "del" ? styles.lineDel : undefined;
  return (
    <View style={[styles.line, bg]}>
      <Text style={styles.gutter}>{line.oldLine ?? ""}</Text>
      <Text style={styles.gutter}>{line.newLine ?? ""}</Text>
      <Text style={styles.code}>
        {marker}
        {line.text}
      </Text>
    </View>
  );
}

const MONO = "monospace";

const styles = StyleSheet.create({
  flex: { flex: 1 },
  center: { flex: 1, alignItems: "center", justifyContent: "center", padding: spacing.lg },
  list: { paddingBottom: spacing.xxl },
  error: { color: colors.destructive, textAlign: "center" },
  note: { color: colors.mutedForeground, fontSize: 13, paddingHorizontal: spacing.md, paddingVertical: spacing.xs },
  muted: { color: colors.mutedForeground, fontSize: 12 },
  add: { color: colors.success },
  del: { color: colors.destructive },
  checkout: {
    backgroundColor: colors.secondary,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    marginTop: spacing.sm,
    gap: spacing.xs,
  },
  checkoutName: { color: colors.foreground, fontWeight: "700", fontSize: 15 },
  file: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.sm,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    borderTopWidth: 1,
    borderColor: colors.border,
  },
  chevron: { color: colors.mutedForeground, width: 12 },
  statusBox: { borderWidth: 1, borderRadius: radius.sm, width: 20, height: 20, alignItems: "center", justifyContent: "center" },
  statusText: { fontSize: 12, fontWeight: "700" },
  filePath: { color: colors.foreground, flex: 1, fontFamily: MONO, fontSize: 13 },
  hunk: {
    color: colors.info,
    fontFamily: MONO,
    fontSize: 12,
    backgroundColor: colors.accent,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.xs,
  },
  line: { flexDirection: "row", alignItems: "flex-start" },
  lineAdd: { backgroundColor: "rgba(63,185,80,0.15)" },
  lineDel: { backgroundColor: "rgba(248,81,73,0.15)" },
  gutter: { width: 40, textAlign: "right", color: colors.mutedForeground, fontFamily: MONO, fontSize: 11, paddingTop: 2 },
  code: { flex: 1, color: colors.foreground, fontFamily: MONO, fontSize: 12, lineHeight: 17, paddingHorizontal: spacing.xs },
});
