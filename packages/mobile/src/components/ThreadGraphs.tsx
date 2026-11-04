import React, { useId, useMemo, useState } from "react";
import { StyleSheet, Text, View } from "react-native";
import Svg, { Defs, Line, LinearGradient, Path, Stop } from "react-native-svg";
import {
  TASK_STATS_WINDOW_MS,
  type TaskAppUsage,
  type TaskRamOther,
  type TaskStatsSample,
} from "@cloudagents/protocol";
import { Button } from "@/components/ui/Button";
import { useTaskStats } from "@/hooks/useTaskStats";
import { formatSize } from "@/lib/format";
import { colors, fonts, radius, spacing } from "@/theme";

const W = 300;
const H = 60;
const HEADROOM = 0.1;

const ratio = (used: number | null, max: number | null): number | null =>
  used === null || max === null || max <= 0 ? null : used / max;

const GRAPHS: readonly { label: string; value: (s: TaskStatsSample) => number | null }[] = [
  { label: "RAM", value: (s) => ratio(s.ramUsed, s.ramMax) },
  { label: "VRAM · shared", value: (s) => ratio(s.vramUsed, s.vramTotal) },
  { label: "CPU", value: (s) => s.cpu },
  { label: "Storage", value: (s) => ratio(s.diskUsed, s.diskMax) },
];

interface Point {
  readonly x: number;
  readonly y: number;
  readonly value: number;
}

const yOf = (v: number): number => HEADROOM + (1 - HEADROOM) * (1 - Math.min(1, Math.max(0, v)));

function pointsOf(samples: readonly TaskStatsSample[], value: (s: TaskStatsSample) => number | null): Point[] {
  const newest = samples.at(-1)?.at ?? 0;
  const points: Point[] = [];
  for (const s of samples) {
    const v = value(s);
    if (v === null || !Number.isFinite(v)) continue;
    points.push({
      x: Math.max(0, Math.min(1, 1 - (newest - s.at) / TASK_STATS_WINDOW_MS)),
      y: yOf(v),
      value: v,
    });
  }
  return points;
}

function percentText(value: number): string {
  if (value > 0 && value < 0.01) return "<1%";
  return `${Math.round(value * 100)}%`;
}

function Graph({ label, points }: { label: string; points: readonly Point[] }) {
  const rawId = useId();
  const gradId = `tg_${rawId.replace(/[^a-zA-Z0-9]/g, "")}`;
  const latest = points.at(-1)?.value ?? null;
  const drawn = points.length >= 2;

  const lineD = useMemo(() => {
    if (!drawn) return "";
    const coords = points.map((p) => `${(p.x * W).toFixed(1)},${(p.y * H).toFixed(1)}`);
    return `M${coords.join("L")}`;
  }, [points, drawn]);

  const areaD = useMemo(() => {
    if (!drawn || !lineD) return "";
    const firstX = (points[0]!.x * W).toFixed(1);
    return `${lineD}L${W},${H}L${firstX},${H}Z`;
  }, [points, drawn, lineD]);

  return (
    <View style={styles.card}>
      <View style={styles.header}>
        <Text style={styles.label}>{label}</Text>
        <Text style={styles.value}>{latest !== null ? percentText(latest) : "—"}</Text>
      </View>
      <View style={styles.svgWrap}>
        <Svg width="100%" height={H} viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none">
          <Defs>
            <LinearGradient id={gradId} x1="0" y1="0" x2="0" y2="1">
              <Stop offset="0%" stopColor="#ffffff" stopOpacity={0.22} />
              <Stop offset="100%" stopColor="#ffffff" stopOpacity={0} />
            </LinearGradient>
          </Defs>
          {[0.25, 0.5, 0.75].map((q) => {
            const y = yOf(q) * H;
            return <Line key={q} x1={0} x2={W} y1={y} y2={y} stroke="rgba(255,255,255,0.06)" strokeWidth={1} />;
          })}
          {drawn && areaD ? <Path d={areaD} fill={`url(#${gradId})`} /> : null}
          {drawn && lineD ? (
            <Path
              d={lineD}
              fill="none"
              stroke="rgba(255,255,255,0.8)"
              strokeWidth={1.5}
              strokeLinejoin="round"
            />
          ) : null}
        </Svg>
      </View>
    </View>
  );
}

/** One row of the applications list; `program` is false for memory no process maps, which has no CPU. */
interface AppRow {
  readonly name: string;
  readonly program: boolean;
  readonly detail: string | null;
  readonly ramUsed: number;
  readonly cpu: number | null;
}

/** The latest sample as rows: its applications, most memory first, then the slice's memory outside any process. */
function appRows(apps: readonly TaskAppUsage[], other: TaskRamOther | null | undefined): AppRow[] {
  const rows: AppRow[] = apps.map((a) => ({
    name: a.name ?? "Other",
    program: a.name !== null,
    detail: a.processes > 1 ? `${a.processes} processes` : null,
    ramUsed: a.ramUsed,
    cpu: a.cpu,
  }));
  if (other) {
    const rest: readonly [string, number][] = [
      ["Page cache", other.pageCache],
      ["tmpfs & shared memory", other.tmpfs],
      ["Kernel", other.kernel],
    ];
    for (const [name, ramUsed] of rest) {
      if (ramUsed > 0) rows.push({ name, program: false, detail: null, ramUsed, cpu: null });
    }
  }
  return rows;
}

/**
 * What each application in the thread uses now, with its RAM against the thread's RAM limit, then the memory the
 * thread holds outside its processes. Memory processes share is divided between them, so the rows add up to the total.
 */
function Applications({ sample }: { sample: TaskStatsSample | undefined }) {
  if (sample === undefined) return <Text style={styles.appDetail}>Waiting for the first reading…</Text>;
  const { apps, ramUsed, ramMax } = sample;
  if (apps === undefined || ramUsed === null || ramMax === null || ramMax <= 0) {
    return <Text style={styles.appDetail}>This box does not report applications.</Text>;
  }
  const rows = appRows(apps, sample.ramOther);
  return (
    <View style={styles.apps}>
      <View style={styles.appsHeader}>
        <Text style={styles.label}>RAM · CPU</Text>
        <Text style={styles.label}>
          {formatSize(ramUsed)} of {formatSize(ramMax)}
        </Text>
      </View>
      {rows.length === 0 ? (
        <Text style={styles.appDetail}>Nothing running</Text>
      ) : (
        rows.map((row) => (
          <View key={`${row.program}:${row.name}`} style={styles.appRow}>
            <View style={styles.appLine}>
              <Text style={styles.appName} numberOfLines={1}>
                <Text style={row.program ? styles.appProgram : styles.appDetail}>{row.name}</Text>
                {row.detail ? <Text style={styles.appDetail}>{`  ${row.detail}`}</Text> : null}
              </Text>
              <Text style={styles.appValue}>{formatSize(row.ramUsed)}</Text>
              <Text style={[styles.appValue, styles.appCpu]}>{row.cpu === null ? "" : percentText(row.cpu)}</Text>
            </View>
            <View style={styles.barTrack}>
              <View style={[styles.barFill, { width: `${Math.min(100, (row.ramUsed / ramMax) * 100)}%` }]} />
            </View>
          </View>
        ))
      )}
      <Text style={styles.label}>Memory shared by several processes is split between them.</Text>
    </View>
  );
}

const VIEWS = [
  { id: "resources", label: "Resources" },
  { id: "applications", label: "Applications" },
] as const;

/**
 * Two tabs under the desktop. Resources: the thread's RAM, CPU and storage against its limits over the last minute,
 * plus GPU's shared VRAM. Applications: what each application in the thread uses now.
 */
export function ThreadGraphs({ taskId }: { taskId: string }) {
  const samples = useTaskStats(taskId);
  const [view, setView] = useState<(typeof VIEWS)[number]["id"]>("resources");

  return (
    <View style={styles.container}>
      <View style={styles.tabs}>
        {VIEWS.map((v) => (
          <Button
            key={v.id}
            variant={view === v.id ? "soft" : "ghost"}
            size="sm"
            active={view === v.id}
            onPress={() => setView(v.id)}
          >
            {v.label}
          </Button>
        ))}
      </View>
      {view === "resources" ? (
        GRAPHS.map((g) => <Graph key={g.label} label={g.label} points={pointsOf(samples, g.value)} />)
      ) : (
        <Applications sample={samples.at(-1)} />
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    gap: spacing.sm,
    paddingVertical: spacing.sm,
  },
  tabs: {
    flexDirection: "row",
    gap: spacing.xs,
  },
  card: {
    height: 70,
    borderRadius: radius.md,
    backgroundColor: colors.card,
    overflow: "hidden",
    position: "relative",
    borderWidth: 1,
    borderColor: colors.border,
  },
  header: {
    position: "absolute",
    top: 6,
    left: spacing.sm,
    right: spacing.sm,
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    zIndex: 1,
  },
  label: {
    fontSize: 11,
    fontWeight: "500",
    color: colors.mutedForeground,
  },
  value: {
    fontSize: 11,
    fontFamily: fonts.mono,
    color: colors.foreground,
  },
  svgWrap: {
    position: "absolute",
    bottom: 0,
    left: 0,
    right: 0,
    height: H,
  },
  apps: {
    borderRadius: radius.md,
    backgroundColor: colors.card,
    borderWidth: 1,
    borderColor: colors.border,
    paddingHorizontal: spacing.sm,
    paddingVertical: 6,
    gap: 6,
  },
  appsHeader: {
    flexDirection: "row",
    justifyContent: "space-between",
  },
  appRow: {
    gap: 2,
  },
  appLine: {
    flexDirection: "row",
    alignItems: "baseline",
    gap: spacing.sm,
  },
  appName: {
    flex: 1,
    fontSize: 12,
  },
  appProgram: {
    fontFamily: fonts.mono,
    color: colors.foreground,
  },
  appDetail: {
    fontSize: 12,
    color: colors.mutedForeground,
  },
  appValue: {
    width: 64,
    textAlign: "right",
    fontSize: 12,
    fontFamily: fonts.mono,
    color: colors.mutedForeground,
  },
  appCpu: {
    width: 40,
  },
  barTrack: {
    height: 4,
    borderRadius: 2,
    overflow: "hidden",
    backgroundColor: "rgba(255,255,255,0.05)",
  },
  barFill: {
    height: "100%",
    borderRadius: 2,
    backgroundColor: "rgba(255,255,255,0.6)",
  },
});

