import { useMemo, useState } from "react"
import { Check, Eye, ListChecks, Settings2, X, Zap } from "lucide-react"
import type { ThreadPullRequestSummary } from "@cloudagents/protocol"
import { Alert } from "../alert"
import { Button } from "../button"
import { Checkbox } from "../checkbox"
import { cn } from "../cn"
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "../dropdown-menu"
import { formatAgo, repoShortName } from "../format"
import {
  PullRequestChecksGlyph,
  PullRequestReviewGlyph,
  PullRequestStateGlyph,
  PullRequestStat,
  pullRequestCheckStatus,
  pullRequestState,
  useNow,
} from "./presentation"
import {
  QuickActionItems,
  describeQuickActionResult,
  type PullRequestQuickAction,
  type PullRequestQuickActions,
  type PullRequestRef,
} from "./QuickActions"

export interface PullRequestListProps {
  /** Null until the first successful read. */
  pullRequests: readonly ThreadPullRequestSummary[] | null
  /** Display text of the read error. */
  error: string | null
  fetching: boolean
  onRetry: () => void
  onSelect: (repo: string, number: number) => void
  /** When given, each row offers the user's quick actions on hover, and rows can be selected to run one on several. */
  quickActions?: PullRequestQuickActions
}

/** The outcome line of the latest quick action batch, shown above the list until dismissed. */
type RunNotice =
  | { readonly phase: "running"; readonly text: string }
  | { readonly phase: "done"; readonly text: string; readonly failed: boolean }

/** Open pull requests first, then the most recently updated; a registry entry without a snapshot falls back to `addedAt`. */
function comparePullRequests(a: ThreadPullRequestSummary, b: ThreadPullRequestSummary): number {
  const open = Number(b.snapshot?.state === "open") - Number(a.snapshot?.state === "open")
  if (open !== 0) return open
  return (b.snapshot?.updatedAt ?? b.addedAt).localeCompare(a.snapshot?.updatedAt ?? a.addedAt)
}

/**
 * The thread's pull requests: one row each, open ones first. Refreshed by the host's query; a pull request whose
 * snapshot failed still keeps its row, with GitHub's error in place of the meta line.
 */
export function PullRequestList({ pullRequests, error, fetching, onRetry, onSelect, quickActions }: PullRequestListProps) {
  const now = useNow()
  const rows = useMemo(() => [...(pullRequests ?? [])].sort(comparePullRequests), [pullRequests])
  const [selectedIds, setSelectedIds] = useState<ReadonlySet<string>>(new Set())
  const [notice, setNotice] = useState<RunNotice | null>(null)
  // Pull requests that left the registry drop out of the selection; selecting ends once none are left.
  const selected = rows.filter((row) => selectedIds.has(row.id))
  const selecting = quickActions !== undefined && selected.length > 0
  const running = notice?.phase === "running"

  function toggle(id: string) {
    setSelectedIds((current) => {
      const next = new Set(current)
      if (!next.delete(id)) next.add(id)
      return next
    })
  }

  async function run(action: PullRequestQuickAction, targets: readonly PullRequestRef[]) {
    if (quickActions === undefined) return
    const what = targets.length === 1 ? `#${targets[0]?.number}` : `${targets.length} pull requests`
    setNotice({ phase: "running", text: `Starting “${action.name}” on ${what}…` })
    try {
      const result = await quickActions.onRun(action, targets)
      setNotice({
        phase: "done",
        text: describeQuickActionResult(action.name, targets, result),
        failed: result.failures.length > 0,
      })
      if (result.failures.length === 0) setSelectedIds(new Set())
    } catch (err) {
      setNotice({ phase: "done", text: err instanceof Error ? err.message : String(err), failed: true })
    }
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col p-3">
      {error !== null && (
        <Alert className="mb-2 w-auto">
          <div className="flex items-center gap-2">
            <span className="min-w-0 flex-1">{error}</span>
            <Button variant="soft" size="sm" onClick={onRetry} disabled={fetching}>
              Retry
            </Button>
          </div>
        </Alert>
      )}
      {notice !== null && (
        <div
          role="status"
          className={cn(
            "mb-2 flex items-start gap-2 whitespace-pre-wrap rounded-xl px-3 py-2 text-xs",
            notice.phase === "done" && notice.failed ? "bg-destructive/10 text-destructive" : "bg-white/[0.04] text-muted-foreground",
          )}
        >
          <span className="min-w-0 flex-1">{notice.text}</span>
          {notice.phase === "done" && (
            <button
              type="button"
              aria-label="Dismiss"
              onClick={() => setNotice(null)}
              className="rounded-full p-0.5 outline-none hover:text-foreground focus-visible:shadow-glow"
            >
              <X aria-hidden="true" className="size-3.5" />
            </button>
          )}
        </div>
      )}
      {selecting && quickActions !== undefined && (
        <div className="mb-2 flex items-center gap-2 rounded-xl bg-white/[0.04] py-1.5 pr-1.5 pl-3 text-xs">
          <Checkbox
            aria-label="Select all pull requests"
            checked={selected.length === rows.length ? true : "indeterminate"}
            onCheckedChange={() =>
              setSelectedIds(new Set(selected.length === rows.length ? [] : rows.map((row) => row.id)))
            }
          />
          <span className="min-w-0 flex-1 truncate">{selected.length} selected</span>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="soft" size="sm" disabled={running}>
                <Zap />
                Run quick action
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="max-w-72">
              <QuickActionItems
                quickActions={quickActions}
                targets={selected}
                disabled={running}
                onPick={(action) => void run(action, selected.map(({ repo, number }) => ({ repo, number })))}
              />
              <DropdownMenuSeparator />
              <DropdownMenuItem onSelect={quickActions.onManage}>
                <Settings2 />
                Manage quick actions
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
          <Button variant="ghost" size="sm" onClick={() => setSelectedIds(new Set())}>
            Cancel
          </Button>
        </div>
      )}
      <div className="min-h-0 flex-1 overflow-y-auto rounded-xl bg-background/60 p-1.5 shadow-well">
        {pullRequests === null && error === null && (
          <p className="px-2.5 py-2 text-xs text-muted-foreground">Loading…</p>
        )}
        {pullRequests !== null && pullRequests.length === 0 && (
          <div className="px-2.5 py-8 text-center">
            <p className="text-xs font-medium">No pull requests</p>
            <p className="mt-1 text-xs text-muted-foreground">
              The agent opens one when its work needs a GitHub pull request.
            </p>
          </div>
        )}
        {rows.map((pullRequest) => (
          <div key={pullRequest.id} className="group relative">
            <PullRequestRow
              pullRequest={pullRequest}
              now={now}
              selection={selecting ? selectedIds.has(pullRequest.id) : null}
              gutter={quickActions !== undefined && !selecting}
              onClick={() =>
                selecting ? toggle(pullRequest.id) : onSelect(pullRequest.repo, pullRequest.number)
              }
            />
            {quickActions !== undefined && !selecting && (
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <button
                    type="button"
                    aria-label={`Quick actions for pull request #${pullRequest.number}`}
                    title="Quick actions"
                    className="absolute top-1/2 right-1.5 grid size-7 -translate-y-1/2 place-items-center rounded-full bg-white/10 text-muted-foreground opacity-0 outline-none transition-[opacity,color,background-color,box-shadow] duration-150 group-hover:opacity-100 hover:bg-white/15 hover:text-foreground focus-visible:opacity-100 focus-visible:shadow-glow data-[state=open]:bg-white/15 data-[state=open]:text-foreground data-[state=open]:opacity-100"
                  >
                    <Zap aria-hidden="true" className="size-3.5" />
                  </button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end" className="max-w-72">
                  <QuickActionItems
                    quickActions={quickActions}
                    targets={[pullRequest]}
                    disabled={running}
                    onPick={(action) => void run(action, [{ repo: pullRequest.repo, number: pullRequest.number }])}
                  />
                  <DropdownMenuSeparator />
                  <DropdownMenuItem onSelect={() => setSelectedIds(new Set([pullRequest.id]))}>
                    <ListChecks />
                    Select multiple…
                  </DropdownMenuItem>
                  <DropdownMenuItem onSelect={quickActions.onManage}>
                    <Settings2 />
                    Manage quick actions
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            )}
          </div>
        ))}
      </div>
    </div>
  )
}

function PullRequestRow({
  pullRequest,
  now,
  selection,
  gutter,
  onClick,
}: {
  pullRequest: ThreadPullRequestSummary
  now: number
  /** Whether the row is selected while choosing pull requests for a quick action; null outside that mode. */
  selection: boolean | null
  /** Keeps the right edge free for the quick action button that shows on hover. */
  gutter: boolean
  onClick: () => void
}) {
  const snapshot = pullRequest.snapshot
  const state = pullRequestState(snapshot)
  const checks = snapshot === undefined ? null : pullRequestCheckStatus(snapshot.checks)

  return (
    <button
      type="button"
      onClick={onClick}
      {...(selection === null ? {} : { role: "checkbox", "aria-checked": selection })}
      aria-label={`${state.label} pull request #${pullRequest.number}${snapshot === undefined ? "" : `: ${snapshot.title}`}`}
      className={cn(
        "flex w-full items-start gap-2 rounded-lg px-2.5 py-2 text-left text-xs outline-none transition-[color,background-color,box-shadow] duration-200 ease-out hover:bg-white/[0.06] focus-visible:shadow-glow",
        selection === true && "bg-white/[0.04]",
        gutter && "pr-10",
      )}
    >
      <span className="mt-0.5">
        {selection === null ? (
          <PullRequestStateGlyph snapshot={snapshot} />
        ) : (
          <span
            aria-hidden="true"
            className={cn(
              "grid size-4 place-items-center rounded-[4px] bg-input shadow-well",
              selection && "bg-primary text-primary-foreground",
            )}
          >
            {selection && <Check className="size-3.5" />}
          </span>
        )}
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
