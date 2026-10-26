import { Schema } from "effect"
import {
  CREDENTIALS_HEADER,
  ControlPaths,
  PutApiKeyBody,
  type BoxStatus,
  type Connection,
  type GithubRepo,
  type Me,
} from "@cloudagents/protocol"
import { PROVIDERS, findProvider, isAvailable, type Provider } from "./providers"
import { UpstreamError, errorResponse, json, maskKey } from "./http"
import { hub, type Env } from "./env"
import { sessionLogin } from "./auth"

type ConnectionRow = { provider: string; account: string | null }

const connectionView = (provider: Provider, row: ConnectionRow | undefined, env: Env): Connection => ({
  provider: provider.id,
  label: provider.label,
  kind: provider.kind,
  connected: row !== undefined,
  account: row?.account ?? null,
  available: isAvailable(provider, env),
})

const listConnections = async (login: string, env: Env): Promise<Connection[]> => {
  const rows = await hub(env).connections(login)
  return PROVIDERS.map((p) => connectionView(p, rows.find((r) => r.provider === p.id), env))
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
  return json(connectionView(provider, { provider: provider.id, account }, env))
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

/** Forwards a browser request to the box with the caller's credentials attached. */
const relayToBox = async (request: Request, env: Env, login: string, url: URL): Promise<Response> => {
  const creds = await hub(env).credentials(login)
  const headers = new Headers(request.headers)
  headers.set(CREDENTIALS_HEADER, JSON.stringify(creds))
  const hasBody = request.method !== "GET" && request.method !== "HEAD"
  const forwarded = new Request(`https://hub${url.pathname}${url.search}`, {
    method: request.method,
    headers,
    body: hasBody ? request.body : undefined,
  })
  return hub(env).fetch(forwarded)
}

/** Routes every `/api/*` request: control routes in the Worker, everything else relayed to the box. */
export const handleApi = async (request: Request, env: Env, url: URL): Promise<Response> => {
  const login = await sessionLogin(request, env)
  if (!login) return errorResponse(401, "Unauthorized", "sign in required")

  const path = url.pathname
  const method = request.method

  if (path === ControlPaths.me && method === "GET") {
    const user = await hub(env).getUser(login)
    if (!user) return errorResponse(401, "Unauthorized", "unknown user")
    const me: Me = { login: user.login, name: user.name, avatarUrl: user.avatarUrl }
    return json(me)
  }

  if (path === ControlPaths.connections && method === "GET") {
    return json(await listConnections(login, env))
  }

  const connection = /^\/api\/connections\/([a-z0-9-]+)$/.exec(path)
  if (connection && connection[1] !== undefined) {
    const provider = findProvider(connection[1])
    if (!provider) return errorResponse(404, "NotFound", `unknown provider ${connection[1]}`)
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

  if (path === ControlPaths.box && method === "GET") {
    const status: BoxStatus = await hub(env).boxStatus()
    return json(status)
  }

  return relayToBox(request, env, login, url)
}
