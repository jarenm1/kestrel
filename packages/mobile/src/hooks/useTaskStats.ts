import { useEffect, useRef, useState } from "react";
import { Paths, TASK_STATS_WINDOW_MS, type TaskStatsSample } from "@cloudagents/protocol";
import { openTaskStats, reconnectDelay } from "@/api/events";
import { useApiClient } from "@/hooks/useApiClient";

/** Trims to the window the graphs draw, anchored on the newest sample so a slow clock never empties them. */
function withinWindow(samples: readonly TaskStatsSample[]): TaskStatsSample[] {
  const newest = samples[samples.length - 1];
  return newest === undefined ? [] : samples.filter((s) => s.at >= newest.at - TASK_STATS_WINDOW_MS);
}

/**
 * The thread's resource samples from the stats WebSocket: the first frame of a connection replaces them, later frames
 * append. The socket is open only while `live` (the desktop runs and the app is in the foreground). Reconnects back off
 * after a close; starts empty when the thread changes.
 */
export function useTaskStats(taskId: string, live: boolean): readonly TaskStatsSample[] {
  const { api } = useApiClient();
  const [samples, setSamples] = useState<readonly TaskStatsSample[]>([]);
  const [generation, setGeneration] = useState(0);
  const failures = useRef(0);

  useEffect(() => {
    setSamples([]);
  }, [taskId]);

  useEffect(() => {
    if (!live) return;
    let active = true;
    let retry: number | undefined;
    let first = true;
    let close: (() => void) | undefined;

    const reconnect = () => {
      if (!active) return;
      retry = setTimeout(() => setGeneration((g) => g + 1), reconnectDelay(failures.current++));
    };

    // A box token that cannot be minted, or a socket that cannot be opened, reconnects like a dropped socket.
    const open = async () => {
      const url = await api.socketUrl(Paths.taskStatsWs(taskId));
      if (!active) return;
      close = openTaskStats(url, {
        onOpen: () => {
          failures.current = 0;
          first = true;
        },
        onFrame: (stats) => {
          const replace = first;
          first = false;
          setSamples((prev) => withinWindow(replace ? stats.samples : [...prev, ...stats.samples]));
        },
        onClose: reconnect,
      });
    };
    open().catch(reconnect);

    return () => {
      active = false;
      clearTimeout(retry);
      close?.();
    };
  }, [api, taskId, live, generation]);

  return samples;
}
