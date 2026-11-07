import { useEffect, useState } from "react"
import {
  ArrowUpDown,
  CircleCheck,
  CircleDashed,
  CircleDot,
  CircleX,
  GitMerge,
  GitPullRequest,
  GitPullRequestClosed,
  GitPullRequestDraft,
  ShieldCheck,
  ShieldX,
  TriangleAlert,
  type LucideIcon,
} from "lucide-react"
import type { ThreadPullRequestSnapshot } from "@cloudagents/protocol"
import { Button } from "@cloudagents/ui/button"
import { cn } from "@/lib/utils"

/** A badge tone shared with `Badge`, plus the colour a state glyph takes. */
export type PullRequestTone = "neutral" | "info" | "success" | "warning" | "destructive"

export interface PullRequestStatePresentation {
  readonly label: string
  readonly tone: PullRequestTone
  readonly icon: LucideIcon
  readonly className: string
}

/** How one pull request reads at a glance: draft and merged override GitHub's raw open/closed state. */
export function pullRequestState(snapshot: ThreadPullRequestSnapshot | undefined): PullRequestStatePresentation {
  if (snapshot === undefined) {
    return { label: "Unavailable", tone: "neutral", icon: GitPullRequest, className: "text-muted-foreground" }
  }
  if (snapshot.state === "merged") {
    return { label: "Merged", tone: "info", icon: GitMerge, className: "text-info" }
  }
  if (snapshot.state === "closed") {
    return { label: "Closed", tone: "destructive", icon: GitPullRequestClosed, className: "text-destructive" }
  }
  if (snapshot.draft) {
    return { label: "Draft", tone: "neutral", icon: GitPullRequestDraft, className: "text-muted-foreground" }
  }
  return { label: "Open", tone: "success", icon: GitPullRequest, className: "text-success" }
}

/** State glyph, with the conflict overlay GitHub reports once it has computed mergeability. */
export function PullRequestStateGlyph({
  snapshot,
  className,
}: {
  snapshot: ThreadPullRequestSnapshot | undefined
  className?: string
}) {
  const state = pullRequestState(snapshot)
  const conflicted = snapshot !== undefined && snapshot.state === "open" && snapshot.mergeable === false
  return (
    <span
      role="img"
      aria-label={conflicted ? `${state.label}, merge conflicts` : state.label}
      title={conflicted ? "Merge conflicts" : state.label}
      className={cn("relative inline-flex", className)}
    >
      <state.icon aria-hidden="true" className={cn("size-3.5", state.className)} />
      {conflicted && (
        <TriangleAlert
          aria-hidden="true"
          className="absolute -right-1.5 -bottom-1.5 size-3 fill-background text-warning"
        />
      )}
    </span>
  )
}

export type PullRequestCheckTone = "passing" | "failing" | "pending"

/** What the checks say overall; null when GitHub reports none. */
export function pullRequestCheckStatus(
  checks: ThreadPullRequestSnapshot["checks"],
): { readonly tone: PullRequestCheckTone; readonly label: string } | null {
  if (checks.total === 0) return null
  if (checks.failing.length > 0) {
    return { tone: "failing", label: `${checks.failing.length} check${checks.failing.length === 1 ? "" : "s"} failing` }
  }
  if (checks.pending.length > 0) {
    return { tone: "pending", label: `${checks.pending.length} check${checks.pending.length === 1 ? "" : "s"} pending` }
  }
  return { tone: "passing", label: `All ${checks.total} checks passed` }
}

const CHECK_ICON: Record<PullRequestCheckTone, { icon: LucideIcon; className: string }> = {
  passing: { icon: CircleCheck, className: "text-success" },
  failing: { icon: CircleX, className: "text-destructive" },
  pending: { icon: CircleDashed, className: "text-warning" },
}

export function PullRequestChecksGlyph({ checks }: { checks: ThreadPullRequestSnapshot["checks"] }) {
  const status = pullRequestCheckStatus(checks)
  if (status === null) return null
  const { icon: Icon, className } = CHECK_ICON[status.tone]
  return (
    <span role="img" aria-label={status.label} title={status.label} className="inline-flex shrink-0">
      <Icon aria-hidden="true" className={cn("size-3.5", className)} />
    </span>
  )
}

/** The review verdict glyph: approved, changes requested, or nobody has decided yet. */
export function PullRequestReviewGlyph({ decision }: { decision: ThreadPullRequestSnapshot["reviewDecision"] }) {
  if (decision === "approved") {
    return (
      <span role="img" aria-label="Approved" title="Approved" className="inline-flex shrink-0">
        <ShieldCheck aria-hidden="true" className="size-3.5 text-success" />
      </span>
    )
  }
  if (decision === "changes_requested") {
    return (
      <span role="img" aria-label="Changes requested" title="Changes requested" className="inline-flex shrink-0">
        <ShieldX aria-hidden="true" className="size-3.5 text-destructive" />
      </span>
    )
  }
  return (
    <span role="img" aria-label="Awaiting review" title="Awaiting review" className="inline-flex shrink-0">
      <CircleDot aria-hidden="true" className="size-3.5 text-muted-foreground" />
    </span>
  )
}

/** `+n −n` in the mono tint the diff views use. */
export function PullRequestStat({
  additions,
  deletions,
  className,
}: {
  additions: number
  deletions: number
  className?: string
}) {
  return (
    <span className={cn("shrink-0 font-mono whitespace-nowrap", className)}>
      <span className="text-success">+{additions}</span> <span className="text-destructive">−{deletions}</span>
    </span>
  )
}

/** How often relative labels refresh while the panel is open. */
const CLOCK_TICK_MS = 30_000

export function useNow(): number {
  const [now, setNow] = useState(Date.now)
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), CLOCK_TICK_MS)
    return () => window.clearInterval(id)
  }, [])
  return now
}

export type PullRequestOrder = "newest" | "oldest"

/** Newest/Oldest switch for the summary's comments and the timeline. */
export function PullRequestOrderToggle({
  value,
  onChange,
  label,
}: {
  value: PullRequestOrder
  onChange: (next: PullRequestOrder) => void
  label: string
}) {
  const next = value === "newest" ? "oldest" : "newest"
  return (
    <Button
      variant="ghost"
      size="sm"
      className="h-6 px-2 text-xs"
      aria-label={`${label}: show ${next} first`}
      title={`Show ${next} first`}
      onClick={() => onChange(next)}
    >
      <ArrowUpDown />
      {value === "newest" ? "Newest" : "Oldest"}
    </Button>
  )
}

/** The name a review row reads under: GitHub's `APPROVED` / `CHANGES_REQUESTED` in sentence case. */
export function reviewStateLabel(state: string): string {
  const words = state.toLowerCase().replace(/[_-]/g, " ")
  return words.charAt(0).toUpperCase() + words.slice(1)
}
