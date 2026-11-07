import { ExternalLink } from "lucide-react"
import type { PullRequestComment, PullRequestReview } from "@cloudagents/protocol"
import { Markdown } from "@cloudagents/ui/markdown"
import { formatAgo } from "@/util"
import { reviewStateLabel } from "./presentation"

/** One conversation/comment row: actor, time, the diff location when it has one, and its markdown body. */
export function CommentCard({ comment, now }: { comment: PullRequestComment; now: number }) {
  const kind =
    comment.kind === "conversation" ? "commented" : comment.kind === "review" ? "left a review" : "left a review comment"
  return (
    <article className="rounded-xl bg-background/60 p-3 shadow-well">
      <header className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
        <span className="font-medium text-foreground">{comment.author}</span>
        <span>{kind}</span>
        <span>{formatAgo(comment.createdAt, now)}</span>
        {comment.path !== null && (
          <span className="min-w-0 truncate font-mono">
            {comment.path}
            {comment.line === null ? "" : `:${comment.line}`}
          </span>
        )}
        <a
          href={comment.url}
          target="_blank"
          rel="noreferrer"
          aria-label="Open comment on GitHub"
          title="Open comment on GitHub"
          className="ml-auto shrink-0 text-muted-foreground transition-colors hover:text-foreground"
        >
          <ExternalLink className="size-3.5" />
        </a>
      </header>
      {comment.body.trim() !== "" && <Markdown text={comment.body} className="mt-2 text-xs" />}
    </article>
  )
}

/** One submitted review: actor, verdict, time, and its summary when there is one. */
export function ReviewCard({ review, now }: { review: PullRequestReview; now: number }) {
  return (
    <article className="rounded-xl bg-background/60 p-3 shadow-well">
      <header className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
        <span className="font-medium text-foreground">{review.author}</span>
        <span>{reviewStateLabel(review.state)}</span>
        {review.submittedAt !== null && <span>{formatAgo(review.submittedAt, now)}</span>}
        <a
          href={review.url}
          target="_blank"
          rel="noreferrer"
          aria-label="Open review on GitHub"
          title="Open review on GitHub"
          className="ml-auto shrink-0 text-muted-foreground transition-colors hover:text-foreground"
        >
          <ExternalLink className="size-3.5" />
        </a>
      </header>
      {review.body.trim() !== "" && <Markdown text={review.body} className="mt-2 text-xs" />}
    </article>
  )
}
