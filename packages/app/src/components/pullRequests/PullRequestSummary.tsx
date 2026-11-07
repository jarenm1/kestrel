import { useMemo, useState } from "react"
import { CircleCheck, CircleDashed, CircleDot, CircleX } from "lucide-react"
import type { ThreadPullRequestDetail, ThreadPullRequestSnapshot } from "@cloudagents/protocol"
import { Markdown } from "@cloudagents/ui/markdown"
import { cn } from "@/lib/utils"
import { CommentCard } from "./Activity"
import {
  type PullRequestOrder,
  PullRequestOrderToggle,
  pullRequestCheckStatus,
  useNow,
} from "./presentation"

/** Description, labels, reviewers, checks and the conversation, as GitHub presents them. */
export function PullRequestSummary({ detail }: { detail: ThreadPullRequestDetail }) {
  const now = useNow()
  const [order, setOrder] = useState<PullRequestOrder>("newest")
  const snapshot = detail.summary.snapshot
  const labels = snapshot?.labels ?? []
  const reviewers = snapshot?.reviewers ?? []

  const comments = useMemo(() => {
    const sorted = [...detail.comments].sort((a, b) => a.createdAt.localeCompare(b.createdAt))
    if (order === "newest") sorted.reverse()
    return sorted
  }, [detail.comments, order])

  return (
    <div className="flex flex-col gap-4 text-xs">
      <section aria-label="Description">
        <h3 className="mb-1.5 text-xs font-medium text-muted-foreground">Description</h3>
        {detail.body.trim() === "" ? (
          <p className="text-muted-foreground italic">No description provided.</p>
        ) : (
          <Markdown text={detail.body} className="text-xs" />
        )}
      </section>

      {(labels.length > 0 || reviewers.length > 0) && (
        <section className="flex flex-col gap-2">
          {labels.length > 0 && <Chips label="Labels" items={labels} />}
          {reviewers.length > 0 && <Chips label="Reviewers" items={reviewers} />}
        </section>
      )}

      <ChecksSection checks={snapshot?.checks} />

      {snapshot !== undefined && <MergeSection snapshot={snapshot} />}

      <section aria-label="Comments">
        <div className="mb-2 flex items-center justify-between gap-2">
          <h3 className="text-xs font-medium text-muted-foreground">Comments</h3>
          <PullRequestOrderToggle value={order} onChange={setOrder} label="Comments" />
        </div>
        {comments.length === 0 ? (
          <p className="text-muted-foreground">No comments yet.</p>
        ) : (
          <div className="flex flex-col gap-2">
            {comments.map((comment) => (
              <CommentCard key={`${comment.url}:${comment.createdAt}`} comment={comment} now={now} />
            ))}
          </div>
        )}
      </section>
    </div>
  )
}

function Chips({ label, items }: { label: string; items: readonly string[] }) {
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      <span className="mr-1 text-xs font-medium text-muted-foreground">{label}</span>
      {items.map((item) => (
        <span key={item} className="rounded-full bg-white/[0.06] px-2 py-0.5 text-[11px] text-foreground">
          {item}
        </span>
      ))}
    </div>
  )
}

const CHECK_TONE: Record<"failing" | "pending", { icon: typeof CircleX; className: string }> = {
  failing: { icon: CircleX, className: "text-destructive" },
  pending: { icon: CircleDashed, className: "text-warning" },
}

function CheckRow({ name, tone }: { name: string; tone: "failing" | "pending" }) {
  const { icon: Icon, className } = CHECK_TONE[tone]
  return (
    <p className="flex min-w-0 items-center gap-1.5">
      <Icon aria-hidden="true" className={cn("size-3.5 shrink-0", className)} />
      <span className="min-w-0 truncate">{name}</span>
    </p>
  )
}

const REVIEW_TEXT: Record<
  ThreadPullRequestSnapshot["reviewDecision"],
  { readonly label: string; readonly className: string; readonly icon: typeof CircleCheck }
> = {
  approved: { label: "Approved", className: "text-success", icon: CircleCheck },
  changes_requested: { label: "Changes requested", className: "text-destructive", icon: CircleX },
  commented: { label: "Reviewed", className: "text-info", icon: CircleDot },
  none: { label: "Awaiting review", className: "text-muted-foreground", icon: CircleDot },
}

/** How the pull request stands: its review verdict and whether it can merge into its base. */
function MergeSection({ snapshot }: { snapshot: ThreadPullRequestSnapshot }) {
  const review = REVIEW_TEXT[snapshot.reviewDecision]
  const ReviewIcon = review.icon
  return (
    <section aria-label="Merge" className="flex flex-col gap-1.5">
      <h3 className="text-xs font-medium text-muted-foreground">Merge</h3>
      <p className={cn("flex items-center gap-1.5", review.className)}>
        <ReviewIcon aria-hidden="true" className="size-3.5 shrink-0" />
        {review.label}
      </p>
      {snapshot.state === "merged" ? (
        <p className="text-info">Merged into {snapshot.baseRef}.</p>
      ) : snapshot.state === "closed" ? (
        <p className="text-muted-foreground">Closed without merging.</p>
      ) : snapshot.mergeable === false ? (
        <p className="text-warning">This branch conflicts with {snapshot.baseRef}.</p>
      ) : snapshot.mergeable === null ? (
        <p className="text-muted-foreground">GitHub is still computing whether it can merge.</p>
      ) : (
        <p className="flex items-center gap-1.5 text-muted-foreground">
          <CircleCheck aria-hidden="true" className="size-3.5 shrink-0 text-success" />
          {snapshot.draft ? "A draft; mark it ready before merging." : `Can merge into ${snapshot.baseRef}.`}
        </p>
      )}
    </section>
  )
}

function ChecksSection({ checks }: { checks: ThreadPullRequestSnapshot["checks"] | undefined }) {
  const status = checks === undefined ? null : pullRequestCheckStatus(checks)
  return (
    <section aria-label="Checks">
      <h3 className="mb-1.5 text-xs font-medium text-muted-foreground">Checks</h3>
      {checks === undefined || status === null ? (
        <p className="text-muted-foreground">No checks reported.</p>
      ) : (
        <div className="flex flex-col gap-2">
          {checks.failing.length > 0 && (
            <div className="flex flex-col gap-1">
              <p className="text-destructive">
                {checks.failing.length} failing
              </p>
              {checks.failing.map((name) => (
                <CheckRow key={name} name={name} tone="failing" />
              ))}
            </div>
          )}
          {checks.pending.length > 0 && (
            <div className="flex flex-col gap-1">
              <p className="text-warning">{checks.pending.length} pending</p>
              {checks.pending.map((name) => (
                <CheckRow key={name} name={name} tone="pending" />
              ))}
            </div>
          )}
          <p className="flex items-center gap-1.5 text-muted-foreground">
            <CircleCheck aria-hidden="true" className="size-3.5 shrink-0 text-success" />
            {checks.passed}/{checks.total} checks passed
          </p>
        </div>
      )}
    </section>
  )
}
