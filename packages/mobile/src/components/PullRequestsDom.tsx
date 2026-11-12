"use dom"

import { useMemo } from "react"
import { IS_DOM, type DOMProps } from "expo/dom"
import type { ThreadPullRequestAction, ThreadPullRequestDetail, ThreadPullRequestDiff, ThreadPullRequests } from "@cloudagents/protocol"
import { PullRequestDetail, PullRequestList, type PullRequestTab } from "@cloudagents/ui/pull-requests"
import { TranscriptHostProvider, type FileLink, type TranscriptHost } from "@cloudagents/ui/transcript/host"
import "@cloudagents/ui/dom.css"
import { domFillReset } from "./domHostReset"

/** Files are not shown by the pull request views; the host only has to answer. */
const NO_FILE_LINK: FileLink = { url: undefined, onError: () => {}, onOpen: () => {} }

/** Callbacks cross Expo's DOM bridge as async native actions; everything else is plain JSON. */
export interface PullRequestsDomProps {
  /** The pull request whose detail is shown; `null` is the list. */
  selected: { repo: string; number: number } | null
  /** Null until the first successful read. */
  pullRequests: ThreadPullRequests | null
  listError: string | null
  listFetching: boolean
  detail: ThreadPullRequestDetail | null
  detailError: string | null
  detailFetching: boolean
  diff: ThreadPullRequestDiff | null
  diffError: string | null
  diffFetching: boolean
  tab: PullRequestTab
  actionError: string | null
  actionPending: boolean
  onSelect: (repo: string, number: number) => Promise<void>
  onBack: () => Promise<void>
  onRefresh: () => Promise<void>
  onRetryList: () => Promise<void>
  onTabChange: (tab: PullRequestTab) => Promise<void>
  onRetryDiff: () => Promise<void>
  /** Performs one pull request action; resolves the error text, or `null` when it succeeded. */
  onAction: (action: ThreadPullRequestAction) => Promise<string | null>
  /** Opens a URL in the system browser (native only; phone web follows the anchor). */
  onOpenExternal: (url: string) => Promise<void>
  dom?: DOMProps
}

/**
 * The desktop's pull request list and detail (`@cloudagents/ui/pull-requests`) as a DOM component. It fills the view
 * the native side sizes for it and scrolls only inside the shared components' own scrollers; `PullRequestsPanel`
 * owns every query and passes the results in.
 */
export default function PullRequestsDom({
  dom: _dom,
  selected,
  pullRequests,
  listError,
  listFetching,
  detail,
  detailError,
  detailFetching,
  diff,
  diffError,
  diffFetching,
  tab,
  actionError,
  actionPending,
  onSelect,
  onBack,
  onRefresh,
  onRetryList,
  onTabChange,
  onRetryDiff,
  onAction,
  onOpenExternal,
}: PullRequestsDomProps) {
  const host = useMemo<TranscriptHost>(
    () => ({
      useFileLink: () => NO_FILE_LINK,
      openExternal: (url) => void onOpenExternal(url),
      openThread: () => {},
      forkThread: undefined,
    }),
    [onOpenExternal],
  )

  return (
    <div
      data-kestrel-dom=""
      style={{ display: "flex", flexDirection: "column", flex: 1, minHeight: 0, height: "100%" }}
    >
      {IS_DOM && <style>{domFillReset}</style>}
      <TranscriptHostProvider value={host}>
        {selected === null ? (
          <PullRequestList
            pullRequests={pullRequests?.pullRequests ?? null}
            error={listError}
            fetching={listFetching}
            onRetry={() => void onRetryList()}
            onSelect={(repo, number) => void onSelect(repo, number)}
          />
        ) : (
          <PullRequestDetail
            repo={selected.repo}
            number={selected.number}
            detail={detail}
            error={detailError}
            fetching={detailFetching}
            diff={diff}
            diffError={diffError}
            diffFetching={diffFetching}
            tab={tab}
            actionError={actionError}
            actionPending={actionPending}
            onBack={() => void onBack()}
            onRefresh={() => void onRefresh()}
            onTabChange={(next) => void onTabChange(next)}
            onRetryDiff={() => void onRetryDiff()}
            onAction={onAction}
          />
        )}
      </TranscriptHostProvider>
    </div>
  )
}
