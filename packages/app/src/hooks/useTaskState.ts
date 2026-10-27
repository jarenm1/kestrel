import { useEffect, useState } from "react"
import type { Message, Run, Task } from "@cloudagents/protocol"
import { api } from "../api/client"
import { openTaskEvents } from "../api/events"
import { errorText } from "../util"

const MAX_LOG_LINES = 2000
const RECONNECT_MS = 2000

type Keyed = { id: string }

function upsert<T extends Keyed>(list: readonly T[], item: T): T[] {
  const index = list.findIndex((x) => x.id === item.id)
  if (index === -1) return [...list, item]
  const next = [...list]
  next[index] = item
  return next
}

/** Snapshot entries first; entries already known from live events (newer) override them. */
function mergeSnapshot<T extends Keyed>(snapshot: readonly T[], current: readonly T[]): T[] {
  const byId = new Map<string, T>()
  for (const item of snapshot) byId.set(item.id, item)
  for (const item of current) byId.set(item.id, item)
  return [...byId.values()]
}

/**
 * Task chat state: snapshot via REST, then kept current from the task events WebSocket.
 * Reconnects (and re-snapshots) when the socket drops. Callers should key by taskId.
 */
export function useTaskState(taskId: string) {
  const [task, setTask] = useState<Task | null>(null)
  const [messages, setMessages] = useState<readonly Message[]>([])
  const [runs, setRuns] = useState<readonly Run[]>([])
  const [output, setOutput] = useState<Record<string, string[]>>({})
  const [error, setError] = useState<string | null>(null)
  const [generation, setGeneration] = useState(0)

  useEffect(() => {
    let active = true
    let retry: number | undefined

    const close = openTaskEvents(
      taskId,
      (event) => {
        switch (event._tag) {
          case "task.updated":
            setTask(event.task)
            break
          case "message.created":
            setMessages((list) => upsert(list, event.message))
            break
          case "run.updated":
            setRuns((list) => upsert(list, event.run))
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
      () => {
        if (!active) return
        setError("Live updates disconnected; reconnecting…")
        retry = window.setTimeout(() => setGeneration((g) => g + 1), RECONNECT_MS)
      },
    )

    Promise.all([api.getTask(taskId), api.listMessages(taskId), api.listRuns(taskId)]).then(
      ([t, m, r]) => {
        if (!active) return
        setTask(t)
        setMessages((cur) => mergeSnapshot(m, cur))
        setRuns((cur) => mergeSnapshot(r, cur))
        setError(null)
      },
      (e: unknown) => {
        if (active) setError(errorText(e))
      },
    )

    return () => {
      active = false
      window.clearTimeout(retry)
      close()
    }
  }, [taskId, generation])

  return {
    task,
    messages,
    runs,
    output,
    error,
    upsertMessage: (message: Message) => setMessages((list) => upsert(list, message)),
    upsertRun: (run: Run) => setRuns((list) => upsert(list, run)),
  }
}
