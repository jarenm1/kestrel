import { useEffect, useMemo, useState } from "react"
import { useNavigate } from "react-router-dom"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import type { ThreadPullRequestAction } from "@cloudagents/protocol"
import {
  PullRequestDetail,
  PullRequestList,
  type PullRequestQuickAction,
  type PullRequestQuickActionResult,
  type PullRequestRef,
  type PullRequestTab,
} from "@cloudagents/ui/pull-requests"
import { api } from "@/api/client"
import { actOnPullRequest, keys, queries } from "@/api/queries"
import { errorText } from "@/util"

/**
 * The thread's pull requests, in the sidebar: the list, or one pull request's detail. The list query stays mounted
 * while a detail is open, so its poll keeps the registry current and going back is immediate.
 */
export function PullRequestsPanel({ taskId }: { taskId: string }) {
  const queryClient = useQueryClient()
  const navigate = useNavigate()
  const list = useQuery(queries.pullRequests(taskId))
  const automations = useQuery(queries.automations())
  const [selected, setSelected] = useState<PullRequestRef | null>(null)
  const [tab, setTab] = useState<PullRequestTab>("summary")
  const [actionError, setActionError] = useState<string | null>(null)
  const quickActions = useMemo(
    () =>
      automations.data
        ?.filter((automation) => automation.trigger._tag === "quickAction")
        .map(({ id, name, repo }): PullRequestQuickAction => ({ id, name, repo })) ?? null,
    [automations.data],
  )

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

  /** One run per pull request, started together; a run the box refused counts as a failure with its error. */
  async function runQuickAction(
    action: PullRequestQuickAction,
    targets: readonly PullRequestRef[],
  ): Promise<PullRequestQuickActionResult> {
    const outcomes = await Promise.all(
      targets.map(async (target) => {
        try {
          const run = await api.triggerAutomation(action.id, { pullRequest: target.number, repo: target.repo })
          return run.status === "started" ? null : { target, error: run.error ?? "the run did not start" }
        } catch (error) {
          return { target, error: errorText(error) }
        }
      }),
    )
    void queryClient.invalidateQueries({ queryKey: keys.tasks })
    const failures = outcomes.filter((outcome) => outcome !== null)
    return { started: targets.length - failures.length, failures }
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
        quickActions={{
          actions: quickActions,
          error: automations.error === null ? null : errorText(automations.error),
          onRun: runQuickAction,
          onManage: () => navigate("/settings/automations"),
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
