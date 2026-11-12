import { useState } from "react"
import {
  ArrowLeft,
  Copy,
  ExternalLink,
  Eye,
  EyeOff,
  GitMerge,
  GitPullRequestArrow,
  GitPullRequestClosed,
  MoreHorizontal,
  RefreshCw,
} from "lucide-react"
import type {
  ThreadPullRequestAction,
  ThreadPullRequestDetail,
  ThreadPullRequestDiff,
} from "@cloudagents/protocol"
import { Alert } from "../alert"
import { Badge } from "../badge"
import { Button } from "../button"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "../dropdown-menu"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "../tabs"
import { cn } from "../cn"
import { formatAgo } from "../format"
import { externalClick, useTranscriptHost } from "../transcript/host"
import { PullRequestCode } from "./PullRequestCode"
import { PullRequestComposer } from "./PullRequestComposer"
import { PullRequestSummary } from "./PullRequestSummary"
import { PullRequestTimeline } from "./PullRequestTimeline"
import { PullRequestStat, pullRequestState, useNow } from "./presentation"

export type PullRequestTab = "summary" | "timeline" | "code"
type MergeMethod = "squash" | "merge" | "rebase"
type Confirm = "merge" | "close" | "reopen"

const MERGE_LABEL: Record<MergeMethod, string> = {
  squash: "Squash and merge",
  merge: "Merge",
  rebase: "Rebase and merge",
}

export interface PullRequestDetailProps {
  repo: string
  number: number
  /** Null while loading or after a failed read. */
  detail: ThreadPullRequestDetail | null
  error: string | null
  fetching: boolean
  diff: ThreadPullRequestDiff | null
  diffError: string | null
  diffFetching: boolean
  tab: PullRequestTab
  actionError: string | null
  actionPending: boolean
  onBack: () => void
  onRefresh: () => void
  onTabChange: (tab: PullRequestTab) => void
  onRetryDiff: () => void
  /** Resolves null on success, or the message to show on failure. */
  onAction: (action: ThreadPullRequestAction) => Promise<string | null>
}

/**
 * One pull request: state and branches up top, Summary/Timeline/Code below, and the comment and review forms at the
 * end. The host keeps the list mounted behind the panel, so the registry keeps refreshing while it is open.
 */
export function PullRequestDetail({
  repo,
  number,
  detail,
  error,
  fetching,
  diff,
  diffError,
  diffFetching,
  tab,
  actionError,
  actionPending,
  onBack,
  onRefresh,
  onTabChange,
  onRetryDiff,
  onAction,
}: PullRequestDetailProps) {
  const now = useNow()
  const host = useTranscriptHost()
  const [menuOpen, setMenuOpen] = useState(false)
  const [confirm, setConfirm] = useState<Confirm | null>(null)
  const [mergeMethod, setMergeMethod] = useState<MergeMethod>("squash")

  async function act(next: ThreadPullRequestAction, after?: () => void) {
    const failure = await onAction(next)
    if (failure === null) after?.()
  }

  if (detail === null && error === null) {
    return <p className="p-4 text-xs text-muted-foreground">Loading…</p>
  }
  if (detail === null) {
    return (
      <div className="p-4">
        <Alert className="w-auto">
          <p>{error ?? "The pull request could not be read."}</p>
          <Button variant="soft" size="sm" className="mt-2" onClick={onRefresh} disabled={fetching}>
            Retry
          </Button>
        </Alert>
      </div>
    )
  }

  const summary = detail.summary
  const snapshot = summary.snapshot
  const state = pullRequestState(snapshot)
  const title = snapshot?.title ?? `Pull request #${number}`
  const canMerge = snapshot !== undefined && snapshot.state === "open" && !snapshot.draft
  const watching = summary.watching
  const closeMenu = () => {
    setConfirm(null)
    setMenuOpen(false)
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <header className="flex flex-col gap-2 px-4 pt-3">
        <div className="flex items-center gap-1">
          <Button
            variant="ghost"
            size="icon"
            className="size-7"
            aria-label="Back to pull requests"
            title="Pull requests"
            onClick={onBack}
          >
            <ArrowLeft />
          </Button>
          <span className="font-mono text-xs text-muted-foreground">#{number}</span>
          <Button asChild variant="ghost" size="icon" className="size-7" title="Open on GitHub">
            <a
              href={summary.url}
              target="_blank"
              rel="noreferrer"
              aria-label="Open on GitHub"
              onClick={externalClick(host, summary.url)}
            >
              <ExternalLink />
            </a>
          </Button>
          <div className="ml-auto flex items-center gap-1">
            <Button
              variant="ghost"
              size="icon"
              className="size-7"
              aria-label="Refresh pull request"
              title="Refresh"
              onClick={onRefresh}
              disabled={fetching}
            >
              <RefreshCw className={cn(fetching && "animate-spin")} />
            </Button>
            <DropdownMenu
              open={menuOpen}
              onOpenChange={(open) => {
                setMenuOpen(open)
                if (!open) setConfirm(null)
              }}
            >
              <DropdownMenuTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon"
                  className="size-7 data-[state=open]:bg-white/[0.06]"
                  aria-label="Pull request actions"
                  title="Actions"
                >
                  <MoreHorizontal />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" side="bottom">
                {canMerge &&
                  (confirm === "merge" ? (
                    <>
                      <DropdownMenuLabel>Merge this pull request</DropdownMenuLabel>
                      <DropdownMenuRadioGroup
                        value={mergeMethod}
                        onValueChange={(value) => setMergeMethod(value as MergeMethod)}
                      >
                        {(Object.keys(MERGE_LABEL) as MergeMethod[]).map((method) => (
                          <DropdownMenuRadioItem
                            key={method}
                            value={method}
                            onSelect={(event) => event.preventDefault()}
                          >
                            {MERGE_LABEL[method]}
                          </DropdownMenuRadioItem>
                        ))}
                      </DropdownMenuRadioGroup>
                      <DropdownMenuItem
                        disabled={actionPending}
                        onSelect={() =>
                          void act(
                            { action: "merge", repo, number, method: mergeMethod },
                            closeMenu,
                          )
                        }
                      >
                        <GitMerge />
                        {actionPending ? "Merging…" : MERGE_LABEL[mergeMethod]}
                      </DropdownMenuItem>
                      <DropdownMenuItem onSelect={() => setConfirm(null)}>Cancel</DropdownMenuItem>
                    </>
                  ) : (
                    <DropdownMenuItem
                      disabled={actionPending}
                      onSelect={(event) => {
                        event.preventDefault()
                        setConfirm("merge")
                      }}
                    >
                      <GitMerge />
                      Merge…
                    </DropdownMenuItem>
                  ))}

                {snapshot?.state === "open" &&
                  (confirm === "close" ? (
                    <>
                      <DropdownMenuLabel>Close this pull request?</DropdownMenuLabel>
                      <DropdownMenuItem
                        disabled={actionPending}
                        className="text-destructive focus:text-destructive"
                        onSelect={() =>
                          void act({ action: "close", repo, number }, closeMenu)
                        }
                      >
                        <GitPullRequestClosed />
                        {actionPending ? "Closing…" : "Close"}
                      </DropdownMenuItem>
                      <DropdownMenuItem onSelect={() => setConfirm(null)}>Cancel</DropdownMenuItem>
                    </>
                  ) : (
                    <DropdownMenuItem
                      disabled={actionPending}
                      onSelect={(event) => {
                        event.preventDefault()
                        setConfirm("close")
                      }}
                    >
                      <GitPullRequestClosed />
                      Close
                    </DropdownMenuItem>
                  ))}

                {snapshot?.state === "closed" &&
                  (confirm === "reopen" ? (
                    <>
                      <DropdownMenuLabel>Reopen this pull request?</DropdownMenuLabel>
                      <DropdownMenuItem
                        disabled={actionPending}
                        onSelect={() =>
                          void act({ action: "reopen", repo, number }, closeMenu)
                        }
                      >
                        <GitPullRequestArrow />
                        {actionPending ? "Reopening…" : "Reopen"}
                      </DropdownMenuItem>
                      <DropdownMenuItem onSelect={() => setConfirm(null)}>Cancel</DropdownMenuItem>
                    </>
                  ) : (
                    <DropdownMenuItem
                      disabled={actionPending}
                      onSelect={(event) => {
                        event.preventDefault()
                        setConfirm("reopen")
                      }}
                    >
                      <GitPullRequestArrow />
                      Reopen
                    </DropdownMenuItem>
                  ))}

                {(canMerge || snapshot?.state === "open" || snapshot?.state === "closed") && (
                  <DropdownMenuSeparator />
                )}
                <DropdownMenuItem
                  onSelect={() => void navigator.clipboard?.writeText(summary.url).catch(() => undefined)}
                >
                  <Copy />
                  Copy link
                </DropdownMenuItem>
                <DropdownMenuItem asChild>
                  <a
                    href={summary.url}
                    target="_blank"
                    rel="noreferrer"
                    onClick={externalClick(host, summary.url)}
                  >
                    <ExternalLink />
                    Open on GitHub
                  </a>
                </DropdownMenuItem>
                <DropdownMenuItem
                  disabled={actionPending}
                  onSelect={() =>
                    void act({ action: "watch", repo, number, watching: !watching })
                  }
                >
                  {watching ? <EyeOff /> : <Eye />}
                  {watching ? "Unwatch" : "Watch"}
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        </div>

        <div className="flex items-start gap-2">
          <Badge variant={state.tone}>{state.label}</Badge>
          <h2 className="min-w-0 flex-1 text-sm font-semibold tracking-tight">{title}</h2>
        </div>

        {snapshot !== undefined && (
          <>
            <p className="text-xs text-muted-foreground">
              {snapshot.author ?? "ghost"} · updated {formatAgo(snapshot.updatedAt, now)}
            </p>
            <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
              <span className="font-mono">
                {snapshot.baseRef} ← {snapshot.headRef}
              </span>
              <span>
                {snapshot.changedFiles} {snapshot.changedFiles === 1 ? "file" : "files"}
              </span>
              <PullRequestStat additions={snapshot.additions} deletions={snapshot.deletions} />
            </p>
          </>
        )}
      </header>

      {error !== null && (
        <Alert className="mx-4 mt-2 w-auto">
          <div className="flex items-center gap-2">
            <span className="min-w-0 flex-1">{error}</span>
            <Button variant="soft" size="sm" onClick={onRefresh} disabled={fetching}>
              Retry
            </Button>
          </div>
        </Alert>
      )}
      {error === null && summary.error !== undefined && (
        <Alert className="mx-4 mt-2 w-auto">
          <div className="flex items-center gap-2">
            <span className="min-w-0 flex-1">{summary.error}</span>
            <Button variant="soft" size="sm" onClick={onRefresh} disabled={fetching}>
              Retry
            </Button>
          </div>
        </Alert>
      )}
      {actionError && <Alert className="mx-4 mt-2 w-auto">{actionError}</Alert>}

      <Tabs
        value={tab}
        onValueChange={(value) => onTabChange(value as PullRequestTab)}
        className="mt-3 flex min-h-0 flex-1 flex-col"
      >
        <div className="px-4">
          <TabsList className="h-8">
            <TabsTrigger value="summary" className="px-3 text-xs">
              Summary
            </TabsTrigger>
            <TabsTrigger value="timeline" className="px-3 text-xs">
              Timeline
            </TabsTrigger>
            <TabsTrigger value="code" className="px-3 text-xs">
              Code
            </TabsTrigger>
          </TabsList>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto px-4 pt-3 pb-4">
          <TabsContent value="summary">
            <PullRequestSummary detail={detail} />
          </TabsContent>
          <TabsContent value="timeline">
            <PullRequestTimeline detail={detail} />
          </TabsContent>
          <TabsContent value="code">
            <PullRequestCode
              repo={repo}
              number={number}
              headRef={snapshot?.headRef ?? summary.branch ?? "head"}
              patch={diff?.patch ?? null}
              truncated={diff?.truncated === true}
              error={diffError}
              fetching={diffFetching}
              onRetry={onRetryDiff}
            />
          </TabsContent>
          <div className="mt-4">
            <PullRequestComposer
              repo={repo}
              number={number}
              pending={actionPending}
              onAction={onAction}
            />
          </div>
        </div>
      </Tabs>
    </div>
  )
}
