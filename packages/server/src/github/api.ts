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
  readonly url: string
  readonly title: string
  readonly state: "open" | "closed" | "merged"
  readonly draft: boolean
  readonly headSha: string
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
}

export interface NewPullRequest {
  readonly title: string
  readonly body: string
  readonly head: string
  readonly base: string
  readonly draft: boolean
}

export interface GitHubShape {
  /** Open pull request whose head branch is `head` in `repo`, or null. */
  readonly findOpenPullRequest: (token: string, repo: RepoSlug, head: string) => Effect.Effect<PullRequest | null, GitHubError>
  readonly createPullRequest: (token: string, repo: RepoSlug, input: NewPullRequest) => Effect.Effect<PullRequest, GitHubError>
  readonly getPullRequestStatus: (token: string, repo: RepoSlug, number: number) => Effect.Effect<PullRequestStatus, GitHubError>
}

export class GitHub extends Context.Tag("cloudagents/GitHub")<GitHub, GitHubShape>() {}

const PullRequestBody = Schema.Struct({
  number: Schema.Number,
  html_url: Schema.String,
  title: Schema.String,
  state: Schema.String,
  merged: Schema.Boolean,
  draft: Schema.Boolean,
  mergeable: Schema.optional(Schema.NullOr(Schema.Boolean)),
  mergeable_state: Schema.optional(Schema.String),
  head: Schema.Struct({ sha: Schema.String }),
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
    user: Schema.NullOr(Schema.Struct({ login: Schema.String })),
  }),
)

const ReviewCommentsBody = Schema.Array(
  Schema.Struct({
    path: Schema.String,
    line: Schema.optional(Schema.NullOr(Schema.Number)),
    body: Schema.String,
    html_url: Schema.String,
    user: Schema.NullOr(Schema.Struct({ login: Schema.String })),
  }),
)

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
      url: pr.html_url,
      title: pr.title,
      state: pr.merged ? "merged" : pr.state === "open" ? "open" : "closed",
      draft: pr.draft,
      headSha: pr.head.sha,
      mergeable: pr.mergeable ?? null,
      mergeableState: pr.mergeable_state ?? "unknown",
    })

    const getPullRequest = (token: string, repo: RepoSlug, number: number) =>
      call(token, repo, "GET", `${repoPath(repo)}/pulls/${number}`).pipe(
        Effect.flatMap(decode(PullRequestBody, "pull request")),
        Effect.map(toPullRequest),
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
          ],
          { concurrency: "unbounded" },
        ).pipe(
          Effect.flatMap(([pr, reviews, comments]) =>
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
