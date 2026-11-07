import { useMemo } from "react"
import type { UseQueryResult } from "@tanstack/react-query"
import { Eye } from "lucide-react"
import type { ThreadPullRequests, ThreadPullRequestSummary } from "@cloudagents/protocol"
import { Button } from "@cloudagents/ui/button"
import { Alert } from "@cloudagents/ui/alert"
import { cn } from "@/lib/utils"
import { errorText, formatAgo, repoShortName } from "@/util"
import {
  PullRequestChecksGlyph,
  PullRequestReviewGlyph,
  PullRequestStateGlyph,
  PullRequestStat,
  pullRequestCheckStatus,
  pullRequestState,
  useNow,
} from "./presentation"

/** Open pull requests first, then the most recently updated; a registry entry without a snapshot falls back to `addedAt`. */
function comparePullRequests(a: ThreadPullRequestSummary, b: ThreadPullRequestSummary): number {
  const open = Number(b.snapshot?.state === "open") - Number(a.snapshot?.state === "open")
  if (open !== 0) return open
  return (b.snapshot?.updatedAt ?? b.addedAt).localeCompare(a.snapshot?.updatedAt ?? a.addedAt)
}

/**
 * The thread's pull requests: one row each, open ones first. Refreshed by the panel's query; a pull request whose
 * snapshot failed still keeps its row, with GitHub's error in place of the meta line.
 */
export function PullRequestList({
  query,
  onSelect,
}: {
  query: UseQueryResult<ThreadPullRequests, Error>
  onSelect: (pullRequest: ThreadPullRequestSummary) => void
}) {
  const now = useNow()
  const pullRequests = useMemo(() => [...(query.data?.pullRequests ?? [])].sort(comparePullRequests), [query.data])

  return (
    <div className="flex min-h-0 flex-1 flex-col p-3">
      {query.error && (
        <Alert className="mb-2 w-auto">
          <div className="flex items-center gap-2">
            <span className="min-w-0 flex-1">{errorText(query.error)}</span>
            <Button variant="soft" size="sm" onClick={() => void query.refetch()} disabled={query.isFetching}>
              Retry
            </Button>
          </div>
        </Alert>
      )}
      <div className="min-h-0 flex-1 overflow-y-auto rounded-xl bg-background/60 p-1.5 shadow-well">
        {query.isPending && <p className="px-2.5 py-2 text-xs text-muted-foreground">Loading…</p>}
        {query.isSuccess && pullRequests.length === 0 && (
          <div className="px-2.5 py-8 text-center">
            <p className="text-xs font-medium">No pull requests</p>
            <p className="mt-1 text-xs text-muted-foreground">
              The agent opens one when its work needs a GitHub pull request.
            </p>
          </div>
        )}
        {pullRequests.map((pullRequest) => (
          <PullRequestRow key={pullRequest.id} pullRequest={pullRequest} now={now} onSelect={onSelect} />
        ))}
      </div>
    </div>
  )
}

function PullRequestRow({
  pullRequest,
  now,
  onSelect,
}: {
  pullRequest: ThreadPullRequestSummary
  now: number
  onSelect: (pullRequest: ThreadPullRequestSummary) => void
}) {
  const snapshot = pullRequest.snapshot
  const state = pullRequestState(snapshot)
  const checks = snapshot === undefined ? null : pullRequestCheckStatus(snapshot.checks)

  return (
    <button
      type="button"
      onClick={() => onSelect(pullRequest)}
      aria-label={`${state.label} pull request #${pullRequest.number}${snapshot === undefined ? "" : `: ${snapshot.title}`}`}
      className="flex w-full items-start gap-2 rounded-lg px-2.5 py-2 text-left text-xs outline-none transition-colors hover:bg-white/[0.06] focus-visible:shadow-glow"
    >
      <span className="mt-0.5">
        <PullRequestStateGlyph snapshot={snapshot} />
      </span>
      <span className="min-w-0 flex-1">
        <span className="flex min-w-0 items-center gap-1.5">
          <span className="shrink-0 font-mono text-muted-foreground">#{pullRequest.number}</span>
          {snapshot !== undefined && (
            <span className="min-w-0 truncate font-medium text-foreground">{snapshot.title}</span>
          )}
          <span className="ml-auto flex shrink-0 items-center gap-1.5 text-muted-foreground">
            {snapshot !== undefined && checks !== null && <PullRequestChecksGlyph checks={snapshot.checks} />}
            {snapshot !== undefined && <PullRequestReviewGlyph decision={snapshot.reviewDecision} />}
            {snapshot !== undefined && (
              <PullRequestStat additions={snapshot.additions} deletions={snapshot.deletions} />
            )}
          </span>
        </span>
        <span
          className={cn(
            "flex min-w-0 items-center gap-1.5 text-muted-foreground",
            pullRequest.error !== undefined && "text-warning",
          )}
        >
          {pullRequest.error !== undefined ? (
            <span className="min-w-0 truncate">{pullRequest.error}</span>
          ) : snapshot === undefined ? (
            <span>Details unavailable</span>
          ) : (
            <>
              <span className="shrink-0">{snapshot.author ?? "ghost"}</span>
              <span aria-hidden="true">·</span>
              <span className="truncate">{repoShortName(pullRequest.repo)}</span>
              <span aria-hidden="true">·</span>
              <span className="min-w-0 truncate font-mono">
                {snapshot.headRef} → {snapshot.baseRef}
              </span>
              <span className="ml-auto shrink-0 whitespace-nowrap">{formatAgo(snapshot.updatedAt, now)}</span>
              {pullRequest.watching && (
                <span role="img" aria-label="Watching" title="Watching" className="shrink-0">
                  <Eye aria-hidden="true" className="size-3.5" />
                </span>
              )}
            </>
          )}
        </span>
      </span>
    </button>
  )
}
