import { useQuery } from "@tanstack/react-query"
import { Server } from "lucide-react"
import { queries } from "@/api/queries"
import { boxName, OnlineDot } from "@/components/BoxPicker"

/**
 * The box a thread runs on, with its online dot: a row of its own above the chat, so it never covers thread content.
 * The row keeps its height while the thread's box and the box list load, so the chat does not shift when it appears.
 */
export function ThreadBoxIndicator({ taskId }: { taskId: string }) {
  const box = useQuery(queries.taskBox(taskId))
  const list = useQuery(queries.boxes())
  return (
    <div className="mt-3.5 flex h-5 shrink-0 px-3">
      {box.data !== undefined && list.data !== undefined && (
        <div className="flex max-w-48 items-center gap-1.5 px-2 text-[11px] text-muted-foreground [&_svg]:size-3">
          <Server className="shrink-0" />
          <span className="truncate">
            <span className="sr-only">Running on </span>
            {boxName(box.data, list.data)}
          </span>
          <OnlineDot boxId={box.data} list={list.data} />
        </div>
      )}
    </div>
  )
}
