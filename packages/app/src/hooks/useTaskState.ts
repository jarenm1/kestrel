import { useEffect, useState } from "react"
import { useQueries, useQueryClient, type QueryClient } from "@tanstack/react-query"
import { mergeRunUpdate, type Message, type Run, type RunItems, type Task } from "@cloudagents/protocol"
import { openTaskEvents } from "@/api/events"
import { invalidateRunItems, keys, queries, storeTask, upsert } from "@/api/queries"
import { applyDesktopStatus, type DesktopStatusValue } from "@cloudagents/protocol"
import { isDesktopStreamActive } from "@/desktop/status"
import { threadErrors } from "./threadErrors"

const MAX_LOG_LINES = 2000
const RECONNECT_MS = 2000
/** Items arrive far faster than the diff is worth fetching; one invalidation per window bounds that traffic. */
const DIFF_INVALIDATE_MS = 3000

/**
 * Applies a live run update to the cached list. The event's run comes from the state store, which never holds saved
 * evidence (clips live on disk), so the cached clips stay until a new snapshot carries them.
 */
export function storeRunUpdate(client: QueryClient, taskId: string, run: Run): void {
  client.setQueryData(keys.runs(taskId), (list: Run[] | undefined) =>
    upsert(list, mergeRunUpdate(list?.find((cached) => cached.id === run.id), run)),
  )
}

/** What the pull request panel shows of the registry: adding, dropping or toggling a watch changes it. */
const registrySignature = (task: Task | undefined): string =>
  (task?.pullRequests ?? []).map((pr) => `${pr.id}:${pr.watching === true ? 1 : 0}`).join(",")

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

    /** The diff and file list follow the worktree; only open panels refetch. */
    const refetchWorktree = () => {
      void queryClient.invalidateQueries({ queryKey: keys.diff(taskId) })
      void queryClient.invalidateQueries({ queryKey: keys.files(taskId) })
    }
    /** At most one worktree invalidation per interval: the first item goes through, later ones share one trailing run. */
    const invalidateWorktree = () => {
      diffInvalidatedAt = Date.now()
      refetchWorktree()
    }
    const invalidateWorktreeThrottled = () => {
      const wait = DIFF_INVALIDATE_MS - (Date.now() - diffInvalidatedAt)
      if (wait <= 0) {
        invalidateWorktree()
        return
      }
      diffTimer ??= window.setTimeout(() => {
        diffTimer = undefined
        invalidateWorktree()
      }, wait)
    }

    const close = openTaskEvents(taskId, {
      onOpen: () => {
        setDisconnected(false)
        // Prefix invalidation refreshes task, messages and runs, including events missed while disconnected.
        void queryClient.invalidateQueries({ queryKey: keys.task(taskId) })
        // Run items live under ["runs", runId, "items"], outside the task prefix.
        const cachedRuns = queryClient.getQueryData<readonly Run[]>(keys.runs(taskId)) ?? []
        invalidateRunItems(
          queryClient,
          cachedRuns.map((run) => run.id),
        )
      },
      onEvent: (event) => {
        switch (event._tag) {
          case "task.updated": {
            const before = registrySignature(queryClient.getQueryData<Task>(keys.task(taskId)))
            storeTask(queryClient, event.task)
            // The pull request panel polls GitHub on its own; refetch it only when the registry itself changed
            // (a pull request was opened, linked or watched), not on every task update of a run.
            if (before !== registrySignature(event.task)) {
              void queryClient.invalidateQueries({ queryKey: keys.pullRequests(taskId), exact: true })
            }
            break
          }
          case "task.deleted":
            // The thread list stream drops the thread; nothing else in this view needs to hear about it.
            break
          case "message.created":
            queryClient.setQueryData(keys.messages(taskId), (list: Message[] | undefined) =>
              upsert(list, event.message),
            )
            break
          case "run.updated":
            storeRunUpdate(queryClient, taskId, event.run)
            // A run starting or ending is when the worktree changes; the diff and files have no events of their own.
            refetchWorktree()
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
            // Items are what change the worktree, so the diff and files follow them; a run.updated covers the ends.
            invalidateWorktreeThrottled()
            break
          case "desktop.updated": {
            // Only a move into "running" counts as the agent opening it. While a viewer streams, its frames win.
            const previous = queryClient.getQueryData<DesktopStatusValue>(keys.desktop(taskId))
            const next = applyDesktopStatus(
              previous,
              event.desktop,
              "event",
              undefined,
              isDesktopStreamActive(taskId),
            )
            if (next === previous) break
            queryClient.setQueryData(keys.desktop(taskId), next)
            // A first load of an already-running desktop is not the agent opening it.
            if (previous !== undefined && previous.status.state !== "running" && next.status.state === "running") {
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

  const running = runs.data?.some((run) => run.status === "running") === true
  const { error, loadError } = threadErrors([task, messages, runs], disconnected, running)

  return {
    task: task.data ?? null,
    messages: messages.data ?? [],
    runs: runs.data ?? [],
    output,
    desktopOpens,
    error,
    loadError,
  }
}
