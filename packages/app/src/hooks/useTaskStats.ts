import { useEffect, useRef, useState } from "react"
import { TASK_STATS_WINDOW_MS, type TaskStatsSample } from "@cloudagents/protocol"
import { openTaskStats, reconnectDelay } from "@/api/events"

/** Trims to the window the graphs draw, anchored on the newest sample so a slow clock never empties them. */
function withinWindow(samples: readonly TaskStatsSample[]): TaskStatsSample[] {
  const newest = samples[samples.length - 1]
  return newest === undefined ? [] : samples.filter((s) => s.at >= newest.at - TASK_STATS_WINDOW_MS)
}

/**
 * The thread's resource samples from the stats WebSocket: the first frame of a connection replaces them, later frames
 * append. Reconnects back off after a close (resolving the stream re-reads every box's threads); starts empty when
 * the thread changes.
 */
export function useTaskStats(taskId: string): readonly TaskStatsSample[] {
  const [samples, setSamples] = useState<readonly TaskStatsSample[]>([])
  const [generation, setGeneration] = useState(0)
  const attempts = useRef(0)

  useEffect(() => {
    attempts.current = 0
    setSamples([])
  }, [taskId])

  useEffect(() => {
    let active = true
    let retry: number | undefined
    let first = true

    const close = openTaskStats(taskId, {
      onFrame: (stats) => {
        attempts.current = 0
        // Captured now: React may run the updater after `first` has already been flipped.
        const replace = first
        first = false
        setSamples((prev) => withinWindow(replace ? stats.samples : [...prev, ...stats.samples]))
      },
      onClose: () => {
        if (!active) return
        retry = window.setTimeout(() => setGeneration((g) => g + 1), reconnectDelay(attempts.current++))
      },
    })

    return () => {
      active = false
      window.clearTimeout(retry)
      close()
    }
  }, [taskId, generation])

  return samples
}
