import { useEffect, useState } from "react"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import type { ThreadPullRequestAction } from "@cloudagents/protocol"
import { PullRequestDetail, PullRequestList, type PullRequestTab } from "@cloudagents/ui/pull-requests"
import { actOnPullRequest, keys, queries } from "@/api/queries"
import { errorText } from "@/util"

export interface PullRequestRef {
  readonly repo: string
  readonly number: number
}

/**
 * The thread's pull requests, in the sidebar: the list, or one pull request's detail. The list query stays mounted
 * while a detail is open, so its poll keeps the registry current and going back is immediate.
 */
export function PullRequestsPanel({ taskId }: { taskId: string }) {
  const queryClient = useQueryClient()
  const list = useQuery(queries.pullRequests(taskId))
  const [selected, setSelected] = useState<PullRequestRef | null>(null)
  const [tab, setTab] = useState<PullRequestTab>("summary")
  const [actionError, setActionError] = useState<string | null>(null)

  const detail = useQuery({
    ...queries.pullRequest(taskId, selected?.repo ?? "", selected?.number ?? 0),
    enabled: selected !== null,
  })
  const diff = useQuery({
    ...queries.pullRequestDiff(taskId, selected?.repo ?? "", selected?.number ?? 0),
    enabled: selected !== null && tab === "code",
  })
  const action = useMutation({
    mutationFn: (next: ThreadPullRequestAction) => actOnPullRequest(queryClient, taskId, next),
    onSuccess: () => setActionError(null),
    onError: (error) => setActionError(errorText(error)),
  })

  // The registry can lose a pull request between refreshes; a detail that is no longer registered goes back to the list.
  useEffect(() => {
    if (selected === null || list.data === undefined) return
    if (!list.data.pullRequests.some((pr) => pr.repo === selected.repo && pr.number === selected.number)) {
      setSelected(null)
      setActionError(null)
    }
  }, [selected, list.data])

  // A different pull request opens on its Summary tab.
  useEffect(() => {
    setTab("summary")
  }, [selected])

  function refresh() {
    void detail.refetch()
    if (selected !== null) {
      void queryClient.invalidateQueries({
        queryKey: keys.pullRequestDiff(taskId, selected.repo, selected.number),
      })
    }
  }

  async function runAction(next: ThreadPullRequestAction): Promise<string | null> {
    try {
      await action.mutateAsync(next)
      return null
    } catch (error) {
      return errorText(error)
    }
  }

  if (selected === null) {
    return (
      <PullRequestList
        pullRequests={list.data?.pullRequests ?? null}
        error={list.error === null ? null : errorText(list.error)}
        fetching={list.isFetching}
        onRetry={() => void list.refetch()}
        onSelect={(repo, number) => {
          setSelected({ repo, number })
          setActionError(null)
        }}
      />
    )
  }

  return (
    <PullRequestDetail
      key={`${selected.repo}#${selected.number}`}
      repo={selected.repo}
      number={selected.number}
      detail={detail.data ?? null}
      error={detail.error === null ? null : errorText(detail.error)}
      fetching={detail.isFetching}
      diff={diff.data ?? null}
      diffError={diff.error === null ? null : errorText(diff.error)}
      diffFetching={diff.isFetching}
      tab={tab}
      actionError={actionError}
      actionPending={action.isPending}
      onBack={() => {
        setSelected(null)
        setActionError(null)
      }}
      onRefresh={refresh}
      onTabChange={setTab}
      onRetryDiff={() => void diff.refetch()}
      onAction={runAction}
    />
  )
}
