import { Kind, parse, valueFromASTUntyped, type DocumentNode } from "graphql"
import type { RepoSlug } from "./api"

/**
 * What an agent's `gh api` may send with the thread owner's token. Reads go anywhere on the API: REST GET and HEAD
 * without a body, and GraphQL queries. Writes are an allowlist, each on a repository checked out in the thread:
 * issues (create, edit, comment, labels), replies to review comments, resolving review threads, and re-running
 * Actions runs and jobs. Everything else (merging, approving, contents, refs, settings) stays with the `github_*`
 * tools or is not offered at all.
 */

/** Headers an agent's request cannot set: they would change the method GitHub runs. */
const METHOD_OVERRIDES: Record<string, true> = { "x-http-method-override": true, "x-http-method": true, "x-method-override": true }

export const ALLOWED_WRITES =
  "issues (create, edit, comment, add or remove labels), replies to pull request review comments, resolving review threads, and re-running Actions runs and jobs"

const WRITE_REFUSAL = `gh api in Kestrel sends reads, and writes only for ${ALLOWED_WRITES} in this thread's checkouts; use the github_* tools for other changes`

/** `refusal`: why the request is not sent. `threads`: review threads a mutation resolves, to check before sending. */
export type ApiDecision = { readonly refusal: string } | { readonly threads: ReadonlyArray<string> }

export interface PolicyRequest {
  readonly method: string
  /** The request URL, already known to be on the API. */
  readonly url: URL
  /** The API's root URL (`githubApiUrl` plus "/"). */
  readonly apiRoot: URL
  readonly headers: ReadonlyArray<readonly [string, string]>
  readonly body: string | null
}

type BodyRule = "none" | "fields" | "labels"

/** A REST write: `:repo` covers owner and name, `:id` a number, `:name` any one segment. */
interface WriteRoute {
  readonly method: string
  readonly path: ReadonlyArray<string>
  readonly body: BodyRule
  /** Allowed top-level body keys for `fields`. */
  readonly fields?: Record<string, true>
}

const WRITE_ROUTES: ReadonlyArray<WriteRoute> = [
  { method: "POST", path: [":repo", "issues"], body: "fields", fields: { title: true, body: true, labels: true } },
  { method: "PATCH", path: [":repo", "issues", ":id"], body: "fields", fields: { title: true, body: true, state: true, state_reason: true, labels: true } },
  { method: "POST", path: [":repo", "issues", ":id", "comments"], body: "fields", fields: { body: true } },
  { method: "POST", path: [":repo", "issues", ":id", "labels"], body: "labels" },
  { method: "DELETE", path: [":repo", "issues", ":id", "labels", ":name"], body: "none" },
  { method: "POST", path: [":repo", "pulls", ":id", "comments", ":id", "replies"], body: "fields", fields: { body: true } },
  { method: "POST", path: [":repo", "actions", "runs", ":id", "rerun"], body: "fields", fields: { enable_debug_logging: true } },
  { method: "POST", path: [":repo", "actions", "runs", ":id", "rerun-failed-jobs"], body: "fields", fields: { enable_debug_logging: true } },
  { method: "POST", path: [":repo", "actions", "jobs", ":id", "rerun"], body: "fields", fields: { enable_debug_logging: true } },
]

/** GraphQL mutations allowed, each taking `input: { threadId }` of a review thread in a checkout's repository. */
const THREAD_MUTATIONS: Record<string, true> = { resolveReviewThread: true, unresolveReviewThread: true }

const parseJson = (text: string): unknown => {
  try {
    return JSON.parse(text)
  } catch {
    return undefined
  }
}

const isObject = (value: unknown): value is object => value !== null && typeof value === "object" && !Array.isArray(value)

const isStringArray = (value: unknown): boolean => Array.isArray(value) && value.every((entry) => typeof entry === "string")

const sameRepo = (repo: RepoSlug, owner: string, name: string): boolean =>
  repo.owner.toLowerCase() === owner.toLowerCase() && repo.name.toLowerCase() === name.toLowerCase()

/** A path segment decoded; a malformed escape stays as written, which then matches no repository. */
const decodeSegment = (segment: string): string => {
  try {
    return decodeURIComponent(segment)
  } catch {
    return segment
  }
}

/** Whether `gh api` sends the request, and the review threads to check first. */
export const apiDecision = (request: PolicyRequest, repos: ReadonlyArray<RepoSlug>): ApiDecision => {
  for (const [name] of request.headers) {
    if (METHOD_OVERRIDES[name.toLowerCase()]) return { refusal: `the ${name} header is not available in Kestrel's gh api` }
  }
  const verb = request.method.toUpperCase()
  const segments = request.url.pathname.slice(request.apiRoot.pathname.length).split("/")
  if (verb === "GET" || verb === "HEAD") {
    return request.body === null ? { threads: [] } : { refusal: `gh api in Kestrel sends ${verb} requests without a body` }
  }
  if (verb === "POST" && segments.length === 1 && segments[0] === "graphql") return graphqlDecision(request.body, repos)
  return restWriteDecision(verb, segments, request, repos)
}

const restWriteDecision = (verb: string, segments: ReadonlyArray<string>, request: PolicyRequest, repos: ReadonlyArray<RepoSlug>): ApiDecision => {
  const path = segments.join("/")
  const refused = { refusal: `${verb} ${path} is not sent: ${WRITE_REFUSAL}` }
  if (segments[0] !== "repos" || segments.length < 3) return refused
  const [owner, name] = [decodeSegment(segments[1] as string), decodeSegment(segments[2] as string)]
  const rest = segments.slice(3)
  const route = WRITE_ROUTES.find(
    (r) =>
      r.method === verb &&
      r.path.length - 1 === rest.length &&
      r.path.slice(1).every((part, i) => {
        const segment = rest[i] as string
        if (part === ":id") return /^\d+$/.test(segment)
        if (part === ":name") return segment !== ""
        return part === segment
      }),
  )
  if (route === undefined) return refused
  if (!repos.some((repo) => sameRepo(repo, owner, name))) {
    return { refusal: `${verb} ${path} is not sent: ${owner}/${name} is not checked out in this thread; gh api writes only to the thread's checkouts` }
  }
  if (request.url.search !== "") return { refusal: `${verb} ${path} is not sent: writes take their parameters in the body, not the query string` }
  for (const [header, value] of request.headers) {
    if (header.toLowerCase() === "content-type" && !/[/+]json(;|$)/.test(value)) {
      return { refusal: `${verb} ${path} is not sent: write bodies must be JSON` }
    }
  }
  return bodyDecision(route, request.body, `${verb} ${path}`)
}

const bodyDecision = (route: WriteRoute, body: string | null, label: string): ApiDecision => {
  if (body === null) return route.body === "labels" ? { refusal: `${label} needs labels (-f 'labels[]=name')` } : { threads: [] }
  if (route.body === "none") return { refusal: `${label} takes no body` }
  const value = parseJson(body)
  if (route.body === "labels") {
    const labels = isObject(value) && "labels" in value && Object.keys(value).length === 1 ? value.labels : value
    return isStringArray(labels) ? { threads: [] } : { refusal: `${label} takes only label names (-f 'labels[]=name')` }
  }
  if (!isObject(value)) return { refusal: `${label} takes a JSON object` }
  const extra = Object.keys(value).filter((key) => !route.fields?.[key])
  if (extra.length > 0) {
    return { refusal: `${label} is not sent: ${extra.join(", ")} cannot be set from a thread (allowed: ${Object.keys(route.fields ?? {}).join(", ")})` }
  }
  if ("labels" in value && !isStringArray(value.labels)) return { refusal: `${label} takes labels as names` }
  return { threads: [] }
}

/**
 * GraphQL: one JSON object with a query. Queries are reads; a mutation may only select `resolveReviewThread` and
 * `unresolveReviewThread`, whose thread ids (literal or from variables) the caller checks before sending.
 */
const graphqlDecision = (body: string | null, repos: ReadonlyArray<RepoSlug>): ApiDecision => {
  const request = body === null ? undefined : parseJson(body)
  if (!isObject(request)) return { refusal: "gh api in Kestrel sends GraphQL requests only as a JSON object with a query" }
  const query = "query" in request ? request.query : undefined
  if (typeof query !== "string") return { refusal: "gh api graphql needs a query (-f query=...)" }
  const rawVariables = "variables" in request ? request.variables : undefined
  if (rawVariables !== undefined && rawVariables !== null && !isObject(rawVariables)) return { refusal: "GraphQL variables must be a JSON object" }
  const variables = isObject(rawVariables) ? Object.fromEntries(Object.entries(rawVariables)) : undefined
  let document: DocumentNode
  try {
    document = parse(query)
  } catch (error) {
    return { refusal: `gh api in Kestrel could not parse the GraphQL query: ${error instanceof Error ? error.message : String(error)}` }
  }
  const threads: string[] = []
  for (const definition of document.definitions) {
    if (definition.kind !== Kind.OPERATION_DEFINITION || definition.operation === "query") continue
    if (definition.operation !== "mutation") return { refusal: `GraphQL ${definition.operation}s are not sent: ${WRITE_REFUSAL}` }
    if (repos.length === 0) return { refusal: `GraphQL mutations are not sent: this thread has no GitHub checkout` }
    for (const selection of definition.selectionSet.selections) {
      if (selection.kind !== Kind.FIELD || !THREAD_MUTATIONS[selection.name.value]) {
        const name = selection.kind === Kind.FIELD ? selection.name.value : "a fragment"
        return { refusal: `GraphQL mutation ${name} is not sent: ${WRITE_REFUSAL}` }
      }
      const input = selection.arguments?.find((argument) => argument.name.value === "input")
      const value: unknown = input === undefined ? undefined : valueFromASTUntyped(input.value, variables)
      const threadId = isObject(value) && "threadId" in value ? value.threadId : undefined
      if (typeof threadId !== "string") return { refusal: `GraphQL mutation ${selection.name.value} needs input.threadId` }
      threads.push(threadId)
    }
  }
  return { threads }
}
