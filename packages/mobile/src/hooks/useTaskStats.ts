import { useEffect, useState } from "react";
import { TASK_STATS_WINDOW_MS, type TaskStatsSample } from "@cloudagents/protocol";
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
  const { serverUrl } = useApiClient();
  const [samples, setSamples] = useState<readonly TaskStatsSample[]>([]);
  const [generation, setGeneration] = useState(0);

  useEffect(() => {
    setSamples([]);
  }, [taskId]);

  useEffect(() => {
    if (!serverUrl) return;
    let active = true;
    let retry: ReturnType<typeof setTimeout> | undefined;
    let first = true;

    const close = openTaskStats(serverUrl, taskId, {
      onFrame: (stats) => {
        const replace = first;
        first = false;
        setSamples((prev) => withinWindow(replace ? stats.samples : [...prev, ...stats.samples]));
      },
      onClose: () => {
        if (!active) return;
        retry = setTimeout(() => setGeneration((g) => g + 1), RECONNECT_MS);
      },
    });

    return () => {
      active = false;
      if (retry) clearTimeout(retry);
      close();
    };
  }, [serverUrl, taskId, generation]);

  return samples;
}
