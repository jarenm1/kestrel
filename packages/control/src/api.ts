import { Schema } from "effect"
import {
  ApprovePairingBody,
  BOX_TOKEN_QUERY,
  CREDENTIALS_HEADER,
  CliAuthStatus,
  CliProvider,
  ControlPaths,
  CreateBoxBody,
  CreateNestBoxBody,
  NestLimits,
  CreateFleetBoxBody,
  CreateMeterHostBody,
  GithubRepoSlug,
  MeterReportBody,
  Paths,
  PreviewSession,
  PutApiKeyBody,
  SetActiveBoxBody,
  Task,
  UpdateBoxBody,
  UpdateFleetBoxBody,
  WaitlistSignupBody,
  type Connection,
  type GithubRepo,
  type Me,
} from "@cloudagents/protocol"
import {
  PROVIDERS,
  findProvider,
  isAvailable,
  type ApiKeyProvider,
  type CliProvider as CliConnectionProvider,
  type OAuthProvider,
  type Provider,
} from "./providers"
import { UpstreamError, cappedRequest, decodeBody, errorResponse, json, maskKey, readCookie } from "./http"
import { FILE_TOKEN_HEADER, SESSION_HEADER, hub, isOperator, type Env } from "./env"
import { SESSION_COOKIE, currentSession } from "./auth"
import { desktopStreamTask } from "./desktop-tokens"
import { isBoxFilePath } from "./file-tokens"
import { handleAutomations } from "./automations"
import type { BoxOutcome } from "./hub"
import { DEFAULT_TOOL_FAILURE_DAYS, TOOL_FAILURE_RETENTION_DAYS } from "./tool-failures-table"

type ConnectionRow = { provider: string; account: string | null }

const storedView = (
  provider: OAuthProvider | ApiKeyProvider,
  row: ConnectionRow | undefined,
  env: Env,
  expired: boolean,
): Connection => ({
  provider: provider.id,
  label: provider.label,
  kind: provider.kind,
  connected: row !== undefined,
  account: row?.account ?? null,
  available: isAvailable(provider, env),
  ...(expired ? { expired: true } : {}),
  ...(provider.kind === "apikey" && provider.hint !== undefined ? { hint: provider.hint } : {}),
})

const cliView = (provider: CliConnectionProvider, status: CliAuthStatus | undefined): Connection => ({
  provider: provider.id,
  label: provider.label,
  kind: provider.kind,
  connected: status?.loggedIn ?? false,
  account: status?.loggedIn ? status.account : null,
  accounts: status?.accounts,
  activeAccountId: status?.activeAccountId,
  available: status !== undefined && status.error === undefined,
  ...(status?.error === undefined ? {} : { error: status.error }),
})

/** A box GET's JSON body, or null when the box is offline, too old for the route, or answers badly. */
const boxJson = async (login: string, env: Env, path: string): Promise<unknown> => {
  const res = await hub(env).boxCall(login, "GET", path)
  if (!res.ok) return null
  try {
    return JSON.parse(res.body) as unknown
  } catch {
    return null
  }
}

/** Preserve the installed clients' CLI-login response, including offline/older-box handling. */
const fetchCliAuth = async (login: string, env: Env): Promise<readonly CliAuthStatus[]> => {
  const body = await boxJson(login, env, ControlPaths.cliAuthFor(CliProvider.literals))
  return Schema.is(Schema.Array(CliAuthStatus))(body) ? body : []
}

/** True when the user has connected `provider` and the provider refuses the stored token. */
const oauthTokenRejected = async (login: string, provider: OAuthProvider, env: Env): Promise<boolean> => {
  const token = await hub(env).connectionSecret(login, provider.id)
  return token !== null && (await provider.tokenRejected(token))
}

const listConnections = async (login: string, env: Env): Promise<Connection[]> => {
  const oauth = PROVIDERS.filter((p): p is OAuthProvider => p.kind === "oauth")
  const [rows, cli, rejected] = await Promise.all([
    hub(env).connections(login),
    fetchCliAuth(login, env),
    Promise.all(oauth.map((p) => oauthTokenRejected(login, p, env))),
  ])
  const expired = new Set(oauth.filter((_, i) => rejected[i]).map((p) => p.id))
  // Keep the established response for installed clients. Updated clients normalize these rows against their own box.
  const stored = PROVIDERS.map((p) =>
    p.kind === "cli"
      ? cliView(p, cli.find((status) => status.provider === p.id))
      : storedView(p, rows.find((r) => r.provider === p.id), env, expired.has(p.id)),
  )
  return stored
}

const putApiKey = async (request: Request, env: Env, login: string, provider: Provider): Promise<Response> => {
  if (provider.kind !== "apikey") {
    return errorResponse(400, "BadRequest", `${provider.label} connects through OAuth at /auth/connect/${provider.id}`)
  }
  let body: unknown
  try {
    body = await request.json()
  } catch {
    return errorResponse(400, "BadRequest", "body must be JSON")
  }
  if (!Schema.is(PutApiKeyBody)(body)) {
    return errorResponse(400, "BadRequest", "apiKey must be a string of at least 8 characters")
  }
  const account = maskKey(body.apiKey)
  await hub(env).putConnection(login, provider.id, body.apiKey, account)
  return json(storedView(provider, { provider: provider.id, account }, env, false))
}

const githubGet = (token: string, url: string): Promise<Response> =>
  fetch(url, {
    headers: {
      authorization: `Bearer ${token}`,
      accept: "application/vnd.github+json",
      "x-github-api-version": "2022-11-28",
      "user-agent": "kestrel-control-plane",
    },
  })

const GithubRepoJson = Schema.Struct({
  full_name: Schema.String,
  clone_url: Schema.String,
  private: Schema.Boolean,
  default_branch: Schema.String,
  updated_at: Schema.String,
})

const githubRepoView = (raw: typeof GithubRepoJson.Type): GithubRepo => ({
  fullName: raw.full_name,
  cloneUrl: raw.clone_url,
  private: raw.private,
  defaultBranch: raw.default_branch,
  updatedAt: raw.updated_at,
})

const listRepos = async (env: Env, login: string): Promise<Response> => {
  const creds = await hub(env).credentials(login)
  if (!creds.github) return errorResponse(404, "NotFound", "GitHub is not connected")
  const res = await githubGet(creds.github, "https://api.github.com/user/repos?per_page=100&sort=updated")
  if (!res.ok) throw new UpstreamError(`GitHub repos responded ${res.status}`)
  return json((await decodeGithub(res, Schema.Array(GithubRepoJson))).map(githubRepoView))
}

/**
 * One repository by its "owner/name", independent of `listRepos`'s single page. Import links use this to tell an
 * unreadable repository from one that merely falls outside the first page.
 */
const getRepo = async (env: Env, login: string, repo: GithubRepoSlug): Promise<Response> => {
  const creds = await hub(env).credentials(login)
  if (!creds.github) return errorResponse(404, "NotFound", "GitHub is not connected")
  const res = await githubGet(creds.github, `https://api.github.com/repos/${repo}`)
  if (res.status === 404) return errorResponse(404, "NotFound", `${repo} is not visible to your GitHub connection`)
  if (!res.ok) throw new UpstreamError(`GitHub repository responded ${res.status}`)
  return json(githubRepoView(await decodeGithub(res, GithubRepoJson)))
}

/** Branch pages read per request: GitHub lists 100 per page, alphabetically; larger repositories are cut off here. */
const MAX_BRANCH_PAGES = 10

const GithubRepoMeta = Schema.Struct({ default_branch: Schema.String })
const GithubBranchPage = Schema.Array(Schema.Struct({ name: Schema.String }))

/** A GitHub response body as `schema`; a body of another shape is GitHub misbehaving (502). */
const decodeGithub = async <A, I>(res: Response, schema: Schema.Schema<A, I>): Promise<A> => {
  const decoded = Schema.decodeUnknownEither(schema)(await res.json())
  if (decoded._tag === "Left") throw new UpstreamError("GitHub returned an unexpected response")
  return decoded.right
}

/** Branch names of `repo`, the default branch first and the rest in GitHub's (alphabetical) order. */
const listBranches = async (env: Env, login: string, repo: GithubRepoSlug): Promise<Response> => {
  const creds = await hub(env).credentials(login)
  if (!creds.github) return errorResponse(404, "NotFound", "GitHub is not connected")
  const token = creds.github
  const meta = await githubGet(token, `https://api.github.com/repos/${repo}`)
  if (meta.status === 404) return errorResponse(404, "NotFound", `${repo} is not visible to your GitHub connection`)
  if (!meta.ok) throw new UpstreamError(`GitHub repository responded ${meta.status}`)
  const { default_branch: defaultBranch } = await decodeGithub(meta, GithubRepoMeta)
  const names: string[] = []
  for (let page = 1; page <= MAX_BRANCH_PAGES; page++) {
    const res = await githubGet(token, `https://api.github.com/repos/${repo}/branches?per_page=100&page=${page}`)
    if (!res.ok) throw new UpstreamError(`GitHub branches responded ${res.status}`)
    const batch = await decodeGithub(res, GithubBranchPage)
    for (const branch of batch) if (branch.name !== defaultBranch) names.push(branch.name)
    if (batch.length < 100) break
  }
  return json([defaultBranch, ...names])
}

/**
 * Forwards a browser request to the Hub with the caller's session id. The Hub resolves the session, attaches the
 * caller's credentials (and dev-login marker) and relays to the box in that one Durable Object request; looking the
 * session and credentials up here first would cost two more.
 */
const forwardToHub = (request: Request, env: Env, url: URL): Promise<Response> | Response => {
  const sessionId = readCookie(request.headers.get("cookie"), SESSION_COOKIE)
  if (!sessionId) return errorResponse(401, "Unauthorized", "sign in required")
  const headers = new Headers(request.headers)
  headers.delete(CREDENTIALS_HEADER)
  headers.set(SESSION_HEADER, sessionId)
  const hasBody = request.method !== "GET" && request.method !== "HEAD"
  const forwarded = new Request(`https://hub${url.pathname}${url.search}`, {
    method: request.method,
    headers,
    body: hasBody ? request.body : undefined,
  })
  return hub(env).fetch(forwarded)
}

/** Relays a box file to the Hub with a file token in place of the session cookie; the token query is dropped. */
const forwardFileToken = (request: Request, env: Env, url: URL, token: string): Promise<Response> => {
  const target = new URL(url)
  target.searchParams.delete(BOX_TOKEN_QUERY)
  const headers = new Headers(request.headers)
  headers.delete("cookie")
  headers.delete(CREDENTIALS_HEADER)
  // Only the Worker sets the Hub's session header; one the browser sent must not reach the Hub on this route.
  headers.delete(SESSION_HEADER)
  headers.set(FILE_TOKEN_HEADER, token)
  return hub(env).fetch(new Request(`https://hub${target.pathname}${target.search}`, { method: "GET", headers }))
}

const createPreviewSession = async (env: Env, login: string, taskId: string): Promise<Response> => {
  const result = await hub(env).boxCall(login, "GET", Paths.task(taskId))
  if (!result.ok) return new Response(result.body, { status: result.status, headers: { "content-type": "application/json" } })
  let value: unknown
  try {
    value = JSON.parse(result.body) as unknown
  } catch {
    return errorResponse(502, "BadGateway", "agent box returned an invalid task")
  }
  if (!Schema.is(Task)(value) || value.owner !== login) return errorResponse(404, "NotFound", "thread not found")
  if (value.archivedAt !== undefined) return errorResponse(409, "Conflict", "thread is archived")
  if (value.previewPort === undefined) return errorResponse(409, "Conflict", "the agent has not opened a preview")
  const token = await hub(env).createPreviewSession(login, taskId)
  return json(Schema.decodeSync(PreviewSession)({ token }))
}

const PREVIEW_SESSION_PATH = /^\/api\/tasks\/([^/]+)\/preview\/session$/
const DESKTOP_TOKEN_PATH = /^\/api\/tasks\/([^/]+)\/desktop\/token$/
const CONNECTION_PATH = /^\/api\/connections\/([a-z0-9-]+)$/
const GITHUB_BRANCHES_PATH = /^\/api\/github\/repos\/([^/]+\/[^/]+)\/branches$/
const GITHUB_REPO_PATH = /^\/api\/github\/repos\/([^/]+\/[^/]+)$/

/** Control routes the Worker answers itself. They are rare (page loads, settings), so they look the session up first. */
const isWorkerRoute = (path: string, method: string): boolean =>
  (path === ControlPaths.fileToken && method === "POST") ||
  (DESKTOP_TOKEN_PATH.test(path) && method === "POST") ||
  (PREVIEW_SESSION_PATH.test(path) && method === "POST") ||
  (path === ControlPaths.me && method === "GET") ||
  (path === ControlPaths.connections && method === "GET") ||
  CONNECTION_PATH.test(path) ||
  (path === ControlPaths.githubRepos && method === "GET") ||
  (GITHUB_REPO_PATH.test(path) && method === "GET") ||
  (GITHUB_BRANCHES_PATH.test(path) && method === "GET") ||
  path === ControlPaths.automations ||
  path.startsWith(`${ControlPaths.automations}/`)

const USER_BOX_PATH = /^\/api\/boxes\/([^/]+)$/
const USER_BOX_SECRET_PATH = /^\/api\/boxes\/([^/]+)\/secret$/
const USER_BOX_TOKEN_PATH = /^\/api\/boxes\/([^/]+)\/token$/
const PAIRING_PATH = /^\/api\/boxes\/pairings\/([^/]+)$/
const PAIRING_APPROVE_PATH = /^\/api\/boxes\/pairings\/([^/]+)\/approve$/
const NEST_BOX_RESUME_PATH = /^\/api\/nest\/boxes\/([^/]+)\/resume$/
const NEST_BOX_SUSPEND_PATH = /^\/api\/nest\/boxes\/([^/]+)\/suspend$/
const NEST_BOX_LIMITS_PATH = /^\/api\/nest\/boxes\/([^/]+)\/limits$/
const NEST_BOX_PARK_PATH = /^\/api\/nest\/boxes\/([^/]+)\/park$/
const NEST_BOX_GPU_ATTACH_PATH = /^\/api\/nest\/boxes\/([^/]+)\/gpu\/attach$/
const NEST_BOX_GPU_DETACH_PATH = /^\/api\/nest\/boxes\/([^/]+)\/gpu\/detach$/
const FLEET_BOX_PATH = /^\/api\/fleet\/boxes\/([^/]+)$/
const FLEET_BOX_SECRET_PATH = /^\/api\/fleet\/boxes\/([^/]+)\/secret$/

/** The Hub's outcome as a response: the value as JSON with `status`, or the failure as an error body. */
const answerBox = <T>(outcome: BoxOutcome<T>, status = 200): Response =>
  outcome.ok ? json(outcome.value, status) : errorResponse(outcome.status, outcome.tag, outcome.message)

/**
 * Box management. The session cookie goes to the Hub with each call, which resolves it, so every call is one
 * Durable Object request.
 */
const handleUserBoxes = async (request: Request, env: Env, url: URL): Promise<Response> => {
  const sessionId = readCookie(request.headers.get("cookie"), SESSION_COOKIE)
  if (!sessionId) return errorResponse(401, "Unauthorized", "sign in required")
  const boxes = hub(env)
  const path = url.pathname
  const method = request.method

  const pairing = PAIRING_PATH.exec(path)?.[1]
  if (pairing !== undefined && method === "GET") {
    const code = decodeURIComponent(pairing).replace(/-/g, "").toUpperCase()
    return answerBox(await boxes.pendingPairing(sessionId, code))
  }
  const approve = PAIRING_APPROVE_PATH.exec(path)?.[1]
  if (approve !== undefined && method === "POST") {
    const body = await decodeBody(request, ApprovePairingBody)
    if (body instanceof Response) return body
    const code = decodeURIComponent(approve).replace(/-/g, "").toUpperCase()
    return answerBox(await boxes.approvePairing(sessionId, code, body))
  }

  if (path === ControlPaths.boxes) {
    if (method === "GET") return answerBox(await boxes.listBoxes(sessionId))
    if (method === "POST") {
      const body = await decodeBody(request, CreateBoxBody)
      if (body instanceof Response) return body
      return answerBox(await boxes.createBox(sessionId, body), 201)
    }
  }
  if (path === ControlPaths.activeBox && method === "PUT") {
    const body = await decodeBody(request, SetActiveBoxBody)
    if (body instanceof Response) return body
    return answerBox(await boxes.setActiveBox(sessionId, body.boxId))
  }
  const rotate = USER_BOX_SECRET_PATH.exec(path)?.[1]
  if (rotate !== undefined && method === "POST") {
    return answerBox(await boxes.rotateBoxSecret(sessionId, decodeURIComponent(rotate)))
  }
  const mint = USER_BOX_TOKEN_PATH.exec(path)?.[1]
  if (mint !== undefined && method === "POST") {
    return answerBox(await boxes.mintBoxToken(sessionId, decodeURIComponent(mint)))
  }
  const id = USER_BOX_PATH.exec(path)?.[1]
  if (id !== undefined && method === "PATCH") {
    const body = await decodeBody(request, UpdateBoxBody)
    if (body instanceof Response) return body
    return answerBox(await boxes.updateBox(sessionId, decodeURIComponent(id), body))
  }
  if (id !== undefined && method === "DELETE") {
    const outcome = await boxes.deleteBox(sessionId, decodeURIComponent(id))
    return outcome.ok ? new Response(null, { status: 204 }) : errorResponse(outcome.status, outcome.tag, outcome.message)
  }
  return errorResponse(405, "MethodNotAllowed", `${method} not allowed`)
}

/**
 * Fleet management for operators (`KESTREL_OPERATORS`). Anyone else gets 404, so the routes are not discoverable.
 */
const handleFleetBoxes = async (request: Request, env: Env, url: URL): Promise<Response> => {
  const session = await currentSession(request, env)
  if (!session) return errorResponse(401, "Unauthorized", "sign in required")
  if (!isOperator(env, session.login)) return errorResponse(404, "NotFound", "no such route")
  const fleet = hub(env)
  const path = url.pathname
  const method = request.method

  if (path === ControlPaths.fleetBoxes) {
    if (method === "GET") return json(await fleet.fleetBoxes())
    if (method === "POST") {
      const body = await decodeBody(request, CreateFleetBoxBody)
      if (body instanceof Response) return body
      return json(await fleet.createFleetBox(body), 201)
    }
  }
  const rotate = FLEET_BOX_SECRET_PATH.exec(path)?.[1]
  if (rotate !== undefined && method === "POST") {
    const created = await fleet.rotateFleetSecret(decodeURIComponent(rotate))
    return created === null ? errorResponse(404, "NotFound", "no such box") : json(created)
  }
  const id = FLEET_BOX_PATH.exec(path)?.[1]
  if (id !== undefined && method === "PATCH") {
    const body = await decodeBody(request, UpdateFleetBoxBody)
    if (body instanceof Response) return body
    const box = await fleet.changeFleetBox(decodeURIComponent(id), body)
    return box === null ? errorResponse(404, "NotFound", "no such box") : json(box)
  }
  if (id !== undefined && method === "DELETE") {
    const removed = await fleet.removeFleetBox(decodeURIComponent(id))
    return removed ? new Response(null, { status: 204 }) : errorResponse(404, "NotFound", "no such box")
  }
  return errorResponse(405, "MethodNotAllowed", `${method} not allowed`)
}

/** The most common tool failures, for operators (`KESTREL_OPERATORS`). Anyone else gets 404, like the fleet routes. */
const handleToolFailures = async (request: Request, env: Env, url: URL): Promise<Response> => {
  const session = await currentSession(request, env)
  if (!session) return errorResponse(401, "Unauthorized", "sign in required")
  if (!isOperator(env, session.login)) return errorResponse(404, "NotFound", "no such route")
  if (request.method !== "GET") return errorResponse(405, "MethodNotAllowed", `${request.method} not allowed`)
  const days = Number(url.searchParams.get("days") ?? DEFAULT_TOOL_FAILURE_DAYS)
  if (!Number.isInteger(days) || days < 1 || days > TOOL_FAILURE_RETENTION_DAYS) {
    return errorResponse(400, "BadRequest", `days must be a whole number from 1 to ${TOOL_FAILURE_RETENTION_DAYS}`)
  }
  return json(await hub(env).commonToolFailures(days))
}

/**
 * Active users per managed box, for operators (`KESTREL_OPERATORS`). Anyone else gets 404, like the fleet routes.
 * The read includes every registered box, including one that never reported.
 */
const handleFleetActivity = async (request: Request, env: Env): Promise<Response> => {
  const session = await currentSession(request, env)
  if (!session) return errorResponse(401, "Unauthorized", "sign in required")
  if (!isOperator(env, session.login)) return errorResponse(404, "NotFound", "no such route")
  if (request.method !== "GET") return errorResponse(405, "MethodNotAllowed", `${request.method} not allowed`)
  return json(await hub(env).fleetActivity())
}

/**
 * Nest usage metering for operators (`KESTREL_OPERATORS`): host registration and the reconciled report.
 * Anyone else gets 404.
 */
const handleMeter = async (request: Request, env: Env, url: URL): Promise<Response> => {
  const session = await currentSession(request, env)
  if (!session) return errorResponse(401, "Unauthorized", "sign in required")
  if (!isOperator(env, session.login)) return errorResponse(404, "NotFound", "no such route")
  const meter = hub(env)
  const method = request.method

  if (url.pathname === ControlPaths.meterHosts) {
    if (method === "GET") return json(await meter.meterHosts())
    if (method === "POST") {
      const body = await decodeBody(request, CreateMeterHostBody)
      if (body instanceof Response) return body
      return json(await meter.createMeterHost(body), 201)
    }
  }
  if (url.pathname === ControlPaths.meterReport && method === "POST") {
    const body = await decodeBody(request, MeterReportBody)
    if (body instanceof Response) return body
    return answerBox(await meter.meterReport(body, new Date().toISOString()))
  }
  return errorResponse(405, "MethodNotAllowed", `${method} not allowed`)
}

/**
 * Nest boxes for their owners, and the Nest host list for operators. Every route answers 404 unless
 * `KESTREL_NEST_DOMAIN` is set; the host list also answers 404 to anyone but an operator.
 */
const handleNest = async (request: Request, env: Env, url: URL): Promise<Response> => {
  if (!env.KESTREL_NEST_DOMAIN) return errorResponse(404, "NotFound", "no such route")
  const session = await currentSession(request, env)
  if (!session) return errorResponse(401, "Unauthorized", "sign in required")
  const sessionId = readCookie(request.headers.get("cookie"), SESSION_COOKIE) ?? ""
  const boxes = hub(env)
  const path = url.pathname
  const method = request.method
  if (path === ControlPaths.nestHosts && method === "GET") {
    if (!isOperator(env, session.login)) return errorResponse(404, "NotFound", "no such route")
    return json(await boxes.nestHostList())
  }
  if (path === ControlPaths.nestBoxes && method === "POST") {
    const body = await decodeBody(request, CreateNestBoxBody)
    if (body instanceof Response) return body
    return answerBox(await boxes.createNestBox(sessionId, body), 201)
  }
  if (path === ControlPaths.nestBoxPreview && method === "POST") {
    const body = await decodeBody(request, CreateNestBoxBody)
    if (body instanceof Response) return body
    return answerBox(await boxes.previewNestBox(sessionId, body))
  }
  const resume = NEST_BOX_RESUME_PATH.exec(path)?.[1]
  if (resume !== undefined && method === "POST") {
    return answerBox(await boxes.resumeNestBox(sessionId, decodeURIComponent(resume)))
  }
  const suspend = NEST_BOX_SUSPEND_PATH.exec(path)?.[1]
  if (suspend !== undefined && method === "POST") {
    return answerBox(await boxes.suspendNestBox(sessionId, decodeURIComponent(suspend)))
  }
  const park = NEST_BOX_PARK_PATH.exec(path)?.[1]
  if (park !== undefined && method === "POST") {
    return answerBox(await boxes.parkNestBox(sessionId, decodeURIComponent(park)))
  }
  const gpuAttach = NEST_BOX_GPU_ATTACH_PATH.exec(path)?.[1]
  if (gpuAttach !== undefined && method === "POST") {
    return answerBox(await boxes.attachNestGpu(sessionId, decodeURIComponent(gpuAttach)))
  }
  const gpuDetach = NEST_BOX_GPU_DETACH_PATH.exec(path)?.[1]
  if (gpuDetach !== undefined && method === "POST") {
    return answerBox(await boxes.detachNestGpu(sessionId, decodeURIComponent(gpuDetach)))
  }
  const limits = NEST_BOX_LIMITS_PATH.exec(path)?.[1]
  if (limits !== undefined && method === "PUT") {
    const body = await decodeBody(request, NestLimits)
    if (body instanceof Response) return body
    return answerBox(await boxes.setNestLimits(sessionId, decodeURIComponent(limits), body))
  }
  return errorResponse(405, "MethodNotAllowed", `${method} not allowed`)
}

/** Public waitlist signups carry one small JSON object; anything larger is not a signup form. */
const MAX_WAITLIST_BODY_BYTES = 4096

/** The client IP the Hub rate-limits on; local requests without Cloudflare's header share one bucket. */
const waitlistClientIp = (request: Request): string => request.headers.get("cf-connecting-ip") ?? "unknown"

/** Unauthenticated waitlist signup for the public site; the Hub stores it and applies the per-IP limit. */
const handleWaitlist = async (request: Request, env: Env): Promise<Response> => {
  if (request.method !== "POST") return errorResponse(405, "MethodNotAllowed", `${request.method} not allowed`)
  const capped = await cappedRequest(request, MAX_WAITLIST_BODY_BYTES)
  if (capped instanceof Response) return capped
  const body = await decodeBody(capped, WaitlistSignupBody)
  if (body instanceof Response) return body
  const signup = await hub(env).addWaitlistSignup(body.email, waitlistClientIp(request))
  return signup === null
    ? errorResponse(429, "TooManyRequests", "too many waitlist signups; try again later")
    : json(signup, signup.created ? 201 : 200)
}

/**
 * Routes every `/api/*` request: control routes in the Worker, everything else (the box API, its WebSockets and
 * `GET /api/box`) in one request to the Hub.
 */
export const handleApi = async (request: Request, env: Env, url: URL): Promise<Response> => {
  const path = url.pathname
  const method = request.method
  // A file token stands in for the session cookie on box files, and a desktop token on a desktop stream: a WebView or
  // DOM `<img>` cannot send a Cookie header.
  const fileToken = method === "GET" ? url.searchParams.get(BOX_TOKEN_QUERY) : null
  if (fileToken !== null && (isBoxFilePath(path) || desktopStreamTask(path) !== null)) {
    return forwardFileToken(request, env, url, fileToken)
  }
  if (path === ControlPaths.waitlist) return handleWaitlist(request, env)
  if (path === ControlPaths.boxes || path.startsWith(`${ControlPaths.boxes}/`)) return handleUserBoxes(request, env, url)
  if (path === ControlPaths.fleetBoxes || path.startsWith(`${ControlPaths.fleetBoxes}/`)) {
    return handleFleetBoxes(request, env, url)
  }
  if (path === ControlPaths.meterHosts || path === ControlPaths.meterReport) return handleMeter(request, env, url)
  if (path === ControlPaths.nestHosts || path === ControlPaths.nestBoxes || path.startsWith(`${ControlPaths.nestBoxes}/`)) {
    return handleNest(request, env, url)
  }
  if (path === ControlPaths.fleetToolFailures) return handleToolFailures(request, env, url)
  if (path === ControlPaths.fleetActivity) return handleFleetActivity(request, env)
  if (!isWorkerRoute(path, method)) return forwardToHub(request, env, url)

  const session = await currentSession(request, env)
  if (!session) return errorResponse(401, "Unauthorized", "sign in required")
  const login = session.login

  if (path === ControlPaths.fileToken) {
    // `currentSession` found the session from this cookie, so it is present; the token lasts no longer than it.
    const sessionId = readCookie(request.headers.get("cookie"), SESSION_COOKIE) ?? ""
    const minted = await hub(env).createFileToken(sessionId)
    return minted === null ? errorResponse(401, "Unauthorized", "sign in required") : json(minted)
  }

  const desktopToken = DESKTOP_TOKEN_PATH.exec(path)
  if (desktopToken?.[1] && method === "POST") {
    const sessionId = readCookie(request.headers.get("cookie"), SESSION_COOKIE) ?? ""
    const minted = await hub(env).createDesktopToken(sessionId, decodeURIComponent(desktopToken[1]))
    return minted === null ? errorResponse(401, "Unauthorized", "sign in required") : json(minted)
  }

  const previewSession = PREVIEW_SESSION_PATH.exec(path)
  if (previewSession?.[1] && method === "POST") {
    return createPreviewSession(env, login, decodeURIComponent(previewSession[1]))
  }

  if (path === ControlPaths.me && method === "GET") {
    const user = await hub(env).getUser(login)
    if (!user) return errorResponse(401, "Unauthorized", "unknown user")
    const me: Me = { login: user.login, name: user.name, avatarUrl: user.avatarUrl, operator: isOperator(env, login), nestEnabled: Boolean(env.KESTREL_NEST_DOMAIN) }
    return json(me)
  }

  if (path === ControlPaths.connections && method === "GET") {
    return json(await listConnections(login, env))
  }

  const connection = CONNECTION_PATH.exec(path)
  if (connection && connection[1] !== undefined) {
    const provider = findProvider(connection[1])
    if (!provider) return errorResponse(404, "NotFound", `unknown provider ${connection[1]}`)
    if (provider.kind === "cli") {
      return errorResponse(400, "BadRequest", `${provider.label} connects from Settings › Connections`)
    }
    if (method === "PUT") return putApiKey(request, env, login, provider)
    if (method === "DELETE") {
      await hub(env).deleteConnection(login, provider.id)
      return new Response(null, { status: 204 })
    }
    return errorResponse(405, "MethodNotAllowed", `${method} not allowed`)
  }

  if (path === ControlPaths.githubRepos && method === "GET") {
    return listRepos(env, login)
  }

  const repoPath = GITHUB_REPO_PATH.exec(path)?.[1]
  if (repoPath !== undefined && method === "GET") {
    const repo = decodeURIComponent(repoPath)
    if (!Schema.is(GithubRepoSlug)(repo)) return errorResponse(400, "BadRequest", "repository must be owner/name")
    return getRepo(env, login, repo)
  }

  const branches = GITHUB_BRANCHES_PATH.exec(path)?.[1]
  if (branches !== undefined && method === "GET") {
    const repo = decodeURIComponent(branches)
    if (!Schema.is(GithubRepoSlug)(repo)) return errorResponse(400, "BadRequest", "repository must be owner/name")
    return listBranches(env, login, repo)
  }

  return handleAutomations(request, env, login, url, ControlPaths.automations)
}
