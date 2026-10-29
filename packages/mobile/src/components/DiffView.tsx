import React, { useMemo, useState } from "react";
import { FlatList, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { useQuery } from "@tanstack/react-query";
import { ChevronRight } from "lucide-react-native";
import type { CheckoutDiff } from "@cloudagents/protocol";
import { createQueries } from "@/api/queries";
import { Alert } from "@/components/ui/Alert";
import { Button } from "@/components/ui/Button";
import { useApiClient } from "@/hooks/useApiClient";
import { type DiffFile, type DiffLine, displayPath, parseDiff } from "@/lib/diff";
import { errorText } from "@/lib/format";
import { colors, fonts, radius, spacing } from "@/theme";

/** Files with more changed lines than this start collapsed, so one huge file does not bury the rest. */
const LARGE_FILE_LINES = 1500;

/** Per-file collapse overrides, keyed by `${checkoutId}:${fileIndex}`. Absent keys use the size default. */
type Overrides = ReadonlyMap<string, boolean>;

type Row =
  | {
      kind: "checkout";
      key: string;
      repo: string;
      baseBranch: string;
      files: number;
      additions: number;
      deletions: number;
      fileKeys: readonly string[];
      anyExpanded: boolean;
    }
  | { kind: "file"; key: string; file: DiffFile; collapsed: boolean }
  | { kind: "note"; key: string; text: string };

const STATUS_STYLE: Record<DiffFile["status"], { letter: string; label: string; color: string; wash: string }> = {
  added: { letter: "A", label: "Added", color: colors.success, wash: colors.success + "26" },
  deleted: { letter: "D", label: "Deleted", color: colors.destructive, wash: colors.destructive + "26" },
  modified: { letter: "M", label: "Modified", color: colors.warning, wash: colors.warning + "26" },
  renamed: { letter: "R", label: "Renamed", color: colors.info, wash: colors.info + "26" },
};

const LINE_STYLE: Record<DiffLine["kind"], { row?: string; gutter: string; marker: string }> = {
  add: { row: colors.success + "1a", gutter: colors.success + "99", marker: "+" },
  del: { row: colors.destructive + "1a", gutter: colors.destructive + "99", marker: "-" },
  context: { gutter: colors.mutedForeground + "80", marker: " " },
};

function fileNotes(file: DiffFile): string[] {
  const notes: string[] = [];
  if (file.modeChange) notes.push(`Mode ${file.modeChange.from} → ${file.modeChange.to}`);
  if (file.binary) notes.push("Binary file not shown.");
  else if (file.hunks.length === 0 && file.status === "renamed") notes.push("Renamed without changes.");
  else if (file.hunks.length === 0 && file.status === "added") notes.push("Empty file.");
  else if (file.hunks.length === 0 && file.status === "deleted") notes.push("Empty file deleted.");
  return notes;
}

function withCollapsed(prev: Overrides, keys: readonly string[], collapsed: boolean): Overrides {
  const next = new Map(prev);
  for (const key of keys) next.set(key, collapsed);
  return next;
}

/** Flattens checkouts → files into one list for virtualised rendering; each file row carries its own hunks. */
function buildRows(checkouts: readonly CheckoutDiff[], overrides: Overrides): Row[] {
  const rows: Row[] = [];
  for (const checkout of checkouts) {
    const entries = parseDiff(checkout.diff).map((file, index) => {
      const key = `${checkout.checkoutId}:${index}`;
      const collapsed = overrides.get(key) ?? file.additions + file.deletions > LARGE_FILE_LINES;
      return { file, key, collapsed };
    });
    rows.push({
      kind: "checkout",
      key: `co:${checkout.checkoutId}`,
      repo: checkout.repo,
      baseBranch: checkout.baseBranch,
      files: entries.length,
      additions: entries.reduce((sum, e) => sum + e.file.additions, 0),
      deletions: entries.reduce((sum, e) => sum + e.file.deletions, 0),
      fileKeys: entries.map((e) => e.key),
      anyExpanded: entries.some((e) => !e.collapsed),
    });
    if (entries.length === 0) rows.push({ kind: "note", key: `co:${checkout.checkoutId}:none`, text: "No changes." });
    for (const entry of entries) {
      rows.push({ kind: "file", key: entry.key, file: entry.file, collapsed: entry.collapsed });
    }
  }
  return rows;
}

interface DiffViewProps {
  taskId: string;
  /** Polls while the agent is working so the diff follows its edits. */
  running: boolean;
}

export function DiffView({ taskId, running }: DiffViewProps) {
  const { api } = useApiClient();
  const diff = useQuery(createQueries(api).diff(taskId, running));
  const [overrides, setOverrides] = useState<Overrides>(new Map());
  const checkouts = diff.data?.checkouts;
  const rows = useMemo(() => buildRows(checkouts ?? [], overrides), [checkouts, overrides]);

  return (
    <View style={styles.root}>
      <View style={styles.toolbar}>
        <Button variant="soft" size="sm" onPress={() => void diff.refetch()} disabled={diff.isFetching}>
          {diff.isFetching ? "Refreshing…" : "Refresh"}
        </Button>
      </View>
      {diff.error ? <Alert style={styles.alert}>{errorText(diff.error)}</Alert> : null}
      {diff.isPending ? (
        <Text style={styles.muted}>Loading…</Text>
      ) : (
        <FlatList
          style={styles.list}
          contentContainerStyle={styles.content}
          data={rows}
          keyExtractor={(r) => r.key}
          renderItem={({ item }) => <RowView row={item} onOverrides={setOverrides} />}
          ListEmptyComponent={
            diff.isSuccess ? (
              <Text style={styles.note}>
                No repository checked out yet. The agent checks repos out when the work needs one.
              </Text>
            ) : undefined
          }
        />
      )}
    </View>
  );
}

function RowView({
  row,
  onOverrides,
}: {
  row: Row;
  onOverrides: React.Dispatch<React.SetStateAction<Overrides>>;
}) {
  switch (row.kind) {
    case "checkout": {
      const { repo, baseBranch, files, additions, deletions, fileKeys, anyExpanded } = row;
      return (
        <View style={styles.checkout}>
          <View style={styles.checkoutText}>
            <Text style={styles.checkoutName} numberOfLines={1}>
              {repo}
            </Text>
            <Text style={styles.muted} numberOfLines={1}>
              {files} {files === 1 ? "file" : "files"} vs {baseBranch}
            </Text>
          </View>
          <Text style={styles.stat}>
            <Text style={styles.add}>+{additions}</Text> <Text style={styles.del}>−{deletions}</Text>
          </Text>
          {files > 1 ? (
            <Button
              variant="ghost"
              size="sm"
              onPress={() => onOverrides((prev) => withCollapsed(prev, fileKeys, anyExpanded))}
            >
              {anyExpanded ? "Collapse all" : "Expand all"}
            </Button>
          ) : null}
        </View>
      );
    }
    case "file": {
      const { file, key, collapsed } = row;
      return (
        <FileView
          file={file}
          collapsed={collapsed}
          onToggle={() => onOverrides((prev) => new Map(prev).set(key, !collapsed))}
        />
      );
    }
    case "note":
      return <Text style={styles.note}>{row.text}</Text>;
  }
}

function FileView({ file, collapsed, onToggle }: { file: DiffFile; collapsed: boolean; onToggle: () => void }) {
  const status = STATUS_STYLE[file.status];
  const path = displayPath(file);
  const slash = path.lastIndexOf("/");
  return (
    <View style={styles.well}>
      <Pressable
        onPress={onToggle}
        accessibilityRole="button"
        accessibilityLabel={path}
        accessibilityState={{ expanded: !collapsed }}
        style={styles.fileHead}
      >
        <View style={[styles.chevron, !collapsed && styles.chevronOpen]}>
          <ChevronRight size={14} color={colors.mutedForeground} strokeWidth={2} />
        </View>
        <View accessibilityLabel={status.label} style={[styles.statusChip, { backgroundColor: status.wash }]}>
          <Text style={[styles.statusLetter, { color: status.color }]}>{status.letter}</Text>
        </View>
        <Text style={styles.filePath} numberOfLines={2}>
          {file.status === "renamed" ? <Text style={styles.muted}>{file.oldPath} → </Text> : null}
          <Text style={styles.muted}>{path.slice(0, slash + 1)}</Text>
          <Text style={styles.fileName}>{path.slice(slash + 1)}</Text>
        </Text>
        {file.binary ? (
          <Text style={styles.muted}>binary</Text>
        ) : (
          <Text style={styles.stat}>
            <Text style={styles.add}>+{file.additions}</Text> <Text style={styles.del}>−{file.deletions}</Text>
          </Text>
        )}
      </Pressable>
      {collapsed ? null : <FileBody file={file} />}
    </View>
  );
}

/** Hunks sit in a horizontal scroller so long lines scroll sideways; each line's background spans the widest line. */
function FileBody({ file }: { file: DiffFile }) {
  const [width, setWidth] = useState(0);
  const notes = fileNotes(file);
  return (
    <View>
      {notes.map((note) => (
        <Text key={note} style={styles.bodyNote}>
          {note}
        </Text>
      ))}
      {file.hunks.length > 0 ? (
        <ScrollView horizontal onLayout={(e) => setWidth(e.nativeEvent.layout.width)}>
          <View style={{ minWidth: width }}>
            {file.hunks.map((hunk, h) => (
              <View key={h}>
                <Text style={styles.hunk}>
                  {hunk.range}
                  {hunk.section ? <Text style={styles.hunkSection}>{` ${hunk.section}`}</Text> : null}
                </Text>
                {hunk.lines.map((line, l) => (
                  <LineView key={l} line={line} />
                ))}
              </View>
            ))}
          </View>
        </ScrollView>
      ) : null}
    </View>
  );
}

function LineView({ line }: { line: DiffLine }) {
  const tone = LINE_STYLE[line.kind];
  return (
    <View style={[styles.line, tone.row ? { backgroundColor: tone.row } : null]}>
      <Text style={[styles.gutter, { color: tone.gutter }]}>{line.oldLine ?? ""}</Text>
      <Text style={[styles.gutter, { color: tone.gutter }]}>{line.newLine ?? ""}</Text>
      <Text style={[styles.marker, { color: tone.gutter }]}>{tone.marker}</Text>
      <Text style={styles.code}>
        {line.text}
        {line.noNewline ? <Text style={styles.noNewline}>{"  no newline at end of file"}</Text> : null}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, paddingHorizontal: spacing.md },
  toolbar: { flexDirection: "row", justifyContent: "flex-end", paddingVertical: spacing.sm },
  alert: { marginBottom: spacing.sm },
  list: { flex: 1 },
  content: { paddingBottom: spacing.xl, gap: spacing.sm },
  muted: { color: colors.mutedForeground, fontSize: 12 },
  note: { color: colors.mutedForeground, fontSize: 13, paddingVertical: spacing.sm },
  stat: { fontFamily: fonts.mono, fontSize: 12 },
  add: { color: colors.success },
  del: { color: colors.destructive },
  checkout: { flexDirection: "row", alignItems: "center", gap: spacing.sm, paddingTop: spacing.md },
  checkoutText: { flex: 1, minWidth: 0, gap: 2 },
  checkoutName: { color: colors.foreground, fontSize: 14, fontWeight: "500" },
  well: { backgroundColor: colors.code, borderRadius: radius.xl, overflow: "hidden" },
  fileHead: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.sm,
    minHeight: 36,
    paddingHorizontal: spacing.md,
    backgroundColor: colors.card,
  },
  chevron: { width: 14, height: 14, alignItems: "center", justifyContent: "center" },
  chevronOpen: { transform: [{ rotate: "90deg" }] },
  statusChip: { width: 16, height: 16, borderRadius: 4, alignItems: "center", justifyContent: "center" },
  statusLetter: { fontFamily: fonts.mono, fontSize: 10, fontWeight: "600" },
  filePath: { flex: 1, minWidth: 0, fontFamily: fonts.mono, fontSize: 12, color: colors.foreground },
  fileName: { fontWeight: "600", color: colors.foreground },
  bodyNote: { color: colors.mutedForeground, fontSize: 12, paddingHorizontal: spacing.md, paddingVertical: 6 },
  hunk: {
    color: colors.info + "cc",
    backgroundColor: colors.info + "12",
    fontFamily: fonts.mono,
    fontSize: 12,
    lineHeight: 17,
    paddingHorizontal: spacing.md,
    paddingVertical: 2,
  },
  hunkSection: { color: colors.mutedForeground },
  line: { flexDirection: "row" },
  gutter: {
    minWidth: 40,
    paddingHorizontal: spacing.sm,
    textAlign: "right",
    fontFamily: fonts.mono,
    fontSize: 11,
    lineHeight: 17,
  },
  marker: { width: 18, textAlign: "center", fontFamily: fonts.mono, fontSize: 12, lineHeight: 17 },
  code: {
    fontFamily: fonts.mono,
    fontSize: 12,
    lineHeight: 17,
    color: colors.foreground + "e6",
    paddingRight: spacing.lg,
  },
  noNewline: { color: colors.mutedForeground, fontSize: 10 },
});
