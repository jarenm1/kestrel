import { useEffect, useState } from "react"
import { useQueries, useQueryClient } from "@tanstack/react-query"
import type { Message, Run } from "@cloudagents/protocol"
import { openTaskEvents } from "@/api/events"
import { keys, queries, upsert } from "@/api/queries"
import { errorText } from "@/util"

const MAX_LOG_LINES = 2000
const RECONNECT_MS = 2000

/**
 * Task chat state: REST snapshots in the query cache, kept current by the task events WebSocket.
 * Each (re)connect re-snapshots; live events are written straight into the same cache entries.
 * Callers should key by taskId.
 */
export function useTaskState(taskId: string) {
  const queryClient = useQueryClient()
  const [task, messages, runs] = useQueries({
    queries: [queries.task(taskId), queries.messages(taskId), queries.runs(taskId)],
  })
  const [output, setOutput] = useState<Record<string, string[]>>({})
  const [disconnected, setDisconnected] = useState(false)
  const [generation, setGeneration] = useState(0)

  useEffect(() => {
    let active = true
    let retry: number | undefined

    const close = openTaskEvents(taskId, {
      onOpen: () => {
        setDisconnected(false)
        void queryClient.invalidateQueries({ queryKey: keys.task(taskId) })
      },
      onEvent: (event) => {
        switch (event._tag) {
          case "task.updated":
            queryClient.setQueryData(keys.task(taskId), event.task)
            break
          case "message.created":
            queryClient.setQueryData(keys.messages(taskId), (list: Message[] | undefined) =>
              upsert(list, event.message),
            )
            break
          case "run.updated":
            queryClient.setQueryData(keys.runs(taskId), (list: Run[] | undefined) => upsert(list, event.run))
            break
          case "agent.output":
            setOutput((prev) => ({
              ...prev,
              [event.runId]: [...(prev[event.runId] ?? []), ...event.text.split("\n")].slice(-MAX_LOG_LINES),
            }))
            break
          case "desktop.updated":
            break
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
    error,
  }
}
