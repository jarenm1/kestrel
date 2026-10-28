import { Schema } from "effect"
import {
  BOX_USER_HEADER,
  ControlPaths,
  CreateAutomationBody,
  TriggerAutomationBody,
  UpdateAutomationBody,
  type AutomationTrigger,
} from "@cloudagents/protocol"
import { triggerProblem } from "./automation-rules"
import { hub, type Env } from "./env"
import { errorResponse, json } from "./http"
import {
  createPullRequestHook,
  deletePullRequestHook,
  fetchPullRequest,
  fetchRepository,
  pullRequestHookExists,
  type PullRequestInfo,
} from "./github"

const badRequest = (message: string): Response => errorResponse(400, "BadRequest", message)
const notFound = (): Response => errorResponse(404, "NotFound", "no such automation")

const parseJson = (text: string): unknown => {
  try {
    return JSON.parse(text)
  } catch {
    return undefined
  }
}

/** Decodes a JSON request body; an empty body counts as `{}` when `emptyOk`. Returns the error response instead on failure. */
const readBody = async <A, I>(
  request: Request,
  schema: Schema.Schema<A, I>,
  emptyOk = false,
): Promise<A | Response> => {
  const text = await request.text()
  const decoded = Schema.decodeUnknownEither(schema)(parseJson(text === "" && emptyOk ? "{}" : text))
  return decoded._tag === "Left" ? badRequest("invalid request body") : decoded.right
}

const githubToken = async (env: Env, login: string, message: string): Promise<string | Response> => {
  const creds = await hub(env).credentials(login)
  return creds.github ?? errorResponse(409, "Conflict", message)
}

const webhookUrl = (url: URL): string => new URL(ControlPaths.githubWebhook, url.origin).toString()

/**
 * Makes sure the repository has a `pull_request` webhook pointing here. One hook per repository serves every
 * automation on it; the secret stays in the Hub and is only used to verify deliveries.
 */
const ensureHook = async (env: Env, token: string, slug: string, url: string): Promise<void> => {
  const key = slug.toLowerCase()
  const existing = await hub(env).githubHook(key)
  if (existing !== null && (await pullRequestHookExists(token, slug, existing.hookId))) return
  const bytes = crypto.getRandomValues(new Uint8Array(32))
  const secret = Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("")
  const hookId = await createPullRequestHook(token, slug, url, secret)
  const stored = await hub(env).claimGithubHook(key, existing?.hookId ?? null, hookId, secret)
  if (stored.hookId === hookId) return
  // A concurrent request stored its own hook first, so ours is unused: remove it (best-effort).
  try {
    await deletePullRequestHook(token, slug, hookId)
  } catch (err) {
    console.error(`removing an unused webhook on ${slug} failed: ${err instanceof Error ? err.message : "unknown error"}`)
  }
}

/**
 * Removes the repository's webhook once no enabled GitHub automation needs it. Runs after the Hub has saved the
 * change, so a failure is logged instead of failing the request; the hook then stays for a later ensureHook to
 * reuse. Without a GitHub connection nothing is removed.
 */
const releaseHook = async (env: Env, login: string, slug: string): Promise<void> => {
  const key = slug.toLowerCase()
  try {
    if (await hub(env).githubHookInUse(key)) return
    const token = (await hub(env).credentials(login)).github
    const hook = await hub(env).githubHook(key)
    if (token === undefined || hook === null) return
    await deletePullRequestHook(token, slug, hook.hookId)
    await hub(env).deleteGithubHook(key)
  } catch (err) {
    console.error(`removing the webhook on ${slug} failed: ${err instanceof Error ? err.message : "unknown error"}`)
  }
}

const createAutomation = async (request: Request, env: Env, login: string, url: URL): Promise<Response> => {
  const body = await readBody(request, CreateAutomationBody)
  if (body instanceof Response) return body
  const problem = triggerProblem(body.trigger, body.repo ?? null, Date.now())
  if (problem !== null) return badRequest(problem)
  if (body.repo === undefined) return json(await hub(env).createAutomation(login, { ...body, repo: null }), 201)
  const token = await githubToken(env, login, "connect GitHub to use repositories")
  if (token instanceof Response) return token
  // The owner's GitHub token must be able to read the repository; the stored name is GitHub's canonical casing.
  const repo = await fetchRepository(token, body.repo)
  if (repo === null) return errorResponse(404, "NotFound", "unknown repository")
  if ((body.enabled ?? true) && body.trigger._tag === "github") {
    await ensureHook(env, token, repo, webhookUrl(url))
  }
  return json(await hub(env).createAutomation(login, { ...body, repo }), 201)
}

const updateAutomation = async (request: Request, env: Env, login: string, url: URL, id: string): Promise<Response> => {
  const current = await hub(env).automation(login, id)
  if (current === null) return notFound()
  const body = await readBody(request, UpdateAutomationBody)
  if (body instanceof Response) return body
  const trigger = body.trigger ?? current.trigger
  const enabled = body.enabled ?? current.enabled
  if (body.trigger !== undefined) {
    const problem = triggerProblem(body.trigger, current.repo, Date.now())
    if (problem !== null) return badRequest(problem)
  }
  const slug = current.repo
  const wasHooked = current.enabled && current.trigger._tag === "github" && slug !== null
  const needsHook = enabled && trigger._tag === "github" && slug !== null
  // Only a hook that must exist needs the owner's token; turning GitHub triggers off never does.
  if (needsHook) {
    const token = await githubToken(env, login, "connect GitHub to use GitHub triggers")
    if (token instanceof Response) return token
    await ensureHook(env, token, slug, webhookUrl(url))
  }
  const updated = await hub(env).updateAutomation(login, id, body)
  if (updated === null) return notFound()
  if (slug !== null && wasHooked && !needsHook) await releaseHook(env, login, slug)
  return json(updated)
}

const deleteAutomation = async (env: Env, login: string, id: string): Promise<Response> => {
  const current = await hub(env).automation(login, id)
  if (current === null) return notFound()
  await hub(env).deleteAutomation(login, id)
  if (current.enabled && current.trigger._tag === "github" && current.repo !== null) {
    await releaseHook(env, login, current.repo)
  }
  return new Response(null, { status: 204 })
}

/**
 * "Run now". A GitHub automation needs the pull request to review (fetched with the owner's token so the
 * reason and PR details match what a webhook delivery would produce); a schedule runs as a plain manual run.
 */
const triggerAutomation = async (request: Request, env: Env, login: string, id: string): Promise<Response> => {
  const current = await hub(env).automation(login, id)
  if (current === null) return notFound()
  const body = await readBody(request, TriggerAutomationBody, true)
  if (body instanceof Response) return body
  let reason = "manual"
  let pr: PullRequestInfo | null = null
  if (current.trigger._tag === "github") {
    if (body.pullRequest === undefined) return badRequest("pullRequest is required for GitHub automations")
    const slug = current.repo
    if (slug === null) return badRequest("GitHub triggers need a GitHub repository")
    const token = await githubToken(env, login, "connect GitHub to use GitHub triggers")
    if (token instanceof Response) return token
    pr = await fetchPullRequest(token, slug, body.pullRequest)
    if (pr === null) return errorResponse(404, "NotFound", `pull request #${body.pullRequest} not found`)
    reason = `manual #${body.pullRequest}`
  } else if (body.pullRequest !== undefined) {
    return badRequest("pullRequest only applies to GitHub automations")
  }
  const run = await hub(env).fireAutomation(login, id, reason, pr)
  return run === null ? notFound() : json(run, 201)
}

/**
 * Every automation route under `base` (`/api/automations` for the browser, `/box/automations` for the box). Called
 * after the caller's auth check; the webhook route is outside this.
 */
export const handleAutomations = async (
  request: Request,
  env: Env,
  login: string,
  url: URL,
  base: string,
): Promise<Response> => {
  const method = request.method
  if (url.pathname === base) {
    if (method === "GET") return json(await hub(env).automations(login))
    if (method === "POST") return createAutomation(request, env, login, url)
    return errorResponse(405, "MethodNotAllowed", `${method} not allowed`)
  }
  const match = new RegExp(`^${base}/([^/]+)(/runs|/trigger)?$`).exec(url.pathname)
   if (match === null) return errorResponse(404, "NotFound", "no such route")
  const [, id = "", suffix] = match
  if (suffix === "/runs" && method === "GET") {
    const runs = await hub(env).automationRuns(login, id)
    return runs === null ? notFound() : json(runs)
  }
  if (suffix === "/trigger" && method === "POST") return triggerAutomation(request, env, login, id)
  if (suffix === undefined && method === "GET") {
    const automation = await hub(env).automation(login, id)
    return automation === null ? notFound() : json(automation)
  }
  if (suffix === undefined && method === "PATCH") return updateAutomation(request, env, login, url, id)
  if (suffix === undefined && method === "DELETE") return deleteAutomation(env, login, id)
  return errorResponse(405, "MethodNotAllowed", `${method} not allowed`)
}

/**
 * Every `/box/automations` route. The box holds BOX_TOKEN (checked by the caller) and names the user it acts for in
 * BOX_USER_HEADER; that user must exist. Ownership is then enforced by the same handlers the browser uses.
 */
export const handleBoxAutomations = async (request: Request, env: Env, url: URL): Promise<Response> => {
  const login = request.headers.get(BOX_USER_HEADER) ?? ""
  if (login === "") return errorResponse(400, "BadRequest", `${BOX_USER_HEADER} header is required`)
  if ((await hub(env).getUser(login)) === null) return errorResponse(401, "Unauthorized", "unknown user")
  return handleAutomations(request, env, login, url, ControlPaths.boxAutomations)
}
