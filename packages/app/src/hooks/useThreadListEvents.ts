import { useEffect } from "react"
import { useQuery, useQueryClient, type QueryClient } from "@tanstack/react-query"
import type { Target } from "@/api/client"
import { openUserEvents } from "@/api/events"
import { dropTask, keys, queries, storeTask } from "@/api/queries"

const RECONNECT_MS = 2000

/**
 * Keeps the thread list current from the thread list streams, one per box (Kestrel's and each user box): `task.updated`
 * writes the task into the list (new threads included), `task.deleted` drops it. Each (re)connect refetches the list,
 * which catches changes missed meanwhile. The streams are reopened when the set of boxes changes. Kestrel's stream
 * comes straight from the user's managed box while one is assigned, else through the relay.
 */
export function useThreadListEvents(): void {
  const queryClient = useQueryClient()
  const list = useQuery(queries.boxes()).data
  const managed = list?.managedBox ?? null
  const boxes = list?.boxes
  const boxSet = JSON.stringify([managed?.id, managed?.url, boxes?.map((box) => [box.id, box.url]) ?? []])

  useEffect(() => {
    const kestrel: Target = managed === null ? null : { boxId: managed.id, url: managed.url }
    const targets: Target[] = [kestrel, ...(boxes ?? []).map((box) => ({ boxId: box.id, url: box.url }))]
    const stops = targets.map((target) => followBox(queryClient, target))
    return () => stops.forEach((stop) => stop())
  }, [boxSet, queryClient])
}

/**
 * Keeps one box's thread list stream open: reconnects 2 s after a close, and each (re)connect refetches the list.
 * Returns a function that stops it.
 */
function followBox(queryClient: QueryClient, target: Target): () => void {
  let active = true
  let retry: number | undefined
  let close = () => {}
  const connect = () => {
    close = openUserEvents(target, {
      onOpen: () => void queryClient.invalidateQueries({ queryKey: keys.tasks }),
      onEvent: (event) => {
        switch (event._tag) {
          case "task.updated":
            storeTask(queryClient, event.task)
            break
          case "task.deleted":
            dropTask(queryClient, event.taskId)
            break
        }
      },
      onClose: () => {
        if (active) retry = window.setTimeout(connect, RECONNECT_MS)
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
