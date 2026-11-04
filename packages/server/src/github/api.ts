import { Context, Data, Effect, Layer, Schema } from "effect"
import { Config } from "../config"
import { apiDecision } from "./api-policy"

/**
 * Host-side GitHub REST client. Tokens are passed per call and never stored, logged, or put in errors:
 * error messages carry only GitHub's status and message text.
 */

export class GitHubError extends Data.TaggedError("GitHubError")<{
  readonly message: string
  /** HTTP status when GitHub answered; absent for transport and decoding failures. */
  readonly status?: number
}> {}

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
  /** owner/name the head branch lives in: a fork's for a pull request from one, null when that repository is gone. */
  readonly headRepo: string | null
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

/** Which GitHub reference a number names. The issues endpoint returns pull requests too, so callers must state it. */
export type ReferenceKind = "pr" | "issue"

export interface ReferenceComment {
  readonly author: string
  readonly body: string
  readonly url: string
  /** ISO timestamp GitHub reports for the comment. */
  readonly createdAt: string
}

export interface ReferenceReview {
  readonly author: string
  readonly state: string
  readonly body: string
  readonly url: string
}

export interface ReferenceReviewComment {
  readonly author: string
  readonly body: string
  readonly url: string
  readonly path: string
  readonly line: number | null
}

/** A file a pull request changes. Patches are deliberately omitted: status and line counts are the useful summary. */
export interface ReferenceFile {
  readonly path: string
  readonly status: string
  readonly additions: number
  readonly deletions: number
}

export interface IssueReference {
  readonly kind: "issue"
  readonly number: number
  readonly title: string
  readonly body: string
  readonly state: string
  /** `completed`, `not_planned`, `reopened`, or null when GitHub reports none. */
  readonly stateReason: string | null
  readonly author: string
  readonly url: string
  readonly createdAt: string
  readonly updatedAt: string
  readonly labels: readonly string[]
  /** Issue comments, in GitHub's chronological order (first page, up to 100). */
  readonly conversation: readonly ReferenceComment[]
}

export interface PullRequestReference {
  readonly kind: "pr"
  readonly number: number
  readonly title: string
  readonly body: string
  readonly state: "open" | "closed" | "merged"
  readonly draft: boolean
  readonly author: string
  readonly url: string
  readonly createdAt: string
  readonly updatedAt: string
  readonly labels: readonly string[]
  readonly baseRef: string
  readonly headRef: string
  readonly headSha: string
  /** null while GitHub is still computing mergeability. */
  readonly mergeable: boolean | null
  readonly mergeableState: string
  readonly reviewDecision: PullRequestStatus["reviewDecision"]
  /** null when GitHub will not report check runs for this head commit (for example a token without checks access). */
  readonly checks: PullRequestStatus["checks"] | null
  /** Reviews in the order GitHub returns them; bodies are often empty. */
  readonly reviews: readonly ReferenceReview[]
  /** Most recent review comments, newest first. */
  readonly reviewComments: readonly ReferenceReviewComment[]
  /** Conversation comments, in GitHub's chronological order (first page, up to 100). */
  readonly conversation: readonly ReferenceComment[]
  /** Files the pull request changes, up to GitHub's first page of 100. */
  readonly files: readonly ReferenceFile[]
}

/** An issue or pull request read without a checkout. `kind` must match what the number actually is. */
export type GitHubReference = IssueReference | PullRequestReference

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

/** One entry of a GraphQL `errors` array, as GitHub sends it. */
export interface GraphQLErrorItem {
  readonly message: string
  readonly path?: ReadonlyArray<string | number>
  readonly type?: string
}

/** A GraphQL answer as GitHub sent it: `errors` may sit beside partial `data`. */
export interface GraphQLResponse {
  readonly data: unknown
  readonly errors: ReadonlyArray<GraphQLErrorItem>
}

/** One `gh api` request: `path` is the endpoint argument (an API path, an API URL, or `graphql`). */
export interface ApiRequest {
  readonly method: string
  readonly path: string
  readonly headers: ReadonlyArray<readonly [string, string]>
  readonly body: string | null
}

/** GitHub's answer as received: header names lowercase, multiple values joined with ", ". */
export interface ApiResponse {
  readonly status: number
  readonly headers: ReadonlyArray<readonly [string, string]>
  readonly body: string
}

export interface GitHubShape {
  /** Open pull request whose head branch is `head` in `repo`, or null. */
  readonly findOpenPullRequest: (token: string, repo: RepoSlug, head: string) => Effect.Effect<PullRequest | null, GitHubError>
  readonly createPullRequest: (token: string, repo: RepoSlug, input: NewPullRequest) => Effect.Effect<PullRequest, GitHubError>
  readonly getPullRequestStatus: (token: string, repo: RepoSlug, number: number) => Effect.Effect<PullRequestStatus, GitHubError>
  /**
   * Reads an issue or pull request by number, whichever the caller says it is. Fails with an explicit kind-mismatch
   * error when the number is the other kind, and with a not-found error when GitHub has no such reference the token
   * can see. The token is only ever sent to GitHub.
   */
  readonly readReference: (
    token: string,
    repo: RepoSlug,
    number: number,
    kind: ReferenceKind,
  ) => Effect.Effect<GitHubReference, GitHubError>
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
  /**
   * Runs a GraphQL query or mutation. GraphQL-level errors come back in `errors`, not as a failure; an HTTP failure
   * is a GitHubError whose message reads like the GitHub CLI's (`HTTP 502: Bad Gateway (<url>)`).
   */
  readonly graphql: (token: string, query: string, variables: Readonly<Record<string, unknown>>) => Effect.Effect<GraphQLResponse, GitHubError>
  /** The pull request's diff (`diff`) or its commits as patches (`patch`), as GitHub renders them. Failures read like `graphql`'s. */
  readonly pullRequestDiff: (token: string, repo: RepoSlug, number: number, format: "diff" | "patch") => Effect.Effect<string, GitHubError>
  /**
   * Sends a `gh api` request to the GitHub API if `apiDecision` allows it: reads anywhere, the allowlisted writes only
   * on `repos` (the thread's checkouts; a review thread a mutation resolves is looked up first). A refused request or
   * one for another host fails with a GitHubError saying why. Reads follow redirects, the token only to the API itself.
   */
  readonly api: (token: string, request: ApiRequest, repos: ReadonlyArray<RepoSlug>) => Effect.Effect<ApiResponse, GitHubError>
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
  head: Schema.Struct({
    sha: Schema.String,
    ref: Schema.String,
    repo: Schema.optional(Schema.NullOr(Schema.Struct({ full_name: Schema.String }))),
  }),
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

/** GitHub's issue endpoint answers for pull requests too, with `pull_request` set; that is how kind is checked. */
const IssueBody = Schema.Struct({
  number: Schema.Number,
  html_url: Schema.String,
  title: Schema.String,
  body: Schema.optional(Schema.NullOr(Schema.String)),
  state: Schema.String,
  state_reason: Schema.optional(Schema.NullOr(Schema.String)),
  created_at: Schema.String,
  updated_at: Schema.String,
  user: Schema.NullOr(Schema.Struct({ login: Schema.String })),
  labels: Schema.Array(Schema.Struct({ name: Schema.String })),
  pull_request: Schema.optional(Schema.Unknown),
})

const ReferenceCommentsBody = Schema.Array(
  Schema.Struct({
    body: Schema.String,
    html_url: Schema.String,
    created_at: Schema.String,
    user: Schema.NullOr(Schema.Struct({ login: Schema.String })),
  }),
)

const PullFilesBody = Schema.Array(
  Schema.Struct({
    filename: Schema.String,
    status: Schema.String,
    additions: Schema.Number,
    deletions: Schema.Number,
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

const summarizeChecks = (checks: Schema.Schema.Type<typeof CheckRunsBody>): PullRequestStatus["checks"] => {
  const failing: string[] = []
  const pending: string[] = []
  let passed = 0
  for (const run of checks.check_runs) {
    if (run.status !== "completed") pending.push(run.name)
    else if (PASSING_CONCLUSIONS.includes(run.conclusion ?? "")) passed++
    else failing.push(run.name)
  }
  return { total: checks.check_runs.length, passed, failing, pending }
}

/** `nodes(ids:)` for review threads: null for an id GitHub does not know, no repository for another node type. */
const ThreadReposAnswer = Schema.Struct({
  data: Schema.optional(
    Schema.NullOr(
      Schema.Struct({
        nodes: Schema.Array(Schema.NullOr(Schema.Struct({ repository: Schema.optional(Schema.Struct({ nameWithOwner: Schema.String })) }))),
      }),
    ),
  ),
})

const GraphQLAnswer = Schema.Struct({
  data: Schema.optional(Schema.Unknown),
  errors: Schema.optional(
    Schema.Array(
      Schema.Struct({
        message: Schema.String,
        path: Schema.optional(Schema.Array(Schema.Union(Schema.String, Schema.Number))),
        type: Schema.optional(Schema.String),
      }),
    ),
  ),
})

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

/** Headers of an agent's `gh api` request the box never forwards: it sets the credential and the framing itself. */
const AGENT_DROPPED_HEADERS: Record<string, true> = { authorization: true, cookie: true, host: true, "content-length": true, connection: true, "transfer-encoding": true }

const REDIRECT_STATUSES: Record<number, true> = { 301: true, 302: true, 303: true, 307: true, 308: true }

export const GitHubLive = Layer.effect(
  GitHub,
  Effect.map(Config, (config) => {
    const apiBase = config.githubApiUrl

    /** One HTTP exchange with GitHub; the status is the caller's to judge. */
    const send = (token: string, method: string, path: string, options: { readonly body?: unknown; readonly accept?: string } = {}) =>
      Effect.tryPromise({
        try: async () => {
          const response = await fetch(`${apiBase}${path}`, {
            method,
            headers: {
              authorization: `Bearer ${token}`,
              accept: options.accept ?? "application/vnd.github+json",
              "x-github-api-version": "2022-11-28",
              "user-agent": "kestrel-mcp",
              ...(options.body === undefined ? {} : { "content-type": "application/json" }),
            },
            body: options.body === undefined ? undefined : JSON.stringify(options.body),
            signal: AbortSignal.timeout(30_000),
          })
          const text = await response.text()
          return { status: response.status, text }
        },
        catch: () => new GitHubError({ message: "could not reach the GitHub API" }),
      })

    const call = (token: string, repo: RepoSlug, method: string, path: string, body?: unknown) =>
      send(token, method, path, { body }).pipe(
        Effect.flatMap(({ status, text }) => {
          if (status >= 200 && status < 300) {
            return Effect.try({
              try: () => (text === "" ? null : (JSON.parse(text) as unknown)),
              catch: () => new GitHubError({ message: "GitHub returned a non-JSON response" }),
            })
          }
          return Effect.fail(new GitHubError({ message: describeFailure(status, text, repo), status }))
        }),
      )

    /** A non-2xx answer described the way the GitHub CLI prints it. */
    const cliFailure = (status: number, text: string, path: string): GitHubError => {
      const url = `${apiBase}${path}`
      const message = githubMessage(text)
      const lines = message.split("\n")
      const described =
        lines.length > 1
          ? `HTTP ${status}: ${lines[0]} (${url})\n${lines.slice(1).join("\n")}`
          : message !== ""
            ? `HTTP ${status}: ${message} (${url})`
            : `HTTP ${status} (${url})`
      return new GitHubError({ message: described, status })
    }

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
      headRepo: pr.head.repo?.full_name ?? null,
      mergeable: pr.mergeable ?? null,
      mergeableState: pr.mergeable_state ?? "unknown",
    })

    const getPullRequest = (token: string, repo: RepoSlug, number: number) =>
      call(token, repo, "GET", `${repoPath(repo)}/pulls/${number}`).pipe(
        Effect.flatMap(decode(PullRequestBody, "pull request")),
        Effect.map(toPullRequest),
      )

    const referenceComments = (token: string, repo: RepoSlug, number: number) =>
      call(token, repo, "GET", `${repoPath(repo)}/issues/${number}/comments?per_page=100`).pipe(
        Effect.flatMap(decode(ReferenceCommentsBody, "issue comment list")),
        Effect.map((comments): ReadonlyArray<ReferenceComment> =>
          comments.map((comment) => ({
            author: comment.user?.login ?? "ghost",
            body: comment.body,
            url: comment.html_url,
            createdAt: comment.created_at,
          })),
        ),
      )

    const referenceNotFound = (repo: RepoSlug, number: number): GitHubError =>
      new GitHubError({
        message: `GitHub has no issue or pull request #${number} in ${repo.owner}/${repo.name} (it does not exist or the connected account cannot see it)`,
        status: 404,
      })

    /**
     * Reads the issue endpoint first: it is the one place that says whether a number is an issue or a pull request,
     * and it carries the body and author for both. A kind mismatch never falls through to the other endpoint.
     */
    const readReference = (token: string, repo: RepoSlug, number: number, kind: ReferenceKind) =>
      Effect.gen(function* () {
        const slug = `${repo.owner}/${repo.name}`
        const issue = yield* call(token, repo, "GET", `${repoPath(repo)}/issues/${number}`).pipe(
          Effect.flatMap(decode(IssueBody, "issue")),
          Effect.catchIf(
            (e) => e.status === 404,
            () => Effect.fail(referenceNotFound(repo, number)),
          ),
        )
        const isPullRequest = issue.pull_request !== undefined && issue.pull_request !== null
        const labels = issue.labels.map((label) => label.name)
        if (kind === "issue") {
          if (isPullRequest) {
            return yield* Effect.fail(
              new GitHubError({
                message: `#${number} in ${slug} is a pull request, not an issue; read it with kind "pr"`,
              }),
            )
          }
          const conversation = yield* referenceComments(token, repo, number)
          return {
            kind: "issue",
            number: issue.number,
            title: issue.title,
            body: issue.body ?? "",
            state: issue.state,
            stateReason: issue.state_reason ?? null,
            author: issue.user?.login ?? "ghost",
            url: issue.html_url,
            createdAt: issue.created_at,
            updatedAt: issue.updated_at,
            labels,
            conversation,
          } satisfies IssueReference
        }
        if (!isPullRequest) {
          return yield* Effect.fail(
            new GitHubError({
              message: `#${number} in ${slug} is an issue, not a pull request; read it with kind "issue"`,
            }),
          )
        }
        const [pr, reviews, reviewComments, conversation, files] = yield* Effect.all(
          [
            getPullRequest(token, repo, number),
            call(token, repo, "GET", `${repoPath(repo)}/pulls/${number}/reviews?per_page=100`).pipe(
              Effect.flatMap(decode(ReviewsBody, "review list")),
            ),
            call(token, repo, "GET", `${repoPath(repo)}/pulls/${number}/comments?sort=created&direction=desc&per_page=100`).pipe(
              Effect.flatMap(decode(ReviewCommentsBody, "review comment list")),
            ),
            referenceComments(token, repo, number),
            call(token, repo, "GET", `${repoPath(repo)}/pulls/${number}/files?per_page=100`).pipe(
              Effect.flatMap(decode(PullFilesBody, "pull request file list")),
            ),
          ],
          { concurrency: "unbounded" },
        )
        const checks = yield* call(token, repo, "GET", `${repoPath(repo)}/commits/${pr.headSha}/check-runs?per_page=100`).pipe(
          Effect.flatMap(decode(CheckRunsBody, "check run list")),
          Effect.map(summarizeChecks),
          // The body and conversation must stay readable even when this optional enrichment is not.
          Effect.catchAll(() => Effect.succeed(null)),
        )
        return {
          kind: "pr",
          number: pr.number,
          title: pr.title,
          body: issue.body ?? "",
          state: pr.state,
          draft: pr.draft,
          author: issue.user?.login ?? "ghost",
          url: pr.url,
          createdAt: issue.created_at,
          updatedAt: issue.updated_at,
          labels,
          baseRef: pr.baseRef,
          headRef: pr.headRef,
          headSha: pr.headSha,
          mergeable: pr.mergeable,
          mergeableState: pr.mergeableState,
          reviewDecision: reviewDecisionOf(
            reviews.map((review) => ({ state: review.state, login: review.user?.login ?? "ghost" })),
          ),
          checks,
          reviews: reviews.map(
            (review): ReferenceReview => ({
              author: review.user?.login ?? "ghost",
              state: review.state,
              body: review.body ?? "",
              url: review.html_url ?? "",
            }),
          ),
          reviewComments: reviewComments.map(
            (comment): ReferenceReviewComment => ({
              path: comment.path,
              line: comment.line ?? null,
              author: comment.user?.login ?? "ghost",
              body: comment.body,
              url: comment.html_url,
            }),
          ),
          conversation,
          files: files.map(
            (file): ReferenceFile => ({
              path: file.filename,
              status: file.status,
              additions: file.additions,
              deletions: file.deletions,
            }),
          ),
        } satisfies PullRequestReference
      })

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

    const apiRoot = new URL(`${apiBase}/`)

    /** Only the API itself ever gets the token: same origin, under the API's path, no credentials in the URL. */
    const onApi = (url: URL): boolean =>
      url.origin === apiRoot.origin && url.username === "" && url.password === "" && url.pathname.startsWith(apiRoot.pathname)

    /** The URL `gh api` means by its endpoint argument (`ghinstance.RESTPrefix`/`GraphQLEndpoint`), or null off the API. */
    const apiUrl = (path: string): URL | null => {
      let url: URL
      try {
        url = new URL(path.includes("://") ? path : path === "graphql" ? `${apiBase}/graphql` : `${apiBase}/${path.replace(/^\//, "")}`)
      } catch {
        return null
      }
      return onApi(url) ? url : null
    }

    /**
     * Sends the request. A read follows redirects as Go's client does, a hop off the API without the token; a write
     * goes only to the URL the policy checked.
     */
    const exchange = async (token: string, request: ApiRequest, first: URL): Promise<ApiResponse> => {
      let url = first
      let method = request.method.toUpperCase()
      let body = request.body
      const follows = method === "GET" || method === "HEAD"
      for (let hop = 0; ; hop++) {
        const headers = new Headers()
        for (const [name, value] of request.headers) {
          if (!AGENT_DROPPED_HEADERS[name.toLowerCase()]) headers.append(name, value)
        }
        if (onApi(url)) headers.set("authorization", `Bearer ${token}`)
        if (!headers.has("user-agent")) headers.set("user-agent", "kestrel-gh")
        // Go's client asks for gzip only and decodes it itself, dropping the encoding headers it consumed.
        if (!headers.has("accept-encoding")) headers.set("accept-encoding", "gzip")
        const response = await fetch(url, { method, headers, body: body ?? undefined, redirect: "manual", signal: AbortSignal.timeout(30_000) })
        const location = response.headers.get("location")
        if (follows && REDIRECT_STATUSES[response.status] && location !== null && hop < 10) {
          await response.body?.cancel()
          url = new URL(location, url)
          if (response.status === 303 || (method === "POST" && (response.status === 301 || response.status === 302))) {
            method = "GET"
            body = null
          }
          continue
        }
        const decoded = response.headers.get("content-encoding") === "gzip"
        const received = [...response.headers].filter(([name]) => !decoded || (name !== "content-encoding" && name !== "content-length"))
        return { status: response.status, headers: received, body: method === "HEAD" ? "" : await response.text() }
      }
    }

    /** Fails unless every review thread belongs to one of `repos`. */
    const checkThreads = (token: string, threads: ReadonlyArray<string>, repos: ReadonlyArray<RepoSlug>) =>
      send(token, "POST", "/graphql", {
        body: {
          query: "query($ids: [ID!]!) { nodes(ids: $ids) { ... on PullRequestReviewThread { repository { nameWithOwner } } } }",
          variables: { ids: threads },
        },
      }).pipe(
        Effect.flatMap(({ status, text }) => {
          if (status < 200 || status >= 300) return Effect.fail(cliFailure(status, text, "/graphql"))
          return Effect.try({
            try: () => JSON.parse(text) as unknown,
            catch: () => new GitHubError({ message: "GitHub returned a non-JSON response" }),
          }).pipe(Effect.flatMap(decode(ThreadReposAnswer, "review thread")))
        }),
        Effect.flatMap((answer) => {
          const found = answer.data?.nodes ?? []
          const outside = threads.find((_, i) => {
            const slug = found[i]?.repository?.nameWithOwner.toLowerCase()
            return !repos.some((repo) => `${repo.owner}/${repo.name}`.toLowerCase() === slug)
          })
          return outside === undefined
            ? Effect.void
            : Effect.fail(new GitHubError({ message: `review thread ${outside} is not in a repository checked out in this thread; gh api writes only to the thread's checkouts` }))
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
              Effect.map((checks): PullRequestStatus => ({
                  ...pr,
                  reviewDecision: reviewDecisionOf(
                    reviews.map((review) => ({ state: review.state, login: review.user?.login ?? "ghost" })),
                  ),
                  checks: summarizeChecks(checks),
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
                })),
            ),
          ),
        ),
      readReference,
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
      graphql: (token, query, variables) =>
        send(token, "POST", "/graphql", { body: { query, variables } }).pipe(
          Effect.flatMap(({ status, text }) => {
            if (status < 200 || status >= 300) return Effect.fail(cliFailure(status, text, "/graphql"))
            return Effect.try({
              try: () => JSON.parse(text) as unknown,
              catch: () => new GitHubError({ message: "GitHub returned a non-JSON response" }),
            }).pipe(Effect.flatMap(decode(GraphQLAnswer, "GraphQL")))
          }),
          Effect.map((answer): GraphQLResponse => ({
            data: answer.data ?? null,
            errors: (answer.errors ?? []).map((e) => ({
              message: e.message,
              ...(e.path === undefined ? {} : { path: e.path }),
              ...(e.type === undefined ? {} : { type: e.type }),
            })),
          })),
        ),
      pullRequestDiff: (token, repo, number, format) => {
        const path = `${repoPath(repo)}/pulls/${number}`
        return send(token, "GET", path, { accept: `application/vnd.github.v3.${format}` }).pipe(
          Effect.flatMap(({ status, text }) => (status === 200 ? Effect.succeed(text) : Effect.fail(cliFailure(status, text, path)))),
        )
      },
      api: (token, request, repos) =>
        Effect.gen(function* () {
          const url = apiUrl(request.path)
          if (url === null) {
            return yield* Effect.fail(new GitHubError({ message: `gh api in Kestrel only calls the GitHub API (${apiBase}), not ${request.path}` }))
          }
          const decision = apiDecision({ method: request.method, url, apiRoot, headers: request.headers, body: request.body }, repos)
          if ("refusal" in decision) return yield* Effect.fail(new GitHubError({ message: decision.refusal }))
          if (decision.threads.length > 0) yield* checkThreads(token, decision.threads, repos)
          return yield* Effect.tryPromise({
            try: () => exchange(token, request, url),
            catch: () => new GitHubError({ message: "could not reach the GitHub API" }),
          })
        }),
    }
    return service
  }),
)

/** The `message` of a GitHub error body, or "" when there is none. */
const githubMessage = (text: string): string => {
  try {
    const parsed = JSON.parse(text) as { message?: unknown }
    return typeof parsed.message === "string" ? parsed.message : ""
  } catch {
    return ""
  }
}

const describeFailure = (status: number, text: string, repo: RepoSlug): string => {
  const slug = `${repo.owner}/${repo.name}`
  const detail = githubMessage(text)
  if (status === 401) return "GitHub rejected the connected token (expired or revoked): reconnect GitHub and retry"
  if (status === 403) return `GitHub denied access to ${slug} (the connected account lacks permission): ${detail}`.trimEnd()
  if (status === 404) return `GitHub repository ${slug} not found or not visible to the connected account`
  return `GitHub API ${status}${detail ? `: ${detail}` : ""}`
}
