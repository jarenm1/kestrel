import { Schema } from "effect"
import { type Env, hub } from "./env"
import { errorResponse, json } from "./http"
import { PullRequestWebhook, pullRequestEventOf, verifyGithubSignature } from "./github"

const RepoOnly = Schema.Struct({ repository: Schema.Struct({ full_name: Schema.String }) })

/**
 * `POST /webhooks/github`: unauthenticated, verified by the per-repo HMAC secret. Only `pull_request` deliveries
 * do anything; the Hub dedupes by `X-GitHub-Delivery` and fires the matching automations in the background.
 */
export const handleGithubWebhook = async (request: Request, env: Env): Promise<Response> => {
  const raw = await request.text()
  let payload: unknown
  try {
    payload = JSON.parse(raw)
  } catch {
    return errorResponse(400, "BadRequest", "webhook body is not JSON")
  }
  const repo = Schema.decodeUnknownEither(RepoOnly)(payload)
  if (repo._tag === "Left") return errorResponse(400, "BadRequest", "webhook has no repository")
  const slug = repo.right.repository.full_name
  const hook = await hub(env).githubHook(slug.toLowerCase())
  if (hook === null || String(hook.hookId) !== request.headers.get("x-github-hook-id")) {
    return errorResponse(404, "NotFound", "no automation webhook for this repository")
  }
  if (!(await verifyGithubSignature(hook.secret, raw, request.headers.get("x-hub-signature-256")))) {
    return errorResponse(401, "Unauthorized", "webhook signature does not match")
  }
  const event = request.headers.get("x-github-event")
  if (event === "ping") return new Response(null, { status: 200 })
  if (event !== "pull_request") return new Response(null, { status: 204 })
  const hookPayload = Schema.decodeUnknownEither(PullRequestWebhook)(payload)
  if (hookPayload._tag === "Left") return errorResponse(400, "BadRequest", "unexpected pull_request payload")
  const deliveryId = request.headers.get("x-github-delivery")
  if (deliveryId === null) return errorResponse(400, "BadRequest", "missing X-GitHub-Delivery")
  const result = await hub(env).githubDelivery(deliveryId, pullRequestEventOf(hookPayload.right))
  return json(result, 202)
}
