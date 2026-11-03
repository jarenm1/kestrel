import { useQuery } from "@tanstack/react-query"
import { DiffView } from "@cloudagents/ui/diff"
import { queries } from "@/api/queries"
import { errorText } from "@/util"

/** The thread's diff, refetched when the thread's run events invalidate it; drawn by the shared `DiffView`. */
export function DiffPanel({ taskId }: { taskId: string }) {
  const diff = useQuery(queries.diff(taskId))
  return (
    <DiffView
      checkouts={diff.data?.checkouts}
      error={diff.error ? errorText(diff.error) : null}
      refreshing={diff.isFetching}
      onRefresh={() => void diff.refetch()}
    />
  )
}
