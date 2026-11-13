import { useEffect, useRef, useState } from "react"
import { useParams } from "react-router-dom"
import type { Task } from "@cloudagents/protocol"
import { APP_TITLE, nextFinished, tabTitle, titleThreads } from "@/lib/tabTitle"

/**
 * Puts the threads' status in the tab title (`Kestrel • 3 Working, 1 Done`), so a background tab shows when work
 * finishes. Restores `Kestrel` when the signed-in pages unmount.
 */
export function useTabTitle(tasks: readonly Task[] | undefined): void {
  const { taskId: openTaskId } = useParams()
  const previousWorking = useRef<ReadonlySet<string>>(new Set())
  const [finished, setFinished] = useState<ReadonlySet<string>>(new Set())
  const threads = titleThreads(tasks ?? [])

  useEffect(() => {
    if (tasks === undefined) return
    const current = titleThreads(tasks)
    // Read now: React may run the updater after the ref below has moved on.
    const wasWorking = previousWorking.current
    setFinished((prev) => nextFinished(prev, wasWorking, current, openTaskId))
    previousWorking.current = current.working
  }, [tasks, openTaskId])

  const title = tabTitle(threads, finished)
  useEffect(() => {
    document.title = title
  }, [title])
  useEffect(() => () => void (document.title = APP_TITLE), [])
}
