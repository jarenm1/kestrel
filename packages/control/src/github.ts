import { Either, Schema } from "effect"
import type { AutomationTrigger } from "@cloudagents/protocol"
import { UpstreamError, safeEqual } from "./http"

/**
 * GitHub integration for the control plane: repository webhooks (signature check, payload decoding, trigger
 * matching) and the REST calls that create, check, and delete them. Tokens are passed per call, never stored or
 * logged; errors carry GitHub's status and message only.
 */

const API = "https://api.github.com"

export type GithubTrigger = Extract<AutomationTrigger, { _tag: "github" }>

const PullRequestJson = Schema.Struct({
  number: Schema.Number,
  title: Schema.String,
  html_url: Schema.String,
  draft: Schema.Boolean,
  user: Schema.Struct({ login: Schema.String }),
  head: Schema.Struct({ ref: Schema.String }),
  base: Schema.Struct({ ref: Schema.String }),
})

/** `pull_request` webhook delivery (only the fields automations use). */
export const PullRequestWebhook = Schema.Struct({
  action: Schema.String,
  number: Schema.Number,
  pull_request: PullRequestJson,
  repository: Schema.Struct({ full_name: Schema.String }),
  requested_reviewer: Schema.optional(Schema.NullOr(Schema.Struct({ login: Schema.String }))),
})

const HookJson = Schema.Struct({ id: Schema.Number })
const RepositoryJson = Schema.Struct({ full_name: Schema.String })

export interface PullRequestInfo {
  readonly number: number
  readonly title: string
  readonly url: string
  readonly draft: boolean
  readonly author: string
  readonly headRef: string
  readonly baseRef: string
}

/** A pull request event, reduced to what trigger matching and the task prompt need. */
export interface PullRequestEvent {
  /** Webhook action, e.g. "opened" or "review_requested". */
  readonly action: string
  /** GitHub "owner/name" as sent by GitHub. */
  readonly repo: string
  readonly pr: PullRequestInfo
  /** Login of the user whose review was requested; null for team requests or other actions. */
  readonly requestedReviewer: string | null
}

const toPullRequestInfo = (pr: typeof PullRequestJson.Type): PullRequestInfo => ({
  number: pr.number,
  title: pr.title,
  url: pr.html_url,
  draft: pr.draft,
  author: pr.user.login,
  headRef: pr.head.ref,
  baseRef: pr.base.ref,
})

export const pullRequestEventOf = (hook: typeof PullRequestWebhook.Type): PullRequestEvent => ({
  action: hook.action,
  repo: hook.repository.full_name,
  pr: toPullRequestInfo(hook.pull_request),
  requestedReviewer: hook.requested_reviewer?.login ?? null,
})

/**
 * Reason string when `event` should start `trigger`, or null. Filters: the event must be listed; for
 * review_requested with reviewers set, the requested login must be one of them (case-insensitive); with
 * baseBranches set, the PR must target one of them; drafts only when includeDrafts is true.
 */
export const matchGithubTrigger = (trigger: GithubTrigger, event: PullRequestEvent): string | null => {
  const name = `pull_request.${event.action}`
  if (!(trigger.events as readonly string[]).includes(name)) return null
  if (name === "pull_request.review_requested" && trigger.reviewers !== undefined && trigger.reviewers.length > 0) {
    const wanted = trigger.reviewers.map((login) => login.toLowerCase())
    if (event.requestedReviewer === null || !wanted.includes(event.requestedReviewer.toLowerCase())) return null
  }
  if (trigger.baseBranches !== undefined && trigger.baseBranches.length > 0) {
    if (!trigger.baseBranches.includes(event.pr.baseRef)) return null
  }
  if (event.pr.draft && trigger.includeDrafts !== true) return null
  return `${name} #${event.pr.number}`
}

/** Checks `X-Hub-Signature-256` (`sha256=<hex HMAC-SHA256 of the raw body>`) in constant time. */
export const verifyGithubSignature = async (secret: string, body: string, header: string | null): Promise<boolean> => {
  if (header === null || !header.startsWith("sha256=")) return false
  const encoder = new TextEncoder()
  const key = await crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, [
    "sign",
  ])
  const mac = await crypto.subtle.sign("HMAC", key, encoder.encode(body))
  const expected = [...new Uint8Array(mac)].map((byte) => byte.toString(16).padStart(2, "0")).join("")
  return safeEqual(expected, header.slice("sha256=".length))
}

const github = (token: string, method: "GET" | "POST" | "DELETE", path: string, body?: unknown): Promise<Response> =>
  fetch(`${API}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      accept: "application/vnd.github+json",
      "x-github-api-version": "2022-11-28",
      "user-agent": "kestrel-control-plane",
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  })

const failure = async (res: Response, what: string): Promise<UpstreamError> => {
  const body: unknown = await res.json().catch(() => null)
  const message =
    typeof body === "object" && body !== null && "message" in body && typeof body.message === "string"
      ? body.message
      : res.statusText
  return new UpstreamError(`GitHub ${what} responded ${res.status}: ${message}`)
}

const decode = <A, I>(schema: Schema.Schema<A, I>, body: unknown, what: string): A => {
  const result = Schema.decodeUnknownEither(schema)(body)
  if (Either.isLeft(result)) throw new UpstreamError(`GitHub ${what} returned an unexpected body`)
  return result.right
}

/** Creates a `pull_request` webhook on `slug` pointing at `url`, signed with `secret`. Returns the hook id. */
export const createPullRequestHook = async (token: string, slug: string, url: string, secret: string): Promise<number> => {
  const what = `create webhook on ${slug}`
  const res = await github(token, "POST", `/repos/${slug}/hooks`, {
    name: "web",
    active: true,
    events: ["pull_request"],
    config: { url, content_type: "json", secret, insecure_ssl: "0" },
  })
  if (!res.ok) throw await failure(res, what)
  return decode(HookJson, await res.json(), what).id
}

/** True when the hook still exists on GitHub. */
export const pullRequestHookExists = async (token: string, slug: string, hookId: number): Promise<boolean> => {
  const res = await github(token, "GET", `/repos/${slug}/hooks/${hookId}`)
  if (res.status === 404) return false
  if (!res.ok) throw await failure(res, `read webhook on ${slug}`)
  return true
}

/** Deletes the hook; an already-missing hook counts as deleted. */
export const deletePullRequestHook = async (token: string, slug: string, hookId: number): Promise<void> => {
  const res = await github(token, "DELETE", `/repos/${slug}/hooks/${hookId}`)
  if (res.status === 404) return
  if (!res.ok) throw await failure(res, `delete webhook on ${slug}`)
}

/** The pull request, or null when GitHub has no such PR. */
export const fetchPullRequest = async (token: string, slug: string, number: number): Promise<PullRequestInfo | null> => {
  const what = `pull request ${slug}#${number}`
  const res = await github(token, "GET", `/repos/${slug}/pulls/${number}`)
  if (res.status === 404) return null
  if (!res.ok) throw await failure(res, what)
  return toPullRequestInfo(decode(PullRequestJson, await res.json(), what))
}

/** The repository's canonical `owner/name` as GitHub spells it, or null when GitHub has no such repository. */
export const fetchRepository = async (token: string, slug: string): Promise<string | null> => {
  const what = `repository ${slug}`
  const res = await github(token, "GET", `/repos/${slug}`)
  if (res.status === 404) return null
  if (!res.ok) throw await failure(res, what)
  return decode(RepositoryJson, await res.json(), what).full_name
}
