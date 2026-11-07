import { useId, useState } from "react"
import type { ThreadPullRequestAction } from "@cloudagents/protocol"
import { Button } from "@cloudagents/ui/button"
import { Textarea } from "@/components/ui/textarea"

type Verdict = "comment" | "approve" | "request-changes"

/**
 * Comment and review forms at the bottom of a pull request's detail. The panel owns the request, pending state and
 * errors; a successful submit clears the textarea it sent.
 */
export function PullRequestComposer({
  repo,
  number,
  pending,
  onAction,
}: {
  repo: string
  number: number
  pending: boolean
  onAction: (action: ThreadPullRequestAction) => Promise<unknown>
}) {
  const [comment, setComment] = useState("")
  const [verdict, setVerdict] = useState<Verdict>("comment")
  const [summary, setSummary] = useState("")
  const verdictId = useId()

  async function submitComment() {
    if (comment.trim() === "" || pending) return
    try {
      await onAction({ action: "comment", repo, number, body: comment })
      setComment("")
    } catch {
      // The detail shows the error at the top and leaves the draft in place.
    }
  }

  async function submitReview() {
    if (pending) return
    try {
      await onAction({ action: "review", repo, number, body: summary, verdict })
      setSummary("")
    } catch {
      // The detail shows the error at the top and leaves the draft in place.
    }
  }

  return (
    <div className="flex flex-col gap-4 border-t border-border/60 pt-3">
      <section aria-label="Comment" className="flex flex-col gap-1.5">
        <Textarea
          value={comment}
          onChange={(e) => setComment(e.target.value)}
          placeholder="Leave a comment"
          aria-label="Comment"
          rows={3}
        />
        <div className="flex justify-end">
          <Button
            variant="soft"
            size="sm"
            disabled={pending || comment.trim() === ""}
            onClick={() => void submitComment()}
          >
            {pending ? "Sending…" : "Comment"}
          </Button>
        </div>
      </section>
      <section aria-label="Review" className="flex flex-col gap-1.5">
        <div className="flex items-center gap-2">
          <label htmlFor={verdictId} className="text-xs text-muted-foreground">
            Review
          </label>
          <select
            id={verdictId}
            value={verdict}
            onChange={(e) => setVerdict(e.target.value as Verdict)}
            disabled={pending}
            className="h-7 rounded-md bg-input px-2 text-xs text-foreground shadow-well outline-none focus-visible:shadow-glow disabled:cursor-not-allowed disabled:opacity-50 [&>option]:bg-secondary"
          >
            <option value="comment">Comment</option>
            <option value="approve">Approve</option>
            <option value="request-changes">Request changes</option>
          </select>
        </div>
        <Textarea
          value={summary}
          onChange={(e) => setSummary(e.target.value)}
          placeholder="Review summary"
          aria-label="Review summary"
          rows={2}
        />
        <div className="flex justify-end">
          <Button variant="soft" size="sm" disabled={pending} onClick={() => void submitReview()}>
            {pending ? "Sending…" : "Submit review"}
          </Button>
        </div>
      </section>
    </div>
  )
}
