import { Schema } from "effect"
import {
  ApprovePairingBody,
  CREDENTIALS_HEADER,
  CliAuthStatus,
  ControlPaths,
  CreateBoxBody,
  Paths,
  PreviewSession,
  PutApiKeyBody,
  SetActiveBoxBody,
  Task,
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
  type CliProvider,
  type OAuthProvider,
  type Provider,
} from "./providers"
import { UpstreamError, decodeBody, errorResponse, json, maskKey, readCookie } from "./http"
import { SESSION_HEADER, hub, type Env } from "./env"
import { SESSION_COOKIE, currentSession } from "./auth"
import { handleAutomations } from "./automations"
import type { BoxOutcome } from "./hub"

type ConnectionRow = { provider: string; account: string | null }

const storedView = (provider: OAuthProvider | ApiKeyProvider, row: ConnectionRow | undefined, env: Env): Connection => ({
  provider: provider.id,
  label: provider.label,
  kind: provider.kind,
  connected: row !== undefined,
  account: row?.account ?? null,
  available: isAvailable(provider, env),
})

const cliView = (provider: CliProvider, status: CliAuthStatus | undefined): Connection => ({
  provider: provider.id,
  label: provider.label,
  kind: provider.kind,
  connected: status?.loggedIn ?? false,
  account: status?.loggedIn ? status.account : null,
  available: status !== undefined && status.error === undefined,
  ...(status?.error === undefined ? {} : { error: status.error }),
})

/** Devbox CLI logins as the box reports them; empty when the box is offline or answers badly. */
const fetchCliAuth = async (login: string, env: Env): Promise<readonly CliAuthStatus[]> => {
  const res = await hub(env).boxCall(login, "GET", ControlPaths.cliAuth)
  if (!res.ok) return []
  let body: unknown = null
  try {
    body = JSON.parse(res.body)
  } catch {
    return []
  }
  return Schema.is(Schema.Array(CliAuthStatus))(body) ? body : []
}

const listConnections = async (login: string, env: Env): Promise<Connection[]> => {
  const [rows, cli] = await Promise.all([hub(env).connections(login), fetchCliAuth(login, env)])
  return PROVIDERS.map((p) =>
    p.kind === "cli"
      ? cliView(p, cli.find((s) => s.provider === p.id))
      : storedView(p, rows.find((r) => r.provider === p.id), env),
  )
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
  return json(storedView(provider, { provider: provider.id, account }, env))
}

const listRepos = async (env: Env, login: string): Promise<Response> => {
  const creds = await hub(env).credentials(login)
  if (!creds.github) return errorResponse(404, "NotFound", "GitHub is not connected")
  const res = await fetch("https://api.github.com/user/repos?per_page=100&sort=updated", {
    headers: {
      authorization: `Bearer ${creds.github}`,
      accept: "application/vnd.github+json",
      "x-github-api-version": "2022-11-28",
      "user-agent": "kestrel-control-plane",
    },
  })
  if (!res.ok) throw new UpstreamError(`GitHub repos responded ${res.status}`)
  const raw = (await res.json()) as {
    full_name: string
    clone_url: string
    private: boolean
    default_branch: string
    updated_at: string
  }[]
  const repos: GithubRepo[] = raw.map((r) => ({
    fullName: r.full_name,
    cloneUrl: r.clone_url,
    private: r.private,
    defaultBranch: r.default_branch,
    updatedAt: r.updated_at,
  }))
  return json(repos)
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
const CONNECTION_PATH = /^\/api\/connections\/([a-z0-9-]+)$/

/** Control routes the Worker answers itself. They are rare (page loads, settings), so they look the session up first. */
const isWorkerRoute = (path: string, method: string): boolean =>
  (PREVIEW_SESSION_PATH.test(path) && method === "POST") ||
  (path === ControlPaths.me && method === "GET") ||
  (path === ControlPaths.connections && method === "GET") ||
  CONNECTION_PATH.test(path) ||
  (path === ControlPaths.githubRepos && method === "GET") ||
  path === ControlPaths.automations ||
  path.startsWith(`${ControlPaths.automations}/`)

const USER_BOX_PATH = /^\/api\/boxes\/([^/]+)$/
const USER_BOX_SECRET_PATH = /^\/api\/boxes\/([^/]+)\/secret$/
const USER_BOX_TOKEN_PATH = /^\/api\/boxes\/([^/]+)\/token$/
const PAIRING_PATH = /^\/api\/boxes\/pairings\/([^/]+)$/
const PAIRING_APPROVE_PATH = /^\/api\/boxes\/pairings\/([^/]+)\/approve$/

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
 * Routes every `/api/*` request: control routes in the Worker, everything else (the box API, its WebSockets and
 * `GET /api/box`) in one request to the Hub.
 */
export const handleApi = async (request: Request, env: Env, url: URL): Promise<Response> => {
  const path = url.pathname
  const method = request.method
  if (path === ControlPaths.boxes || path.startsWith(`${ControlPaths.boxes}/`)) return handleUserBoxes(request, env, url)
  if (!isWorkerRoute(path, method)) return forwardToHub(request, env, url)

  const session = await currentSession(request, env)
  if (!session) return errorResponse(401, "Unauthorized", "sign in required")
  const login = session.login

  const previewSession = PREVIEW_SESSION_PATH.exec(path)
  if (previewSession?.[1] && method === "POST") {
    return createPreviewSession(env, login, decodeURIComponent(previewSession[1]))
  }

  if (path === ControlPaths.me && method === "GET") {
    const user = await hub(env).getUser(login)
    if (!user) return errorResponse(401, "Unauthorized", "unknown user")
    const me: Me = { login: user.login, name: user.name, avatarUrl: user.avatarUrl }
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

  return handleAutomations(request, env, login, url, ControlPaths.automations)
}
