import { Schema } from "effect"
import { BOX_USER_HEADER, ControlPaths, Task } from "@cloudagents/protocol"
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

const BoxError = Schema.Struct({ message: Schema.String })

/**
 * A failed box call. A box error body with a `message` passes through with its status, so the caller keeps the box's
 * detail, including a structured `NotFound`. Anything else, such as a proxy's HTML error page, keeps its status but is
 * labelled `BadGateway` (a bare 404 from a proxy does not mean the thread is missing). Only the hub's own `BoxOffline`
 * bodies carry that tag: a bare gateway status does not establish that the box is unreachable.
 */
const boxFailure = (result: { status: number; body: string }): Response => {
  let value: unknown
  try { value = JSON.parse(result.body) } catch { value = undefined }
  if (Schema.is(BoxError)(value)) return new Response(result.body, { status: result.status, headers: { "content-type": "application/json" } })
  return errorResponse(result.status, "BadGateway", "agent box request failed")
}

/**
 * Authenticated box calls only. A thread may watch any number of pull requests, each in any repository its owner can
 * see; the caller must own the thread and the thread must not be archived.
 *
 * Ownership is the owner's GitHub access plus the box's own registry: a watch names a pull request the owner's GitHub
 * token can read (`fetchRepository`/`fetchPullRequest`), and the box records it in `Task.pullRequests` only once this
 * route accepts it. The control plane does not re-check that registry: it is written after the decision, so a check
 * here would reject every new watch — or, if the box recorded it first, be satisfied by the watch request itself.
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
  if (!result.ok) return boxFailure(result)
  let value: unknown
  try { value = JSON.parse(result.body) } catch { return errorResponse(502, "BadGateway", "invalid thread response") }
  const task = Schema.decodeUnknownEither(Task)(value)
  if (task._tag === "Left") return errorResponse(502, "BadGateway", "invalid thread response")
  if (task.right.archivedAt !== undefined) return errorResponse(409, "Conflict", "thread is archived")
  await ensureHook(env, token, repo, new URL(ControlPaths.githubWebhook, url.origin).toString())
  const hook = await hub(env).githubHook(repo.toLowerCase())
  if (hook === null) return errorResponse(502, "BadGateway", "could not register GitHub hook")
  await enablePullRequestActivity(token, repo, hook.hookId)
  await hub(env).watchPullRequest(login, body.taskId, repo, body.number)
  return json({ repo, number: body.number }, 201)
}
