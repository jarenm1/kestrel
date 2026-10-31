import React, { useEffect, useState } from "react";
import { Image, StyleSheet, Text, View } from "react-native";
import Svg, { Defs, LinearGradient, Rect, Stop } from "react-native-svg";
import { Paths, THREAD_TINTS, threadIdentity, type Task } from "@cloudagents/protocol";
import type { FileSource } from "@/api/client";
import { useApiClient } from "@/hooks/useApiClient";
import { fonts } from "@/theme";

const SIZE = 28;
const RADIUS = 8;

/**
 * Same identity and glass as the web tile: the first checkout's repository icon once it has loaded, else the
 * monogram. Glass is the tint, a hard sheen across the top half, and a border lit from above.
 */
export function ThreadAvatar({ task }: { task: Pick<Task, "id" | "title" | "checkouts"> }) {
  const { monogram, tone, icon } = threadIdentity(task);
  const { api } = useApiClient();
  const path = icon === null ? null : Paths.taskCheckoutIcon(task.id, icon.checkoutId, icon.blob);
  const [source, setSource] = useState<FileSource | null>(null);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    let active = true;
    setSource(null);
    setLoaded(false);
    if (path === null) return;
    // A failed token mint keeps the monogram; the box queries report the same failure.
    api
      .fileSource(path)
      .then((resolved) => {
        if (active) setSource(resolved);
      })
      .catch(() => undefined);
    return () => {
      active = false;
    };
  }, [api, path]);

  // Icons bring their own colours: they sit on the neutral graphite glass.
  const finish = loaded ? 7 : tone;
  const [from, to] = THREAD_TINTS[finish];
  const id = `thread-avatar-${finish}`;
  return (
    <View style={styles.tile}>
      <Svg width={SIZE} height={SIZE} style={StyleSheet.absoluteFill}>
        <Defs>
          <LinearGradient id={`${id}-tint`} x1="0" y1="0" x2="1" y2="1">
            <Stop offset="0" stopColor={from} />
            <Stop offset="1" stopColor={to} />
          </LinearGradient>
          <LinearGradient id={`${id}-sheen`} x1="0" y1="0" x2="0" y2="1">
            <Stop offset="0" stopColor="#ffffff" stopOpacity={0.18} />
            <Stop offset="0.5" stopColor="#ffffff" stopOpacity={0.07} />
            <Stop offset="0.5" stopColor="#ffffff" stopOpacity={0} />
          </LinearGradient>
          <LinearGradient id={`${id}-edge`} x1="0" y1="0" x2="0" y2="1">
            <Stop offset="0" stopColor="#ffffff" stopOpacity={0.32} />
            <Stop offset="0.5" stopColor="#ffffff" stopOpacity={0.06} />
            <Stop offset="1" stopColor="#ffffff" stopOpacity={0.02} />
          </LinearGradient>
        </Defs>
        <Rect width={SIZE} height={SIZE} rx={RADIUS} fill={`url(#${id}-tint)`} />
        <Rect width={SIZE} height={SIZE} rx={RADIUS} fill={`url(#${id}-sheen)`} />
        <Rect
          x={0.5}
          y={0.5}
          width={SIZE - 1}
          height={SIZE - 1}
          rx={RADIUS - 0.5}
          fill="none"
          stroke={`url(#${id}-edge)`}
          strokeWidth={1}
        />
      </Svg>
      {!loaded && <Text style={styles.monogram} accessible={false}>{monogram}</Text>}
      {source !== null && (
        <Image
          source={source}
          resizeMode="contain"
          style={loaded ? styles.icon : styles.pending}
          onLoad={() => setLoaded(true)}
          onError={() => setLoaded(false)}
        />
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  tile: { width: SIZE, height: SIZE, flexShrink: 0, alignItems: "center", justifyContent: "center" },
  icon: { width: 18, height: 18 },
  // Loads invisibly; a failure (not decodable, e.g. some .ico) keeps the monogram.
  pending: { position: "absolute", width: 18, height: 18, opacity: 0 },
  monogram: {
    color: "rgba(255,255,255,0.95)",
    fontFamily: fonts.sans,
    fontSize: 11,
    lineHeight: 13,
    fontWeight: "600",
    includeFontPadding: false,
    textAlignVertical: "center",
    textShadowColor: "rgba(0,0,0,0.35)",
    textShadowOffset: { width: 0, height: 1 },
    textShadowRadius: 1,
  },
});
