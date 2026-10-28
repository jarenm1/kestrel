import { useParams } from "react-router-dom"
import { ThreadView } from "@/components/ThreadView"

export function ThreadPage() {
  const { taskId = "" } = useParams()
  return <ThreadView key={taskId} taskId={taskId} />
}
