import React, { useEffect, useState } from "react";
import { Image, StyleSheet, Text, View } from "react-native";
import Svg, { Defs, LinearGradient, Rect, Stop } from "react-native-svg";
import { Paths, THREAD_TINTS, threadIdentity, type Task } from "@cloudagents/protocol";
import type { FileSource } from "@/api/client";
import { useApiClient } from "@/hooks/useApiClient";
import { fonts } from "@/theme";

/** Tile size and corner radius: the regular tile, and `small` beside text (the web's `size-4.5`). */
const TILE = { regular: { size: 28, radius: 8, font: 11 }, small: { size: 18, radius: 5, font: 7.5 } } as const;

/**
 * Same identity and glass as the web tile: the first checkout's repository icon once it has loaded, else the
 * monogram on glass. Glass is the tint, a hard sheen across the top half, and a border lit from above. A loaded
 * icon is the tile itself: it covers the frame and is clipped to the tile's corner radius, with no glass behind it.
 * `small` is the inline size used beside text, ahead of the repository name in the thread list.
 */
export function ThreadAvatar({ task, small = false }: { task: Pick<Task, "id" | "title" | "checkouts">; small?: boolean }) {
  const { size: SIZE, radius: RADIUS, font } = small ? TILE.small : TILE.regular;
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

  const [from, to] = THREAD_TINTS[tone];
  const id = `thread-avatar-${tone}`;
  return (
    <View style={[styles.tile, { width: SIZE, height: SIZE }]}>
      {!loaded && (
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
      )}
      {!loaded && (
        <Text style={[styles.monogram, { fontSize: font, lineHeight: Math.round(font * 1.2) }]} accessible={false}>
          {monogram}
        </Text>
      )}
      {source !== null && (
        <Image
          source={source}
          resizeMode="cover"
          style={loaded ? { width: SIZE, height: SIZE, borderRadius: RADIUS } : styles.pending}
          onLoad={() => setLoaded(true)}
          onError={() => setLoaded(false)}
        />
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  tile: { flexShrink: 0, alignItems: "center", justifyContent: "center" },
  // Loads invisibly; a failure (not decodable, e.g. some .ico) keeps the monogram.
  pending: { position: "absolute", width: 18, height: 18, opacity: 0 },
  monogram: {
    color: "rgba(255,255,255,0.95)",
    fontFamily: fonts.sans,
    fontWeight: "600",
    includeFontPadding: false,
    textAlignVertical: "center",
    textShadowColor: "rgba(0,0,0,0.35)",
    textShadowOffset: { width: 0, height: 1 },
    textShadowRadius: 1,
  },
});
