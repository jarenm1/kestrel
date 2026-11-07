import { Schema } from "effect"
import { UpstreamError } from "./http"

const User = Schema.NullOr(Schema.Struct({ login: Schema.String, avatar_url: Schema.String }))
const Pull = Schema.Struct({
  number: Schema.Number, title: Schema.String, body: Schema.NullOr(Schema.String), state: Schema.String,
  draft: Schema.Boolean, merged: Schema.Boolean, user: User,
  head: Schema.Struct({ ref: Schema.String, sha: Schema.String }), base: Schema.Struct({ ref: Schema.String }),
  requested_reviewers: Schema.Array(User),
  requested_teams: Schema.Array(Schema.Struct({ slug: Schema.String, name: Schema.String })),
})
const Comment = Schema.Struct({ id: Schema.Number, body: Schema.String, user: User, created_at: Schema.String, updated_at: Schema.String })
const InlineComment = Schema.Struct({ id: Schema.Number, path: Schema.String, line: Schema.NullOr(Schema.Number), original_line: Schema.NullOr(Schema.Number), body: Schema.String, user: User, created_at: Schema.String, html_url: Schema.String })
const Review = Schema.Struct({ id: Schema.Number, body: Schema.NullOr(Schema.String), user: User, state: Schema.String, submitted_at: Schema.NullOr(Schema.String) })
const Commit = Schema.Struct({ author: User })
const Check = Schema.Struct({ name: Schema.String, status: Schema.String, conclusion: Schema.NullOr(Schema.String), html_url: Schema.NullOr(Schema.String) })
const Status = Schema.Struct({ state: Schema.String, statuses: Schema.Array(Schema.Struct({ context: Schema.String, state: Schema.String, target_url: Schema.NullOr(Schema.String), description: Schema.NullOr(Schema.String) })) })
const MAX_PAGES = 10

const user = (u: typeof User.Type) => u === null ? null : ({ login: u.login, avatarUrl: u.avatar_url })

/** Fetches only constructed api.github.com URLs; never follows a GitHub-supplied pagination URL. */
export const pullRequestDetail = async (token: string, repo: string, number: number) => {
  const root = `https://api.github.com/repos/${repo}`
  const get = async <A, I>(path: string, schema: Schema.Schema<A, I>): Promise<A | null> => {
    let res: Response
    try {
      res = await fetch(`${root}${path}`, { redirect: "error", headers: {
        authorization: `Bearer ${token}`, accept: "application/vnd.github+json",
        "x-github-api-version": "2022-11-28", "user-agent": "kestrel-control-plane",
      } })
    } catch { throw new UpstreamError("GitHub request failed") }
    if (res.status === 404) return null
    if (!res.ok) throw new UpstreamError(`GitHub responded ${res.status}`)
    try {
      const decoded = Schema.decodeUnknownEither(schema)(await res.json())
      if (decoded._tag === "Right") return decoded.right
    } catch { /* Invalid JSON is an upstream failure. */ }
    throw new UpstreamError("GitHub returned an unexpected response")
  }
  const required = async <A, I>(path: string, schema: Schema.Schema<A, I>): Promise<A> => {
    const result = await get(path, schema)
    if (result === null) throw new UpstreamError("GitHub resource became unavailable")
    return result
  }
  const pages = async <A, I>(path: string, item: Schema.Schema<A, I>) => {
    const items: A[] = []
    for (let page = 1; page <= MAX_PAGES; page++) {
      const batch = await required(`${path}?per_page=100&page=${page}`, Schema.Array(item))
      items.push(...batch)
      if (batch.length < 100) return { items, truncated: false }
    }
    return { items, truncated: true }
  }
  const pull = await get(`/pulls/${number}`, Pull)
  if (pull === null) return null
  if (!/^[0-9a-f]{40}$/i.test(pull.head.sha)) throw new UpstreamError("GitHub returned an invalid commit SHA")
  const [comments, inlineComments, diff, reviews, commits, checks, status] = await Promise.all([
    pages(`/issues/${number}/comments`, Comment), pages(`/pulls/${number}/comments`, InlineComment),
    // GitHub returns the unified diff when requested with this media type.
    (async () => {
      let res: Response
      try {
        res = await fetch(`${root}/pulls/${number}`, { redirect: "error", headers: {
          authorization: `Bearer ${token}`, accept: "application/vnd.github.v3.diff",
          "x-github-api-version": "2022-11-28", "user-agent": "kestrel-control-plane",
        } })
      } catch { throw new UpstreamError("GitHub request failed") }
      if (!res.ok) throw new UpstreamError(`GitHub responded ${res.status}`)
      try { return await res.text() } catch { throw new UpstreamError("GitHub returned an unexpected response") }
    })(),
    pages(`/pulls/${number}/reviews`, Review), pages(`/pulls/${number}/commits`, Commit),
    (async () => {
      const items: (typeof Check.Type)[] = []
      for (let page = 1; page <= MAX_PAGES; page++) {
        const result = await required(`/commits/${pull.head.sha}/check-runs?per_page=100&page=${page}`, Schema.Struct({ check_runs: Schema.Array(Check), total_count: Schema.Number }))
        items.push(...result.check_runs)
        if (items.length >= result.total_count || result.check_runs.length === 0) return { items, truncated: items.length < result.total_count }
      }
      return { items, truncated: true }
    })(),
    required(`/commits/${pull.head.sha}/status?per_page=100`, Status),
  ])
  const contributors = [...new Map(commits.items.flatMap((c) => c.author ? [[c.author.login.toLowerCase(), user(c.author)] as const] : [])).values()]
  return {
    number: pull.number, title: pull.title, body: pull.body, state: pull.merged ? "merged" : pull.state,
    draft: pull.draft, author: user(pull.user), head: { ref: pull.head.ref, sha: pull.head.sha }, base: { ref: pull.base.ref },
    comments: comments.items.map((c) => ({ id: c.id, body: c.body, author: user(c.user), createdAt: c.created_at, updatedAt: c.updated_at })),
    diff,
    inlineComments: inlineComments.items.map((c) => ({ id: c.id, path: c.path, line: c.line, originalLine: c.original_line, author: user(c.user), body: c.body, createdAt: c.created_at, url: c.html_url })),
    contributors, requestedReviewers: pull.requested_reviewers.map(user), requestedTeams: pull.requested_teams,
    reviews: reviews.items.map((r) => ({ id: r.id, body: r.body, author: user(r.user), state: r.state, submittedAt: r.submitted_at })),
    checks: { runs: checks.items.map((c) => ({ name: c.name, status: c.status, conclusion: c.conclusion, url: c.html_url })),
      status: status.state, statuses: status.statuses.map((s) => ({ context: s.context, state: s.state, url: s.target_url, description: s.description })) },
    truncated: { comments: comments.truncated, inlineComments: inlineComments.truncated, reviews: reviews.truncated, contributors: commits.truncated, checks: checks.truncated, statuses: status.statuses.length >= 100 },
  }
}
