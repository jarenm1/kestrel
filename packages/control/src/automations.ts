import { Schema } from "effect"
import {
  ControlPaths,
  CreateAutomationBody,
  Paths,
  Repo,
  TriggerAutomationBody,
  UpdateAutomationBody,
  type AutomationTrigger,
} from "@cloudagents/protocol"
import { scheduleProblem } from "./cron"
import { hub, type Env } from "./env"
import { errorResponse, json } from "./http"
import {
  createPullRequestHook,
  deletePullRequestHook,
  fetchPullRequest,
  parseGitHubSlug,
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

/** The project as the box reports it, if `login` owns it (only the owner can see or change its automations). */
const ownedRepo = async (env: Env, login: string, repoId: string): Promise<typeof Repo.Type | Response> => {
  const res = await hub(env).boxCall(login, "GET", Paths.repo(repoId))
  if (res.status === 404) return errorResponse(404, "NotFound", "unknown project")
  if (!res.ok) return errorResponse(502, "BadGateway", `agent box responded ${res.status}`)
  const repo = Schema.decodeUnknownEither(Repo)(parseJson(res.body))
  if (repo._tag === "Left" || repo.right.owner !== login) return errorResponse(404, "NotFound", "unknown project")
  return repo.right
}

/** Why a trigger cannot be saved for a project whose GitHub slug is `slug`, or null when it can. */
const triggerProblem = (trigger: AutomationTrigger, slug: string | null): string | null => {
  if (trigger._tag === "schedule") return scheduleProblem(trigger.cron, trigger.timezone, Date.now())
  return slug === null ? "GitHub triggers need a GitHub repository" : null
}

const githubToken = async (env: Env, login: string): Promise<string | Response> => {
  const creds = await hub(env).credentials(login)
  return creds.github ?? errorResponse(409, "Conflict", "connect GitHub to use GitHub triggers")
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
  const repo = await ownedRepo(env, login, body.repoId)
  if (repo instanceof Response) return repo
  const slug = parseGitHubSlug(repo.url)
  const problem = triggerProblem(body.trigger, slug)
  if (problem !== null) return badRequest(problem)
  const enabled = body.enabled ?? true
  if (enabled && body.trigger._tag === "github" && slug !== null) {
    const token = await githubToken(env, login)
    if (token instanceof Response) return token
    await ensureHook(env, token, slug, webhookUrl(url))
  }
  return json(await hub(env).createAutomation(login, { ...body, repo: slug }), 201)
}

const updateAutomation = async (request: Request, env: Env, login: string, url: URL, id: string): Promise<Response> => {
  const current = await hub(env).automation(login, id)
  if (current === null) return notFound()
  const body = await readBody(request, UpdateAutomationBody)
  if (body instanceof Response) return body
  const trigger = body.trigger ?? current.trigger
  const enabled = body.enabled ?? current.enabled
  if (body.trigger !== undefined) {
    const problem = triggerProblem(body.trigger, current.repo)
    if (problem !== null) return badRequest(problem)
  }
  const slug = current.repo
  const wasHooked = current.enabled && current.trigger._tag === "github" && slug !== null
  const needsHook = enabled && trigger._tag === "github" && slug !== null
  // Only a hook that must exist needs the owner's token; turning GitHub triggers off never does.
  if (needsHook) {
    const token = await githubToken(env, login)
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
    const token = await githubToken(env, login)
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

/** Every `/api/automations` route. Called after the session check; the webhook route is outside this. */
export const handleAutomations = async (request: Request, env: Env, login: string, url: URL): Promise<Response> => {
  const method = request.method
  if (url.pathname === ControlPaths.automations) {
    if (method === "GET") return json(await hub(env).automations(login))
    if (method === "POST") return createAutomation(request, env, login, url)
    return errorResponse(405, "MethodNotAllowed", `${method} not allowed`)
  }
  const match = /^\/api\/automations\/([^/]+)(\/runs|\/trigger)?$/.exec(url.pathname)
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
