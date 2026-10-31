import { BOX_ID_HEADER, BOX_USER_HEADER, ControlPaths, PairingPollBody, PairingStartBody } from "@cloudagents/protocol"
import { handleApi } from "./api"
import { handleAuth } from "./auth"
import { handleBoxAutomations } from "./automations"
import { decodeBody, errorResponse, json, safeEqual, UpstreamError } from "./http"
import { hub, type Env } from "./env"
import { handleGithubWebhook } from "./webhooks"

export { Hub } from "./hub"

/** Only the trusted managed-box service holds BOX_TOKEN; it gates the managed credential and automation routes. */
const boxAuthorized = async (request: Request, env: Env): Promise<boolean> => {
  const auth = request.headers.get("authorization") ?? ""
  const token = auth.startsWith("Bearer ") ? auth.slice("Bearer ".length) : ""
  return env.BOX_TOKEN !== undefined && token !== "" && (await safeEqual(token, env.BOX_TOKEN))
}

/**
 * A user's own box asks who owns it and gets their connection secrets. It proves itself with its own secret rather
 * than BOX_TOKEN, so only the box holding that secret can read them.
 */
const boxSelf = async (request: Request, env: Env): Promise<Response> => {
  if (request.method !== "GET") return errorResponse(405, "MethodNotAllowed", `${request.method} not allowed`)
  const auth = request.headers.get("authorization") ?? ""
  const secret = auth.startsWith("Bearer ") ? auth.slice("Bearer ".length) : ""
  const boxId = request.headers.get(BOX_ID_HEADER) ?? ""
  const self = secret === "" || boxId === "" ? null : await hub(env).boxSelf(boxId, secret)
  return self === null ? errorResponse(401, "Unauthorized", "invalid box credentials") : json(self)
}

/**
 * The managed box's trusted service reads a user's connection secrets. BOX_TOKEN proves the caller; BOX_USER_HEADER
 * names the user, and only a known user gets credentials.
 */
const boxCredentials = async (request: Request, env: Env): Promise<Response> => {
  if (request.method !== "GET") return errorResponse(405, "MethodNotAllowed", `${request.method} not allowed`)
  if (!(await boxAuthorized(request, env))) return errorResponse(401, "Unauthorized", "invalid box token")
  const login = request.headers.get(BOX_USER_HEADER) ?? ""
  const self = login === "" ? null : await hub(env).managedBoxCredentials(login)
  return self === null ? errorResponse(401, "Unauthorized", "unknown user") : json(self)
}

const isBoxAutomationPath = (pathname: string): boolean =>
  pathname === ControlPaths.boxAutomations || pathname.startsWith(`${ControlPaths.boxAutomations}/`)

/**
 * The marketing hosts serve only the app's public pages. Sessions live on the app host, so sign-in and API calls
 * that land here (e.g. an old bookmark) move there with the same path.
 */
const SITE_HOSTS: Record<string, true> = { "kestrel-agent.com": true, "www.kestrel-agent.com": true }
const APP_ORIGIN = "https://app.kestrel-agent.com"

/**
 * The CLI starts a pairing and polls it with the secret `pairingId`; no session is involved. The user approves the code
 * in the app, and the next poll hands out the approved box.
 */
const handleBoxPairing = async (request: Request, env: Env, url: URL): Promise<Response> => {
  if (request.method !== "POST") return errorResponse(405, "MethodNotAllowed", `${request.method} not allowed`)
  if (url.pathname === ControlPaths.boxPairing) {
    const body = await decodeBody(request, PairingStartBody)
    if (body instanceof Response) return body
    // The approval page is on the host the CLI talks to (a Preview has its own Hub), except the marketing hosts, which
    // send the app to the app host. A local stack names its app origin, since `wrangler dev` rewrites request URLs.
    const appOrigin = env.APP_ORIGIN ?? (SITE_HOSTS[url.hostname] ? APP_ORIGIN : url.origin)
    const started = await hub(env).startPairing(body, appOrigin)
    return started === null
      ? errorResponse(429, "TooManyRequests", "too many pairings in progress; try again in a few minutes")
      : json(started, 201)
  }
  const body = await decodeBody(request, PairingPollBody)
  if (body instanceof Response) return body
  const poll = await hub(env).pollPairing(body.pairingId)
  return poll === null ? errorResponse(404, "NotFound", "no such pairing or it expired") : json(poll)
}

/**
 * The public pages ask the app host who is signed in (to show "Profile" instead of "Get Started"). They are
 * same-site with the app host, so its `SameSite=Lax` session cookie rides along; this lets them read the answer.
 * Allowed: the marketing hosts, and on local stacks (dev sign-in enabled) any `site.*` origin.
 */
const publicSiteOrigin = (request: Request, env: Env): string | null => {
  const origin = request.headers.get("origin")
  if (!origin || !URL.canParse(origin)) return null
  const { hostname } = new URL(origin)
  return SITE_HOSTS[hostname] || (env.DEV_SESSION_LOGIN && hostname.startsWith("site.")) ? origin : null
}

const withCors = (response: Response, origin: string): Response => {
  const headers = new Headers(response.headers)
  headers.set("Access-Control-Allow-Origin", origin)
  headers.set("Access-Control-Allow-Credentials", "true")
  headers.append("Vary", "Origin")
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers })
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url)
    try {
      if (url.pathname === "/box/connect" || url.pathname.startsWith("/_preview/")) {
        return errorResponse(404, "NotFound", "the agent box is reached directly at its own URL; it is not relayed")
      }
      if (url.pathname === ControlPaths.boxCredentials) return await boxCredentials(request, env)
      if (url.pathname === ControlPaths.boxSelf) return await boxSelf(request, env)
      if (url.pathname === ControlPaths.boxPairing || url.pathname === ControlPaths.boxPairingPoll) {
        return await handleBoxPairing(request, env, url)
      }
      if (isBoxAutomationPath(url.pathname)) {
        if (!(await boxAuthorized(request, env))) return errorResponse(401, "Unauthorized", "invalid box token")
        return await handleBoxAutomations(request, env, url)
      }
      if (url.pathname === ControlPaths.githubWebhook) return await handleGithubWebhook(request, env)
      if (SITE_HOSTS[url.hostname] && (url.pathname.startsWith("/auth/") || url.pathname.startsWith("/api/"))) {
        return Response.redirect(`${APP_ORIGIN}${url.pathname}${url.search}`, 302)
      }
      if (url.pathname.startsWith("/auth/")) return await handleAuth(request, env, url)
      if (url.pathname.startsWith("/api/")) {
        const response = await handleApi(request, env, url)
        const origin = url.pathname === ControlPaths.me ? publicSiteOrigin(request, env) : null
        return origin ? withCors(response, origin) : response
      }
      return env.ASSETS.fetch(request)
    } catch (err) {
      if (err instanceof UpstreamError) return errorResponse(502, "BadGateway", err.message)
      console.error(err)
      return errorResponse(500, "InternalError", "unexpected error")
    }
  },
} satisfies ExportedHandler<Env>
