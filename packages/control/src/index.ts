import { ControlPaths, RELAY_CONNECT_PATH } from "@cloudagents/protocol"
import { handleApi } from "./api"
import { handleAuth } from "./auth"
import { errorResponse, safeEqual, UpstreamError } from "./http"
import { hub, type Env } from "./env"
import { handleGithubWebhook } from "./webhooks"

export { Hub } from "./hub"

/** The agent box dials in here; the Durable Object accepts the socket once the token matches. */
const connectBox = async (request: Request, env: Env): Promise<Response> => {
  const auth = request.headers.get("authorization") ?? ""
  const token = auth.startsWith("Bearer ") ? auth.slice("Bearer ".length) : ""
  if (!env.BOX_TOKEN || !token || !(await safeEqual(token, env.BOX_TOKEN))) {
    return errorResponse(401, "Unauthorized", "invalid box token")
  }
  return hub(env).fetch(request)
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url)
    try {
      if (url.pathname === RELAY_CONNECT_PATH) return await connectBox(request, env)
      if (url.pathname === ControlPaths.githubWebhook) return await handleGithubWebhook(request, env)
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
