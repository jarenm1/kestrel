import { useQuery } from "@tanstack/react-query"
import { Server } from "lucide-react"
import { queries } from "@/api/queries"
import { boxName, OnlineDot } from "@/components/BoxPicker"

/** The box a thread runs on, with its online dot. Renders nothing until both the thread's box and the box list are known. */
export function ThreadBoxIndicator({ taskId }: { taskId: string }) {
  const box = useQuery(queries.taskBox(taskId))
  const list = useQuery(queries.boxes())
  if (box.data === undefined || list.data === undefined) return null
  const name = boxName(box.data, list.data)
  return (
    <div
      className="pointer-events-none absolute top-3.5 left-3 z-10 flex max-w-48 items-center gap-1.5 rounded-full bg-card/80 px-2 py-0.5 text-[11px] text-muted-foreground backdrop-blur-sm [&_svg]:size-3"
    >
      <Server className="shrink-0" />
      <span className="truncate">
        <span className="sr-only">Running on </span>
        {name}
      </span>
      <OnlineDot boxId={box.data} list={list.data} />
    </div>
  )
}
