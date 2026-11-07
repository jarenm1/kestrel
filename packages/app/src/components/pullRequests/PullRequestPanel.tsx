import { useEffect, useState } from "react"
import { useQuery } from "@tanstack/react-query"
import { queries } from "@/api/queries"
import { PullRequestDetail } from "./PullRequestDetail"
import { PullRequestList } from "./PullRequestList"

export interface PullRequestRef {
  readonly repo: string
  readonly number: number
}

/**
 * The thread's pull requests, in the sidebar: the list, or one pull request's detail. The list query stays mounted
 * while a detail is open, so its poll keeps the registry current and going back is immediate.
 */
export function PullRequestsPanel({ taskId }: { taskId: string }) {
  const list = useQuery(queries.pullRequests(taskId))
  const [selected, setSelected] = useState<PullRequestRef | null>(null)

  // The registry can lose a pull request between refreshes; a detail that is no longer registered goes back to the list.
  useEffect(() => {
    if (selected === null || list.data === undefined) return
    if (!list.data.pullRequests.some((pr) => pr.repo === selected.repo && pr.number === selected.number)) {
      setSelected(null)
    }
  }, [selected, list.data])

  if (selected !== null) {
    return (
      <PullRequestDetail
        key={`${selected.repo}#${selected.number}`}
        taskId={taskId}
        repo={selected.repo}
        number={selected.number}
        onBack={() => setSelected(null)}
      />
    )
  }

  return <PullRequestList query={list} onSelect={(pullRequest) => setSelected(pullRequest)} />
}
