import { useEffect, useState } from "react"
import { useQueries, useQueryClient } from "@tanstack/react-query"
import type { DesktopStatus, Message, Run, RunItems } from "@cloudagents/protocol"
import { openTaskEvents } from "@/api/events"
import { keys, queries, storeTask, upsert } from "@/api/queries"
import { errorText } from "@/util"

const MAX_LOG_LINES = 2000
const RECONNECT_MS = 2000
/** Items arrive far faster than the diff is worth fetching; one invalidation per window bounds that traffic. */
const DIFF_INVALIDATE_MS = 3000

/**
 * Task chat state: REST snapshots in the query cache, kept current by the task events WebSocket.
 * Each (re)connect re-snapshots; live events are written straight into the same cache entries.
 * The stream is read from the box the thread lives on.
 * Callers should key by taskId.
 */
export function useTaskState(taskId: string) {
  const queryClient = useQueryClient()
  // The desktop query is the baseline for desktop.updated transitions; keeping it live keeps that cache entry current.
  const [task, messages, runs] = useQueries({
    queries: [queries.task(taskId), queries.messages(taskId), queries.runs(taskId), queries.desktop(taskId)],
  })
  const [output, setOutput] = useState<Record<string, string[]>>({})
  const [disconnected, setDisconnected] = useState(false)
  const [generation, setGeneration] = useState(0)
  const [desktopOpens, setDesktopOpens] = useState(0)

  useEffect(() => {
    let active = true
    let retry: number | undefined
    let diffTimer: number | undefined
    let diffInvalidatedAt = 0

    /** At most one diff invalidation per interval: the first item goes through, later ones share one trailing run. */
    const invalidateDiff = () => {
      diffInvalidatedAt = Date.now()
      void queryClient.invalidateQueries({ queryKey: keys.diff(taskId) })
    }
    const invalidateDiffThrottled = () => {
      const wait = DIFF_INVALIDATE_MS - (Date.now() - diffInvalidatedAt)
      if (wait <= 0) {
        invalidateDiff()
        return
      }
      diffTimer ??= window.setTimeout(() => {
        diffTimer = undefined
        invalidateDiff()
      }, wait)
    }

    const close = openTaskEvents(taskId, {
      onOpen: () => {
        setDisconnected(false)
        void queryClient.invalidateQueries({ queryKey: keys.task(taskId) })
      },
      onEvent: (event) => {
        switch (event._tag) {
          case "task.updated":
            storeTask(queryClient, event.task)
            break
          case "task.deleted":
            // The thread list stream drops the thread; nothing else in this view needs to hear about it.
            break
          case "message.created":
            queryClient.setQueryData(keys.messages(taskId), (list: Message[] | undefined) =>
              upsert(list, event.message),
            )
            break
          case "run.updated":
            queryClient.setQueryData(keys.runs(taskId), (list: Run[] | undefined) => upsert(list, event.run))
            // A run starting or ending is when the worktree changes; the diff has no events of its own.
            void queryClient.invalidateQueries({ queryKey: keys.diff(taskId) })
            break
          case "agent.output":
            setOutput((prev) => ({
              ...prev,
              [event.runId]: [...(prev[event.runId] ?? []), ...event.text.split("\n")].slice(-MAX_LOG_LINES),
            }))
            break
          case "agent.item":
            // Same id means the item was replaced (a tool finishing), so upsert keeps its place.
            queryClient.setQueryData(keys.runItems(event.runId), (list: RunItems | undefined) =>
              upsert(list, event.item),
            )
            // Items are what change the worktree, so the diff follows them; a run.updated covers the ends.
            invalidateDiffThrottled()
            break
          case "desktop.updated": {
            // Only a move into "running" counts as the agent opening it.
            const previous = queryClient.getQueryData<DesktopStatus>(keys.desktop(taskId))
            queryClient.setQueryData(keys.desktop(taskId), event.desktop)
            if (previous && previous.state !== "running" && event.desktop.state === "running") {
              setDesktopOpens((n) => n + 1)
            }
            break
          }
        }
      },
      onClose: () => {
        if (!active) return
        setDisconnected(true)
        retry = window.setTimeout(() => setGeneration((g) => g + 1), RECONNECT_MS)
      },
    })

    return () => {
      active = false
      window.clearTimeout(retry)
      window.clearTimeout(diffTimer)
      close()
    }
  }, [taskId, generation, queryClient])

  const failed = [task, messages, runs].find((q) => q.error)
  const error = disconnected
    ? "Live updates disconnected; reconnecting…"
    : failed?.error
      ? errorText(failed.error)
      : null

  return {
    task: task.data ?? null,
    messages: messages.data ?? [],
    runs: runs.data ?? [],
    output,
    desktopOpens,
    error,
  }
}
