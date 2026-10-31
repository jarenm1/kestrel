import { useEffect, useState } from "react"
import { useQueryClient } from "@tanstack/react-query"
import type { Task } from "@cloudagents/protocol"
import { openUserEvents } from "@/api/events"
import { keys, storeTask } from "@/api/queries"

const RECONNECT_MS = 2000

/**
 * Keeps the thread list current from the user events stream: `task.updated` writes the task into the list (new threads
 * included), `task.deleted` drops it. Each (re)connect refetches the list, which catches changes missed meanwhile.
 */
export function useThreadListEvents(): void {
  const queryClient = useQueryClient()
  const [generation, setGeneration] = useState(0)

  useEffect(() => {
    let active = true
    let retry: number | undefined

    const close = openUserEvents({
      onOpen: () => void queryClient.invalidateQueries({ queryKey: keys.tasks }),
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
        if (!active) return
        retry = window.setTimeout(() => setGeneration((g) => g + 1), RECONNECT_MS)
      },
    })

    return () => {
      active = false
      window.clearTimeout(retry)
      close()
    }
  }, [generation, queryClient])
}
