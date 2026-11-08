import {
  BOX_ID_HEADER,
  BOX_TURN_PATH,
  BOX_USER_HEADER,
  ControlPaths,
  METER_HOST_ID_HEADER,
  MAX_METER_BODY_BYTES,
  MeterBatch,
  NestEnrollBody,
  PairingPollBody,
  PairingStartBody,
  ToolFailureReport,
} from "@cloudagents/protocol"
import { handleApi } from "./api"
import { handleAuth } from "./auth"
import { handlePrWatch } from "./pr-watch"
import { handleBoxAutomations } from "./automations"
import { cappedRequest, decodeBody, errorResponse, json, safeEqual, UpstreamError } from "./http"
import { hub, type Env } from "./env"
import { SITE_HOSTS, serveAppPage } from "./pages"
import { handleGithubWebhook } from "./webhooks"
import { handleBoxTurn } from "./turn"

export { Hub } from "./hub"

/**
 * A Nest VM's first contact: it trades the one-time enrollment token its host's create command issued for its box
 * secret. Any other token gets 401.
 */
const nestEnroll = async (request: Request, env: Env): Promise<Response> => {
  if (request.method !== "POST") return errorResponse(405, "MethodNotAllowed", `${request.method} not allowed`)
  if (!env.KESTREL_NEST_DOMAIN) return errorResponse(404, "NotFound", "no such route")
  const body = await decodeBody(request, NestEnrollBody)
  if (body instanceof Response) return body
  const enrolled = await hub(env).nestEnroll(body)
  return enrolled === null ? errorResponse(401, "Unauthorized", "invalid enrollment token") : json(enrolled)
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

/** The bearer secret, box id and user a box's request carries; null when any of them is missing. */
const boxHeaders = (request: Request): { boxId: string; secret: string; login: string } | null => {
  const auth = request.headers.get("authorization") ?? ""
  const secret = auth.startsWith("Bearer ") ? auth.slice("Bearer ".length) : ""
  const boxId = request.headers.get(BOX_ID_HEADER) ?? ""
  const login = request.headers.get(BOX_USER_HEADER) ?? ""
  return secret === "" || boxId === "" || login === "" ? null : { boxId, secret, login }
}

/**
 * A Nest host posts a batch of usage records, proving itself with its secret and id. The Hub stores a batch atomically
 * and counts records it already holds as duplicates, so a retried batch never stores anything twice.
 */
const meterRecords = async (request: Request, env: Env): Promise<Response> => {
  if (request.method !== "POST") return errorResponse(405, "MethodNotAllowed", `${request.method} not allowed`)
  const auth = request.headers.get("authorization") ?? ""
  const secret = auth.startsWith("Bearer ") ? auth.slice("Bearer ".length) : ""
  const hostId = request.headers.get(METER_HOST_ID_HEADER) ?? ""
  if (secret === "" || hostId === "") return errorResponse(401, "Unauthorized", "invalid meter host credentials")
  const capped = await cappedRequest(request, MAX_METER_BODY_BYTES)
  if (capped instanceof Response) return capped
  const batch = await decodeBody(capped, MeterBatch, { onExcessProperty: "error" })
  if (batch instanceof Response) return batch
  const outcome = await hub(env).ingestMeterRecords(hostId, secret, batch)
  return outcome.ok ? json(outcome.value) : errorResponse(outcome.status, outcome.tag, outcome.message)
}

/**
 * Automation calls from a box, for the user in `BOX_USER_HEADER` when that user owns the box.
 */
const boxAutomations = async (request: Request, env: Env, url: URL): Promise<Response> => {
  const caller = boxHeaders(request)
  if (caller === null) return errorResponse(401, "Unauthorized", "invalid box credentials")
  const access = await hub(env).boxAuthorize(caller.boxId, caller.secret, caller.login)
  if (!access.ok) return errorResponse(access.status, access.tag, access.message)
  return url.pathname === "/box/automations/pr-watch" ? handlePrWatch(request, env, url) : handleBoxAutomations(request, env, url)
}

/** Boxes report tool failure counts with their own secret and id. */
const boxToolFailures = async (request: Request, env: Env): Promise<Response> => {
  if (request.method !== "POST") return errorResponse(405, "MethodNotAllowed", `${request.method} not allowed`)
  const auth = request.headers.get("authorization") ?? ""
  const secret = auth.startsWith("Bearer ") ? auth.slice("Bearer ".length) : ""
  const boxId = request.headers.get(BOX_ID_HEADER) ?? ""
  if (secret === "" || boxId === "" || !(await hub(env).boxVerify(boxId, secret))) {
    return errorResponse(401, "Unauthorized", "invalid box credentials")
  }
  const body = await decodeBody(request, ToolFailureReport)
  if (body instanceof Response) return body
  await hub(env).recordToolFailures(body)
  return new Response(null, { status: 204 })
}

const isBoxAutomationPath = (pathname: string): boolean =>
  pathname === ControlPaths.boxAutomations || pathname.startsWith(`${ControlPaths.boxAutomations}/`)

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
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url)
    try {
      if (url.pathname === ControlPaths.nestHostConnect) {
        return env.KESTREL_NEST_DOMAIN ? hub(env).fetch(request) : errorResponse(404, "NotFound", "no such route")
      }
      if (url.pathname === ControlPaths.nestEnroll) return await nestEnroll(request, env)
      if (url.pathname === ControlPaths.boxSelf) return await boxSelf(request, env)
      if (url.pathname === BOX_TURN_PATH) return await handleBoxTurn(request, env)
      if (url.pathname === ControlPaths.meterRecords) return await meterRecords(request, env)
      if (url.pathname === ControlPaths.boxToolFailures) return await boxToolFailures(request, env)
      if (url.pathname === ControlPaths.boxPairing || url.pathname === ControlPaths.boxPairingPoll) {
        return await handleBoxPairing(request, env, url)
      }
      if (isBoxAutomationPath(url.pathname)) return await boxAutomations(request, env, url)
      if (url.pathname === ControlPaths.githubWebhook) return await handleGithubWebhook(request, env, ctx)
      if (SITE_HOSTS[url.hostname] && (url.pathname.startsWith("/auth/") || url.pathname.startsWith("/api/"))) {
        return Response.redirect(`${APP_ORIGIN}${url.pathname}${url.search}`, 302)
      }
      if (url.pathname.startsWith("/auth/")) return await handleAuth(request, env, url)
      if (url.pathname.startsWith("/api/")) {
        const response = await handleApi(request, env, url)
        const origin = url.pathname === ControlPaths.me ? publicSiteOrigin(request, env) : null
        return origin ? withCors(response, origin) : response
      }
      return await serveAppPage(request, env.ASSETS, url)
    } catch (err) {
      if (err instanceof UpstreamError) return errorResponse(502, "BadGateway", err.message)
      console.error(err)
      return errorResponse(500, "InternalError", "unexpected error")
    }
  },
} satisfies ExportedHandler<Env>
