import { Schema } from "effect"
import { BOX_USER_HEADER, ControlPaths, Task, threadPullRequestsOf } from "@cloudagents/protocol"
import { ensureHook, releaseHook } from "./automations"
import { hub, type Env } from "./env"
import { enablePullRequestActivity, fetchPullRequest, fetchRepository } from "./github"
import { decodeBody, errorResponse, json } from "./http"

const Watch = Schema.Struct({ taskId: Schema.String, repo: Schema.String, number: Schema.Number.pipe(Schema.int(), Schema.positive()) })
const Unwatch = Schema.Struct({
  taskId: Schema.String,
  repo: Schema.optional(Schema.String),
  number: Schema.optional(Schema.Number.pipe(Schema.int(), Schema.positive())),
})

/**
 * Authenticated box calls only. A thread may watch any number of pull requests; each must be one the thread itself
 * owns (in `Task.pullRequests`), and the caller must be its owner.
 */
export const handlePrWatch = async (request: Request, env: Env, url: URL): Promise<Response> => {
  const login = request.headers.get(BOX_USER_HEADER) ?? ""
  if (!login || (await hub(env).getUser(login)) === null) return errorResponse(401, "Unauthorized", "unknown user")
  if (request.method === "DELETE") {
    const body = await decodeBody(request, Unwatch)
    if (body instanceof Response) return body
    if ((body.repo === undefined) !== (body.number === undefined)) {
      return errorResponse(400, "BadRequest", "name both repo and number, or neither to unwatch every pull request")
    }
    const repos = await hub(env).unwatchPullRequests(login, body.taskId, body.repo, body.number)
    for (const repo of repos) await releaseHook(env, login, repo)
    return new Response(null, { status: 204 })
  }
  if (request.method !== "POST") return errorResponse(405, "MethodNotAllowed", "POST or DELETE required")
  const body = await decodeBody(request, Watch)
  if (body instanceof Response) return body
  const token = (await hub(env).credentials(login)).github
  if (!token) return errorResponse(409, "Conflict", "connect GitHub to watch a pull request")
  const repo = await fetchRepository(token, body.repo)
  if (repo === null || await fetchPullRequest(token, repo, body.number) === null) return errorResponse(404, "NotFound", "pull request not found")
  const result = await hub(env).boxCall(login, "GET", `/api/tasks/${encodeURIComponent(body.taskId)}`)
  if (!result.ok) return errorResponse(404, "NotFound", "thread not found")
  let value: unknown
  try { value = JSON.parse(result.body) } catch { return errorResponse(502, "BadGateway", "invalid thread response") }
  const task = Schema.decodeUnknownEither(Task)(value)
  // Boxes that predate the thread registry keep the single link on their checkout; accept either shape while they update.
  const legacyOwned = task._tag === "Right" && (task.right.checkouts as ReadonlyArray<{ repo: string; pullRequest?: { number: number } }>).some(
    (checkout) => checkout.repo.toLowerCase() === repo.toLowerCase() && checkout.pullRequest?.number === body.number,
  )
  const owned = legacyOwned || (task._tag === "Right" && threadPullRequestsOf(task.right).some(
    (pr) => pr.repo.toLowerCase() === repo.toLowerCase() && pr.number === body.number,
  ))
  if (!owned) return errorResponse(409, "Conflict", "the thread does not own this pull request")
  if (task._tag === "Right" && task.right.archivedAt !== undefined) return errorResponse(409, "Conflict", "thread is archived")
  await ensureHook(env, token, repo, new URL(ControlPaths.githubWebhook, url.origin).toString())
  const hook = await hub(env).githubHook(repo.toLowerCase())
  if (hook === null) return errorResponse(502, "BadGateway", "could not register GitHub hook")
  await enablePullRequestActivity(token, repo, hook.hookId)
  await hub(env).watchPullRequest(login, body.taskId, repo, body.number)
  return json({ repo, number: body.number }, 201)
}
