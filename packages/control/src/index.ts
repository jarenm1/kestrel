import { ControlPaths, RELAY_CONNECT_PATH } from "@cloudagents/protocol"
import { handleApi } from "./api"
import { handleAuth } from "./auth"
import { handleBoxAutomations } from "./automations"
import { errorResponse, safeEqual, UpstreamError } from "./http"
import { hub, type Env } from "./env"
import { handleGithubWebhook } from "./webhooks"

export { Hub } from "./hub"

/** Only the agent box holds BOX_TOKEN; the box's dial-in and its automation routes both require it. */
const boxAuthorized = async (request: Request, env: Env): Promise<boolean> => {
  const auth = request.headers.get("authorization") ?? ""
  const token = auth.startsWith("Bearer ") ? auth.slice("Bearer ".length) : ""
  return env.BOX_TOKEN !== undefined && token !== "" && (await safeEqual(token, env.BOX_TOKEN))
}

/** The agent box dials in here; the Durable Object accepts the socket once the token matches. */
const connectBox = async (request: Request, env: Env): Promise<Response> => {
  if (!(await boxAuthorized(request, env))) return errorResponse(401, "Unauthorized", "invalid box token")
  return hub(env).fetch(request)
}

const isBoxAutomationPath = (pathname: string): boolean =>
  pathname === ControlPaths.boxAutomations || pathname.startsWith(`${ControlPaths.boxAutomations}/`)

/**
 * The marketing hosts serve only the app's public pages. Sessions live on the app host, so sign-in and API calls
 * that land here (e.g. an old bookmark) move there with the same path.
 */
const SITE_HOSTS: Record<string, true> = { "kestrel-agent.com": true, "www.kestrel-agent.com": true }
const APP_ORIGIN = "https://app.kestrel-agent.com"

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url)
    try {
      if (url.pathname === RELAY_CONNECT_PATH) return await connectBox(request, env)
      if (isBoxAutomationPath(url.pathname)) {
        if (!(await boxAuthorized(request, env))) return errorResponse(401, "Unauthorized", "invalid box token")
        return await handleBoxAutomations(request, env, url)
      }
      if (url.pathname === ControlPaths.githubWebhook) return await handleGithubWebhook(request, env)
      if (SITE_HOSTS[url.hostname] && (url.pathname.startsWith("/auth/") || url.pathname.startsWith("/api/"))) {
        return Response.redirect(`${APP_ORIGIN}${url.pathname}${url.search}`, 302)
      }
      if (url.pathname.startsWith("/auth/")) return await handleAuth(request, env, url)
      if (url.pathname.startsWith("/api/")) return await handleApi(request, env, url)
      return env.ASSETS.fetch(request)
    } catch (err) {
      if (err instanceof UpstreamError) return errorResponse(502, "BadGateway", err.message)
      console.error(err)
      return errorResponse(500, "InternalError", "unexpected error")
    }
  },
} satisfies ExportedHandler<Env>
