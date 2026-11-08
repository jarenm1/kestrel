import { Schema } from "effect"
import {
  ApprovePairingBody,
  CliAuthStatus,
  CliProvider,
  ControlPaths,
  CreateBoxBody,
  CreateNestBoxBody,
  NestLimits,
  CreateMeterHostBody,
  GithubRepoSlug,
  MeterReportBody,
  PutApiKeyBody,
  SetActiveBoxBody,
  UpdateBoxBody,
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
import { UpstreamError, decodeBody, errorResponse, json, maskKey, readCookie } from "./http"
import { hub, isOperator, type Env } from "./env"
import { SESSION_COOKIE, currentSession } from "./auth"
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

const CONNECTION_PATH = /^\/api\/connections\/([a-z0-9-]+)$/
const GITHUB_BRANCHES_PATH = /^\/api\/github\/repos\/([^/]+\/[^/]+)\/branches$/
const GITHUB_REPO_PATH = /^\/api\/github\/repos\/([^/]+\/[^/]+)$/

/** Control routes the Worker answers itself; everything else under `/api/*` is the box's API, reached directly. */
const isWorkerRoute = (path: string, method: string): boolean =>
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

/**
 * Routes every `/api/*` request: control routes in the Worker; anything else is the box's API, which apps
 * reach directly on the box's own URL, and gets a 404 here.
 */
export const handleApi = async (request: Request, env: Env, url: URL): Promise<Response> => {
  const path = url.pathname
  const method = request.method
  if (path === ControlPaths.boxes || path.startsWith(`${ControlPaths.boxes}/`)) return handleUserBoxes(request, env, url)
  if (path === ControlPaths.meterHosts || path === ControlPaths.meterReport) return handleMeter(request, env, url)
  if (path === ControlPaths.nestHosts || path === ControlPaths.nestBoxes || path.startsWith(`${ControlPaths.nestBoxes}/`)) {
    return handleNest(request, env, url)
  }
  if (path === ControlPaths.fleetToolFailures) return handleToolFailures(request, env, url)
  if (!isWorkerRoute(path, method)) return errorResponse(404, "NotFound", "no such route")

  const session = await currentSession(request, env)
  if (!session) return errorResponse(401, "Unauthorized", "sign in required")
  const login = session.login

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
