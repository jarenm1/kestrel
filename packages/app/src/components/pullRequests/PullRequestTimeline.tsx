import { useMemo, useState } from "react"
import { GitCommitHorizontal } from "lucide-react"
import type { PullRequestComment, PullRequestReview, ThreadPullRequestDetail } from "@cloudagents/protocol"
import { cn } from "@/lib/utils"
import { formatAgo } from "@/util"
import { CommentCard, ReviewCard } from "./Activity"
import {
  type PullRequestOrder,
  PullRequestOrderToggle,
  useNow,
} from "./presentation"

type TimelineItem =
  | { readonly kind: "opened"; readonly id: string; readonly at: string; readonly actor: string | null }
  | {
      readonly kind: "commit"
      readonly id: string
      readonly at: string
      readonly oid: string
      readonly headline: string
      readonly actor: string | null
    }
  | { readonly kind: "comment"; readonly id: string; readonly at: string; readonly comment: PullRequestComment }
  | { readonly kind: "review"; readonly id: string; readonly at: string | null; readonly review: PullRequestReview }
  | { readonly kind: "merged" | "closed"; readonly id: string; readonly at: string }

function timestamp(at: string | null): number {
  if (at === null) return 0
  const value = Date.parse(at)
  return Number.isNaN(value) ? 0 : value
}

function buildTimeline(detail: ThreadPullRequestDetail): TimelineItem[] {
  const snapshot = detail.summary.snapshot
  const items: TimelineItem[] = [
    {
      kind: "opened",
      id: "opened",
      at: snapshot?.createdAt ?? detail.summary.addedAt,
      actor: snapshot?.author ?? null,
    },
  ]
  for (const commit of detail.commits) {
    items.push({
      kind: "commit",
      id: `commit:${commit.oid}`,
      at: commit.committedAt,
      oid: commit.oid,
      headline: commit.headline,
      actor: commit.author,
    })
  }
  for (const comment of detail.comments) {
    items.push({
      kind: "comment",
      id: `comment:${comment.url}:${comment.createdAt}`,
      at: comment.createdAt,
      comment,
    })
  }
  for (const review of detail.reviews) {
    items.push({
      kind: "review",
      id: `review:${review.url}:${review.submittedAt ?? ""}`,
      at: review.submittedAt,
      review,
    })
  }
  if (snapshot?.mergedAt !== null && snapshot?.mergedAt !== undefined) {
    items.push({ kind: "merged", id: "merged", at: snapshot.mergedAt })
  } else if (snapshot?.closedAt !== null && snapshot?.closedAt !== undefined) {
    items.push({ kind: "closed", id: "closed", at: snapshot.closedAt })
  }
  return items
}

const DOT: Record<TimelineItem["kind"], string> = {
  opened: "bg-success",
  commit: "bg-muted-foreground",
  comment: "bg-muted-foreground",
  review: "bg-info",
  merged: "bg-info",
  closed: "bg-destructive",
}

/** The pull request's life: opened, commits, comments, reviews, and how it ended, on one vertical line. */
export function PullRequestTimeline({ detail }: { detail: ThreadPullRequestDetail }) {
  const now = useNow()
  const [order, setOrder] = useState<PullRequestOrder>("newest")
  const items = useMemo(() => {
    const built = buildTimeline(detail)
    return built.sort((a, b) =>
      order === "newest" ? timestamp(b.at) - timestamp(a.at) : timestamp(a.at) - timestamp(b.at),
    )
  }, [detail, order])

  return (
    <div className="flex flex-col gap-3 text-xs">
      <div className="flex items-center justify-between gap-2">
        <h3 className="text-xs font-medium text-muted-foreground">Timeline</h3>
        <PullRequestOrderToggle value={order} onChange={setOrder} label="Timeline" />
      </div>
      <ol className="relative ml-1 flex flex-col gap-4 border-l border-border pl-4">
        {items.map((item) => (
          <li key={item.id} className="relative">
            <span
              aria-hidden="true"
              className={cn(
                "absolute top-1.5 -left-[1.125rem] size-2 rounded-full ring-4 ring-background",
                DOT[item.kind],
              )}
            />
            <TimelineRow item={item} now={now} />
          </li>
        ))}
      </ol>
    </div>
  )
}

function TimelineRow({ item, now }: { item: TimelineItem; now: number }) {
  switch (item.kind) {
    case "opened":
      return (
        <p className="text-muted-foreground">
          <span className="font-medium text-foreground">{item.actor ?? "ghost"}</span> opened this pull request{" "}
          <span className="whitespace-nowrap">{formatAgo(item.at, now)}</span>
        </p>
      )
    // GitHub's pull request payload names neither the account that merged nor the one that closed it, so these show
    // when it ended without guessing at an actor.
    case "merged":
    case "closed":
      return (
        <p className="text-muted-foreground">
          This pull request was {item.kind}{" "}
          <span className="whitespace-nowrap">{formatAgo(item.at, now)}</span>
        </p>
      )
    case "commit":
      return (
        <div className="flex flex-col gap-0.5">
          <p className="flex min-w-0 items-center gap-1.5">
            <GitCommitHorizontal aria-hidden="true" className="size-3.5 shrink-0 text-muted-foreground" />
            <span className="min-w-0 truncate font-medium text-foreground">{item.headline}</span>
          </p>
          <p className="flex items-center gap-1.5 text-muted-foreground">
            <span className="font-mono">{item.oid.slice(0, 7)}</span>
            <span aria-hidden="true">·</span>
            <span>{item.actor ?? "ghost"}</span>
            <span aria-hidden="true">·</span>
            <span className="whitespace-nowrap">{formatAgo(item.at, now)}</span>
          </p>
        </div>
      )
    case "comment":
      return <CommentCard comment={item.comment} now={now} />
    case "review":
      return <ReviewCard review={item.review} now={now} />
  }
}
