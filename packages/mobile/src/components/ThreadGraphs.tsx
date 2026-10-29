import React, { useId, useMemo } from "react";
import { StyleSheet, Text, View } from "react-native";
import Svg, { Defs, Line, LinearGradient, Path, Stop } from "react-native-svg";
import { TASK_STATS_WINDOW_MS, type TaskStatsSample } from "@cloudagents/protocol";
import { useTaskStats } from "@/hooks/useTaskStats";
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

/**
 * The thread's RAM, CPU and storage against its limits over the last minute, plus GPU's shared VRAM.
 */
export function ThreadGraphs({ taskId }: { taskId: string }) {
  const samples = useTaskStats(taskId);

  return (
    <View style={styles.container}>
      {GRAPHS.map((g) => (
        <Graph key={g.label} label={g.label} points={pointsOf(samples, g.value)} />
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    gap: spacing.sm,
    paddingVertical: spacing.sm,
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
});

