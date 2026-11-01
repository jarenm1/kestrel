import { Schema } from "effect"
import { BOX_USER_HEADER, ControlPaths, Task } from "@cloudagents/protocol"
import { ensureHook, releaseHook } from "./automations"
import { hub, type Env } from "./env"
import { enablePullRequestActivity, fetchPullRequest, fetchRepository } from "./github"
import { decodeBody, errorResponse, json } from "./http"

const Watch = Schema.Struct({ taskId: Schema.String, repo: Schema.String, number: Schema.Number.pipe(Schema.int(), Schema.positive()) })
const Unwatch = Schema.Struct({ taskId: Schema.String })

/** Authenticated box calls only: the named thread must belong to the caller and have exactly this checkout. */
export const handlePrWatch = async (request: Request, env: Env, url: URL): Promise<Response> => {
  const login = request.headers.get(BOX_USER_HEADER) ?? ""
  if (!login || (await hub(env).getUser(login)) === null) return errorResponse(401, "Unauthorized", "unknown user")
  if (request.method === "DELETE") {
    const body = await decodeBody(request, Unwatch)
    if (body instanceof Response) return body
    const old = await hub(env).watchedRepository(login, body.taskId)
    await hub(env).unwatchPullRequest(login, body.taskId)
    if (old !== null) await releaseHook(env, login, old)
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
  if (task._tag === "Left" || task.right.checkouts.length !== 1 || task.right.checkouts[0]?.repo.toLowerCase() !== repo.toLowerCase() || task.right.checkouts[0]?.pullRequest?.number !== body.number) {
    return errorResponse(409, "Conflict", "thread must have one checkout linked to this pull request")
  }
  if (task.right.archivedAt !== undefined) return errorResponse(409, "Conflict", "thread is archived")
  await ensureHook(env, token, repo, new URL(ControlPaths.githubWebhook, url.origin).toString())
  const hook = await hub(env).githubHook(repo.toLowerCase())
  if (hook === null) return errorResponse(502, "BadGateway", "could not register GitHub hook")
  await enablePullRequestActivity(token, repo, hook.hookId)
  const old = await hub(env).watchedRepository(login, body.taskId)
  await hub(env).watchPullRequest(login, body.taskId, repo, body.number)
  if (old !== null && old.toLowerCase() !== repo.toLowerCase()) await releaseHook(env, login, old)
  return json({ repo, number: body.number }, 201)
}
