import { useEffect, useState } from "react";
import { Paths, TASK_STATS_WINDOW_MS, type TaskStatsSample } from "@cloudagents/protocol";
import { openTaskStats } from "@/api/events";
import { useApiClient } from "@/hooks/useApiClient";

const RECONNECT_MS = 2000;

/** Trims to the window the graphs draw, anchored on the newest sample so a slow clock never empties them. */
function withinWindow(samples: readonly TaskStatsSample[]): TaskStatsSample[] {
  const newest = samples[samples.length - 1];
  return newest === undefined ? [] : samples.filter((s) => s.at >= newest.at - TASK_STATS_WINDOW_MS);
}

/**
 * The thread's resource samples from the stats WebSocket: the first frame of a connection replaces them, later frames
 * append. Reconnects 2 s after a close; starts empty when the thread changes.
 */
export function useTaskStats(taskId: string): readonly TaskStatsSample[] {
  const { api } = useApiClient();
  const [samples, setSamples] = useState<readonly TaskStatsSample[]>([]);
  const [generation, setGeneration] = useState(0);

  useEffect(() => {
    setSamples([]);
  }, [taskId]);

  useEffect(() => {
    let active = true;
    let retry: ReturnType<typeof setTimeout> | undefined;
    let first = true;
    let close: (() => void) | undefined;

    const reconnect = () => {
      if (!active) return;
      retry = setTimeout(() => setGeneration((g) => g + 1), RECONNECT_MS);
    };

    // A box token that cannot be minted, or a socket that cannot be opened, reconnects like a dropped socket.
    const open = async () => {
      const url = await api.socketUrl(Paths.taskStatsWs(taskId));
      if (!active) return;
      close = openTaskStats(url, {
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
  }, [api, taskId, generation]);

  return samples;
}
