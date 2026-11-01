import { Schema } from "effect"

/** Only wake a thread for events that can require action. Payload content is fetched by the agent, not trusted as instructions. */
const Repository = Schema.Struct({ full_name: Schema.String })
const NumberedPullRequest = Schema.Struct({ number: Schema.Number })
const Review = Schema.Struct({ action: Schema.Literal("submitted"), repository: Repository, pull_request: NumberedPullRequest })
const ReviewComment = Schema.Struct({ action: Schema.Literal("created"), repository: Repository, pull_request: NumberedPullRequest })
const IssueComment = Schema.Struct({
  action: Schema.Literal("created"), repository: Repository,
  issue: Schema.Struct({ number: Schema.Number, pull_request: Schema.Struct({}) }),
})
const CheckRun = Schema.Struct({
  action: Schema.Literal("completed"), repository: Repository,
  check_run: Schema.Struct({ conclusion: Schema.NullOr(Schema.String), head_sha: Schema.optional(Schema.String), pull_requests: Schema.Array(NumberedPullRequest) }),
})

export interface PullRequestActivity {
  readonly repo: string
  readonly numbers: ReadonlyArray<number>
  readonly headSha?: string
  readonly kind: "review" | "review_comment" | "comment" | "check"
}

/** Reduce a verified GitHub delivery to PR identities; unsupported or incomplete events do not wake an agent. */
export const pullRequestActivity = (event: string, payload: unknown): PullRequestActivity | null => {
  if (event === "pull_request_review") {
    const decoded = Schema.decodeUnknownEither(Review)(payload)
    return decoded._tag === "Left" ? null : { repo: decoded.right.repository.full_name, numbers: [decoded.right.pull_request.number], kind: "review" }
  }
  if (event === "pull_request_review_comment") {
    const decoded = Schema.decodeUnknownEither(ReviewComment)(payload)
    return decoded._tag === "Left" ? null : { repo: decoded.right.repository.full_name, numbers: [decoded.right.pull_request.number], kind: "review_comment" }
  }
  if (event === "issue_comment") {
    const decoded = Schema.decodeUnknownEither(IssueComment)(payload)
    return decoded._tag === "Left" ? null : { repo: decoded.right.repository.full_name, numbers: [decoded.right.issue.number], kind: "comment" }
  }
  if (event === "check_run") {
    const decoded = Schema.decodeUnknownEither(CheckRun)(payload)
    if (decoded._tag === "Left" || decoded.right.check_run.conclusion === null) return null
    const numbers = [...new Set(decoded.right.check_run.pull_requests.map((pr) => pr.number))]
    if (numbers.length === 0 && decoded.right.check_run.head_sha === undefined) return null
    return { repo: decoded.right.repository.full_name, numbers, kind: "check", ...(decoded.right.check_run.head_sha === undefined ? {} : { headSha: decoded.right.check_run.head_sha }) }
  }
  return null
}
