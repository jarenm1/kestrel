import { Context, Data, Effect, Layer, Schema } from "effect"
import { Config } from "../config"

/**
 * Host-side GitHub REST client. Tokens are passed per call and never stored, logged, or put in errors:
 * error messages carry only GitHub's status and message text.
 */

export class GitHubError extends Data.TaggedError("GitHubError")<{ readonly message: string }> {}

export interface RepoSlug {
  readonly owner: string
  readonly name: string
}

/** `owner/name` of a github.com remote, or null for any other host. */
export const parseGitHubRepo = (url: string): RepoSlug | null => {
  const match = /^(?:https:\/\/github\.com\/|ssh:\/\/git@github\.com\/|git@github\.com:)([^/\s:]+)\/([^/\s]+?)(?:\.git)?\/?$/.exec(
    url.trim(),
  )
  const owner = match?.[1]
  const name = match?.[2]
  return owner !== undefined && name !== undefined ? { owner, name } : null
}

export interface PullRequest {
  readonly number: number
  /** GraphQL node id, needed to change draft state (REST cannot). */
  readonly nodeId: string
  readonly url: string
  readonly title: string
  readonly state: "open" | "closed" | "merged"
  readonly draft: boolean
  readonly headSha: string
  /** Branch the pull request merges into. */
  readonly baseRef: string
  /** Branch the pull request was opened from. */
  readonly headRef: string
  /** null while GitHub is still computing mergeability. */
  readonly mergeable: boolean | null
  readonly mergeableState: string
}

export interface ReviewComment {
  readonly path: string
  readonly line: number | null
  readonly author: string
  readonly body: string
  readonly url: string
}

export interface PullRequestStatus extends PullRequest {
  readonly reviewDecision: "approved" | "changes_requested" | "commented" | "none"
  readonly checks: {
    readonly total: number
    readonly passed: number
    readonly failing: readonly string[]
    readonly pending: readonly string[]
  }
  /** Most recent review comments, newest first. */
  readonly reviewComments: readonly ReviewComment[]
  readonly conversation: readonly { readonly author: string; readonly body: string; readonly url: string }[]
}

export interface NewPullRequest {
  readonly title: string
  readonly body: string
  readonly head: string
  readonly base: string
  readonly draft: boolean
}

/** A line comment on a pull request diff. GitHub's `side` defaults to RIGHT (the new file). */
export interface NewReviewComment {
  readonly path: string
  readonly line: number
  readonly side?: "LEFT" | "RIGHT"
  readonly body: string
}

/** A review on a pull request. APPROVE is deliberately not offered to agents. */
export interface NewReview {
  readonly body: string
  readonly event: "COMMENT" | "REQUEST_CHANGES"
  readonly comments: readonly NewReviewComment[]
}

export interface PostedReview {
  readonly url: string
  readonly state: string
}

/** Fields of a pull request an agent may change. Omitted fields are left alone. */
export interface PullRequestChanges {
  readonly title?: string
  readonly body?: string
  readonly base?: string
  readonly state?: "open" | "closed"
  readonly draft?: boolean
}

/** A comment on the pull request's conversation (`conversation`) or on its diff (`review`). */
export type CommentKind = "conversation" | "review"

export interface PostedComment {
  readonly id: number
  readonly url: string
}

/** Where a comment sits and who wrote it. GitHub comment ids are repository-wide, so the pull request must be checked. */
export interface CommentDetails {
  /** Number of the pull request the comment belongs to, or null when it is not on a pull request. */
  readonly pullRequest: number | null
  readonly author: string
}

/** Why `comment` may not be edited or deleted as `viewer` on pull request `number`, or null when it may. */
export const commentMismatch = (comment: CommentDetails, number: number, viewer: string): string | null => {
  if (comment.pullRequest !== number) return `it is not on pull request #${number}`
  if (comment.author !== viewer) return `it was written by ${comment.author}, not by the connected account ${viewer}`
  return null
}

/** Users and teams to ask for a review. Team slugs, not names. */
export interface ReviewerRequest {
  readonly reviewers: readonly string[]
  readonly teamReviewers: readonly string[]
}

export interface GitHubShape {
  /** Open pull request whose head branch is `head` in `repo`, or null. */
  readonly findOpenPullRequest: (token: string, repo: RepoSlug, head: string) => Effect.Effect<PullRequest | null, GitHubError>
  readonly createPullRequest: (token: string, repo: RepoSlug, input: NewPullRequest) => Effect.Effect<PullRequest, GitHubError>
  readonly getPullRequestStatus: (token: string, repo: RepoSlug, number: number) => Effect.Effect<PullRequestStatus, GitHubError>
  readonly createReview: (token: string, repo: RepoSlug, number: number, review: NewReview) => Effect.Effect<PostedReview, GitHubError>
  /** Edits the given fields and returns the pull request as GitHub now has it. */
  readonly updatePullRequest: (token: string, repo: RepoSlug, number: number, changes: PullRequestChanges) => Effect.Effect<PullRequest, GitHubError>
  readonly createComment: (token: string, repo: RepoSlug, number: number, body: string) => Effect.Effect<PostedComment, GitHubError>
  /** Replies in the thread of a review comment on the pull request's diff. */
  readonly replyToReviewComment: (token: string, repo: RepoSlug, number: number, commentId: number, body: string) => Effect.Effect<PostedComment, GitHubError>
  readonly editComment: (token: string, repo: RepoSlug, kind: CommentKind, commentId: number, body: string) => Effect.Effect<PostedComment, GitHubError>
  readonly deleteComment: (token: string, repo: RepoSlug, kind: CommentKind, commentId: number) => Effect.Effect<void, GitHubError>
  readonly getComment: (token: string, repo: RepoSlug, kind: CommentKind, commentId: number) => Effect.Effect<CommentDetails, GitHubError>
  /** Login of the account the token belongs to. */
  readonly viewerLogin: (token: string, repo: RepoSlug) => Effect.Effect<string, GitHubError>
  readonly requestReviewers: (token: string, repo: RepoSlug, number: number, request: ReviewerRequest) => Effect.Effect<void, GitHubError>
  readonly removeReviewers: (token: string, repo: RepoSlug, number: number, request: ReviewerRequest) => Effect.Effect<void, GitHubError>
  readonly addLabels: (token: string, repo: RepoSlug, number: number, labels: readonly string[]) => Effect.Effect<void, GitHubError>
  readonly removeLabel: (token: string, repo: RepoSlug, number: number, label: string) => Effect.Effect<void, GitHubError>
}

export class GitHub extends Context.Tag("cloudagents/GitHub")<GitHub, GitHubShape>() {}

const PullRequestBody = Schema.Struct({
  number: Schema.Number,
  node_id: Schema.String,
  html_url: Schema.String,
  title: Schema.String,
  state: Schema.String,
  merged: Schema.Boolean,
  draft: Schema.Boolean,
  mergeable: Schema.optional(Schema.NullOr(Schema.Boolean)),
  mergeable_state: Schema.optional(Schema.String),
  head: Schema.Struct({ sha: Schema.String, ref: Schema.String }),
  base: Schema.Struct({ ref: Schema.String }),
})

const PullRequestList = Schema.Array(PullRequestBody)

const CheckRunsBody = Schema.Struct({
  check_runs: Schema.Array(
    Schema.Struct({
      name: Schema.String,
      status: Schema.String,
      conclusion: Schema.NullOr(Schema.String),
    }),
  ),
})

const ReviewsBody = Schema.Array(
  Schema.Struct({
    state: Schema.String,
    body: Schema.optional(Schema.NullOr(Schema.String)),
    html_url: Schema.optional(Schema.String),
    user: Schema.NullOr(Schema.Struct({ login: Schema.String })),
  }),
)

const ConversationBody = Schema.Array(Schema.Struct({ body: Schema.String, html_url: Schema.String, user: Schema.NullOr(Schema.Struct({ login: Schema.String })) }))

const ReviewCommentsBody = Schema.Array(
  Schema.Struct({
    path: Schema.String,
    line: Schema.optional(Schema.NullOr(Schema.Number)),
    body: Schema.String,
    html_url: Schema.String,
    user: Schema.NullOr(Schema.Struct({ login: Schema.String })),
  }),
)

const ReviewPostedBody = Schema.Struct({
  html_url: Schema.String,
  state: Schema.String,
})

const CommentPostedBody = Schema.Struct({
  id: Schema.Number,
  html_url: Schema.String,
})

/** Review comments carry `pull_request_url`; conversation comments carry `issue_url`. */
const CommentDetailsBody = Schema.Struct({
  issue_url: Schema.optional(Schema.String),
  pull_request_url: Schema.optional(Schema.String),
  user: Schema.NullOr(Schema.Struct({ login: Schema.String })),
})

const ViewerBody = Schema.Struct({ login: Schema.String })

/** GraphQL answers HTTP 200 even when a mutation fails; the failure is in `errors`. */
const GraphQLBody = Schema.Struct({
  errors: Schema.optional(Schema.Array(Schema.Struct({ message: Schema.String }))),
})

const PASSING_CONCLUSIONS = ["success", "neutral", "skipped"]

/** Latest review state per reviewer, then the strongest signal wins. Dismissed reviews drop out. */
const reviewDecisionOf = (reviews: readonly { state: string; login: string }[]): PullRequestStatus["reviewDecision"] => {
  const latest = new Map<string, string>()
  for (const review of reviews) {
    if (review.state === "DISMISSED") latest.delete(review.login)
    else latest.set(review.login, review.state)
  }
  const states = [...latest.values()]
  if (states.includes("CHANGES_REQUESTED")) return "changes_requested"
  if (states.includes("APPROVED")) return "approved"
  if (states.includes("COMMENTED")) return "commented"
  return "none"
}

export const GitHubLive = Layer.effect(
  GitHub,
  Effect.map(Config, (config) => {
    const apiBase = config.githubApiUrl

    const call = (token: string, repo: RepoSlug, method: string, path: string, body?: unknown) =>
      Effect.tryPromise({
        try: async () => {
          const response = await fetch(`${apiBase}${path}`, {
            method,
            headers: {
              authorization: `Bearer ${token}`,
              accept: "application/vnd.github+json",
              "x-github-api-version": "2022-11-28",
              "user-agent": "kestrel-mcp",
              ...(body === undefined ? {} : { "content-type": "application/json" }),
            },
            body: body === undefined ? undefined : JSON.stringify(body),
            signal: AbortSignal.timeout(30_000),
          })
          const text = await response.text()
          return { status: response.status, text }
        },
        catch: () => new GitHubError({ message: "could not reach the GitHub API" }),
      }).pipe(
        Effect.flatMap(({ status, text }) => {
          if (status >= 200 && status < 300) {
            return Effect.try({
              try: () => (text === "" ? null : (JSON.parse(text) as unknown)),
              catch: () => new GitHubError({ message: "GitHub returned a non-JSON response" }),
            })
          }
          return Effect.fail(new GitHubError({ message: describeFailure(status, text, repo) }))
        }),
      )

    const decode = <A, I>(schema: Schema.Schema<A, I>, label: string) => (json: unknown) =>
      Schema.decodeUnknown(schema)(json).pipe(
        Effect.mapError(() => new GitHubError({ message: `unexpected ${label} response from GitHub` })),
      )

    const repoPath = (repo: RepoSlug) => `/repos/${encodeURIComponent(repo.owner)}/${encodeURIComponent(repo.name)}`

    const toPullRequest = (pr: Schema.Schema.Type<typeof PullRequestBody>): PullRequest => ({
      number: pr.number,
      nodeId: pr.node_id,
      url: pr.html_url,
      title: pr.title,
      state: pr.merged ? "merged" : pr.state === "open" ? "open" : "closed",
      draft: pr.draft,
      headSha: pr.head.sha,
      baseRef: pr.base.ref,
      headRef: pr.head.ref,
      mergeable: pr.mergeable ?? null,
      mergeableState: pr.mergeable_state ?? "unknown",
    })

    const getPullRequest = (token: string, repo: RepoSlug, number: number) =>
      call(token, repo, "GET", `${repoPath(repo)}/pulls/${number}`).pipe(
        Effect.flatMap(decode(PullRequestBody, "pull request")),
        Effect.map(toPullRequest),
      )

    const toComment = (comment: Schema.Schema.Type<typeof CommentPostedBody>): PostedComment => ({
      id: comment.id,
      url: comment.html_url,
    })

    const postComment = (token: string, repo: RepoSlug, path: string, body: string) =>
      call(token, repo, "POST", path, { body }).pipe(
        Effect.flatMap(decode(CommentPostedBody, "comment")),
        Effect.map(toComment),
      )

    const commentPath = (repo: RepoSlug, kind: CommentKind, commentId: number) =>
      kind === "review"
        ? `${repoPath(repo)}/pulls/comments/${commentId}`
        : `${repoPath(repo)}/issues/comments/${commentId}`

    const reviewersBody = (request: ReviewerRequest) => ({
      reviewers: request.reviewers,
      team_reviewers: request.teamReviewers,
    })

    /** REST cannot change draft state; GraphQL can. The mutation is fixed, only the direction varies. */
    const setDraft = (token: string, repo: RepoSlug, nodeId: string, draft: boolean): Effect.Effect<void, GitHubError> =>
      call(token, repo, "POST", "/graphql", {
        query: `mutation ($id: ID!) { ${draft ? "convertPullRequestToDraft" : "markPullRequestReadyForReview"}(input: { pullRequestId: $id }) { pullRequest { isDraft } } }`,
        variables: { id: nodeId },
      }).pipe(
        Effect.flatMap(decode(GraphQLBody, "GraphQL")),
        Effect.flatMap((body) => {
          const [first] = body.errors ?? []
          return first === undefined ? Effect.void : Effect.fail(new GitHubError({ message: first.message }))
        }),
      )

    const service: GitHubShape = {
      findOpenPullRequest: (token, repo, head) =>
        call(
          token,
          repo,
          "GET",
          `${repoPath(repo)}/pulls?state=open&per_page=5&head=${encodeURIComponent(`${repo.owner}:${head}`)}`,
        ).pipe(
          Effect.flatMap(decode(PullRequestList, "pull request list")),
          Effect.map((prs) => (prs[0] ? toPullRequest(prs[0]) : null)),
        ),

      createPullRequest: (token, repo, input) =>
        call(token, repo, "POST", `${repoPath(repo)}/pulls`, {
          title: input.title,
          body: input.body,
          head: input.head,
          base: input.base,
          draft: input.draft,
        }).pipe(
          Effect.flatMap(decode(PullRequestBody, "pull request")),
          Effect.map(toPullRequest),
        ),

      getPullRequestStatus: (token, repo, number) =>
        Effect.all(
          [
            getPullRequest(token, repo, number),
            call(token, repo, "GET", `${repoPath(repo)}/pulls/${number}/reviews?per_page=100`).pipe(
              Effect.flatMap(decode(ReviewsBody, "review list")),
            ),
            call(token, repo, "GET", `${repoPath(repo)}/pulls/${number}/comments?sort=created&direction=desc&per_page=10`).pipe(
              Effect.flatMap(decode(ReviewCommentsBody, "review comment list")),
            ),
            call(token, repo, "GET", `${repoPath(repo)}/issues/${number}/comments?sort=created&direction=desc&per_page=20`).pipe(
              Effect.flatMap(decode(ConversationBody, "issue comment list")),
            ),
          ],
          { concurrency: "unbounded" },
        ).pipe(
          Effect.flatMap(([pr, reviews, comments, conversation]) =>
            call(token, repo, "GET", `${repoPath(repo)}/commits/${pr.headSha}/check-runs?per_page=100`).pipe(
              Effect.flatMap(decode(CheckRunsBody, "check run list")),
              Effect.map((checks): PullRequestStatus => {
                const failing: string[] = []
                const pending: string[] = []
                let passed = 0
                for (const run of checks.check_runs) {
                  if (run.status !== "completed") pending.push(run.name)
                  else if (PASSING_CONCLUSIONS.includes(run.conclusion ?? "")) passed++
                  else failing.push(run.name)
                }
                return {
                  ...pr,
                  reviewDecision: reviewDecisionOf(
                    reviews.map((review) => ({ state: review.state, login: review.user?.login ?? "ghost" })),
                  ),
                  checks: { total: checks.check_runs.length, passed, failing, pending },
                  conversation: [
                    ...reviews.filter((review) => review.body && review.html_url).slice(-20).map((review) => ({ author: review.user?.login ?? "ghost", body: review.body ?? "", url: review.html_url ?? "" })),
                    ...conversation.map((comment) => ({ author: comment.user?.login ?? "ghost", body: comment.body, url: comment.html_url })),
                  ],
                  reviewComments: comments.map((comment) => ({
                    path: comment.path,
                    line: comment.line ?? null,
                    author: comment.user?.login ?? "ghost",
                    body: comment.body,
                    url: comment.html_url,
                  })),
                }
              }),
            ),
          ),
        ),
      createReview: (token, repo, number, review) =>
        call(token, repo, "POST", `${repoPath(repo)}/pulls/${number}/reviews`, {
          body: review.body,
          event: review.event,
          comments: review.comments,
        }).pipe(
          Effect.flatMap(decode(ReviewPostedBody, "review")),
          Effect.map((posted): PostedReview => ({ url: posted.html_url, state: posted.state })),
        ),
      updatePullRequest: (token, repo, number, changes) => {
        const { draft, ...rest } = changes
        const fields = Object.fromEntries(Object.entries(rest).filter(([, value]) => value !== undefined))
        const patch: Effect.Effect<void, GitHubError> =
          Object.keys(fields).length === 0
            ? Effect.void
            : call(token, repo, "PATCH", `${repoPath(repo)}/pulls/${number}`, fields).pipe(Effect.asVoid)
        const draftChange: Effect.Effect<void, GitHubError> =
          draft === undefined
            ? Effect.void
            : getPullRequest(token, repo, number).pipe(
                Effect.flatMap((current) => (current.draft === draft ? Effect.void : setDraft(token, repo, current.nodeId, draft))),
              )
        return patch.pipe(Effect.zipRight(draftChange), Effect.zipRight(getPullRequest(token, repo, number)))
      },
      createComment: (token, repo, number, body) => postComment(token, repo, `${repoPath(repo)}/issues/${number}/comments`, body),
      replyToReviewComment: (token, repo, number, commentId, body) =>
        postComment(token, repo, `${repoPath(repo)}/pulls/${number}/comments/${commentId}/replies`, body),
      editComment: (token, repo, kind, commentId, body) =>
        call(token, repo, "PATCH", commentPath(repo, kind, commentId), { body }).pipe(
          Effect.flatMap(decode(CommentPostedBody, "comment")),
          Effect.map(toComment),
        ),
      deleteComment: (token, repo, kind, commentId) =>
        call(token, repo, "DELETE", commentPath(repo, kind, commentId)).pipe(Effect.asVoid),
      getComment: (token, repo, kind, commentId) =>
        call(token, repo, "GET", commentPath(repo, kind, commentId)).pipe(
          Effect.flatMap(decode(CommentDetailsBody, "comment")),
          Effect.map((comment): CommentDetails => {
            const url = comment.pull_request_url ?? comment.issue_url ?? ""
            const number = /\/(\d+)$/.exec(url)?.[1]
            return { pullRequest: number === undefined ? null : Number(number), author: comment.user?.login ?? "ghost" }
          }),
        ),
      viewerLogin: (token, repo) =>
        call(token, repo, "GET", "/user").pipe(
          Effect.flatMap(decode(ViewerBody, "user")),
          Effect.map((viewer) => viewer.login),
        ),
      requestReviewers: (token, repo, number, request) =>
        call(token, repo, "POST", `${repoPath(repo)}/pulls/${number}/requested_reviewers`, reviewersBody(request)).pipe(Effect.asVoid),
      removeReviewers: (token, repo, number, request) =>
        call(token, repo, "DELETE", `${repoPath(repo)}/pulls/${number}/requested_reviewers`, reviewersBody(request)).pipe(Effect.asVoid),
      addLabels: (token, repo, number, labels) =>
        call(token, repo, "POST", `${repoPath(repo)}/issues/${number}/labels`, { labels: [...labels] }).pipe(Effect.asVoid),
      removeLabel: (token, repo, number, label) =>
        call(token, repo, "DELETE", `${repoPath(repo)}/issues/${number}/labels/${encodeURIComponent(label)}`).pipe(Effect.asVoid),
    }
    return service
  }),
)

const describeFailure = (status: number, text: string, repo: RepoSlug): string => {
  const slug = `${repo.owner}/${repo.name}`
  const detail = (() => {
    try {
      const parsed = JSON.parse(text) as { message?: unknown }
      return typeof parsed.message === "string" ? parsed.message : ""
    } catch {
      return ""
    }
  })()
  if (status === 401) return "GitHub rejected the connected token (expired or revoked): reconnect GitHub and retry"
  if (status === 403) return `GitHub denied access to ${slug} (the connected account lacks permission): ${detail}`.trimEnd()
  if (status === 404) return `GitHub repository ${slug} not found or not visible to the connected account`
  return `GitHub API ${status}${detail ? `: ${detail}` : ""}`
}
