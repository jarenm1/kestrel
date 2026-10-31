import { useEffect } from "react"
import { useQuery, useQueryClient, type QueryClient } from "@tanstack/react-query"
import { MANAGED_BOX_ID, type Task } from "@cloudagents/protocol"
import type { Target } from "@/api/client"
import { openUserEvents, reconnectDelay } from "@/api/events"
import { keys, queries, storeTask } from "@/api/queries"

/**
 * Keeps the thread list current from the thread list streams, one per box (Kestrel's and each user box): `task.updated`
 * writes the task into the list (new threads included), `task.deleted` drops it. Each (re)connect refetches the list,
 * which catches changes missed meanwhile. The streams are reopened when the set of boxes changes.
 */
export function useThreadListEvents(): void {
  const queryClient = useQueryClient()
  const list = useQuery(queries.boxes()).data
  const boxSet = JSON.stringify([list?.managedBox?.url ?? null, list?.boxes.map((box) => [box.id, box.url]) ?? []])

  useEffect(() => {
    const targets: Target[] = [
      ...(list?.managedBox ? [{ boxId: MANAGED_BOX_ID, url: list.managedBox.url }] : []),
      ...(list?.boxes ?? []).map((box) => ({ boxId: box.id, url: box.url })),
    ]
    const stops = targets.map((target) => followBox(queryClient, target))
    return () => stops.forEach((stop) => stop())
  }, [boxSet, queryClient])
}

/**
 * Keeps one box's thread list stream open: reconnects with backoff after a close, and each (re)connect refetches the list.
 * Returns a function that stops it.
 */
function followBox(queryClient: QueryClient, target: Target): () => void {
  let active = true
  let retry: number | undefined
  let close = () => {}
  let failures = 0
  /** The box's status follows its stream: it is re-read on every open and close. */
  const refreshStatus = () => {
    void queryClient.invalidateQueries({ queryKey: keys.box })
    void queryClient.invalidateQueries({ queryKey: keys.boxHealth(target.url) })
  }
  const connect = () => {
    close = openUserEvents(target, {
      onOpen: () => {
        failures = 0
        void queryClient.invalidateQueries({ queryKey: keys.tasks })
        refreshStatus()
      },
      onEvent: (event) => {
        switch (event._tag) {
          case "task.updated":
            storeTask(queryClient, event.task)
            break
          case "task.deleted":
            queryClient.setQueryData(keys.tasks, (list: readonly Task[] | undefined) =>
              list?.filter((task) => task.id !== event.taskId),
            )
            queryClient.removeQueries({ queryKey: keys.task(event.taskId), exact: true })
            break
        }
      },
      onClose: () => {
        refreshStatus()
        if (active) retry = window.setTimeout(connect, reconnectDelay(failures++))
      },
    })
  }
  connect()
  return () => {
    active = false
    window.clearTimeout(retry)
    close()
  }
}
