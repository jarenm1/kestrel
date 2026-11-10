import { Effect, Schema } from "effect"
import { HttpApp, HttpMiddleware, HttpRouter, HttpServerRequest, HttpServerResponse } from "@effect/platform"
import { BOX_API, BOX_USER_HEADER, BadRequest, CliLoginCodeBody, CliProvider, CliSelectAccountBody, Conflict, CreateTaskBody, ForkTaskBody, Health, InternalError, NotFound, PutApiKeyBody, SendMessageBody, SetDesktopQualityBody, AgentModel, UseBankedResetBody, type FileRoot } from "@cloudagents/protocol"
import { Paths, SetPullRequestWatchingBody, SetUsageLimitAutoResumeBody, TextGenerationSettings, ThreadPullRequestAction, ThreadSettings } from "@cloudagents/protocol"
import { Readable } from "node:stream"
import { VERSION } from "../config"
import type { BoxCapabilities } from "@cloudagents/protocol"
import type { CliAuthShape } from "../cliauth"
import type { CoreShape } from "../core/service"
import type { ModelDiscoveryShape } from "../model-discovery"
import { dayFormat } from "../core/activity"
import { BOX_DEV_HEADER } from "../tunnel"

type ApiError = NotFound | BadRequest | Conflict | InternalError

const statusOf = (e: ApiError): number => {
  switch (e._tag) {
    case "NotFound":
      return 404
    case "BadRequest":
      return 400
    case "Conflict":
      return 409
    case "InternalError":
      return 500
  }
}

const errorResponse = (e: ApiError) =>
  HttpServerResponse.unsafeJson({ _tag: e._tag, message: e.message }, { status: statusOf(e) })

/** Turns a service result into a JSON response; failures become the tagged error body with its status. */
const respond = <A, R>(effect: Effect.Effect<A, ApiError, R>): Effect.Effect<HttpServerResponse.HttpServerResponse, never, R> =>
  effect.pipe(
    Effect.map((body) => HttpServerResponse.unsafeJson(body)),
    Effect.catchAll((e) => Effect.succeed(errorResponse(e))),
  )

/** Like `respond` for operations that return no body; success is 204. */
const noContent = <R>(effect: Effect.Effect<void, ApiError, R>): Effect.Effect<HttpServerResponse.HttpServerResponse, never, R> =>
  effect.pipe(
    Effect.map(() => HttpServerResponse.empty({ status: 204 })),
    Effect.catchAll((e) => Effect.succeed(errorResponse(e))),
  )

/**
 * Decodes the JSON request body with `schema`. An empty body decodes as `{}`, so bodies are
 * optional where the schema allows it.
 */
const jsonBody = <A, I>(schema: Schema.Schema<A, I, never>): Effect.Effect<A, BadRequest, HttpServerRequest.HttpServerRequest> =>
  Effect.gen(function* () {
    const req = yield* HttpServerRequest.HttpServerRequest
    const text = yield* req.text.pipe(
      Effect.mapError(() => new BadRequest({ message: "cannot read request body" })),
    )
    return yield* Schema.decodeUnknown(Schema.parseJson(schema))(text.trim() === "" ? "{}" : text).pipe(
      Effect.mapError((e) => new BadRequest({ message: `invalid request body: ${e.message}` })),
    )
  })

/**
 * The raw bytes of an uploaded file: the body, its `Content-Type` (required; parameters such as `charset` are
 * dropped), and the optional `name` query parameter. Read whole; the core refuses anything over `MAX_ATTACHMENT_BYTES`.
 */
const uploadInput = Effect.gen(function* () {
  const req = yield* HttpServerRequest.HttpServerRequest
  const mimeType = (req.headers["content-type"] ?? "").split(";")[0]!.trim().toLowerCase()
  if (mimeType === "") {
    return yield* Effect.fail(new BadRequest({ message: "content-type is required" }))
  }
  const bytes = yield* req.arrayBuffer.pipe(Effect.mapError(() => new BadRequest({ message: "cannot read request body" })))
  const params = new URL(req.url, "http://localhost").searchParams
  const name = params.get("name") ?? undefined
  const operationId = params.get("operationId") ?? undefined
  return { mimeType, name, operationId, bytes: new Uint8Array(bytes) }
})

const pathId = Effect.map(HttpRouter.params, (p) => p.id ?? "")

/** The user the relay signed in for this request (relay-set header, stripped on the box's own port); null otherwise. */
const requestUser = Effect.map(HttpServerRequest.HttpServerRequest, (req) => {
  const user = req.headers[BOX_USER_HEADER]
  return user === undefined || user === "" ? null : user
})

/** `/auth/dev-login` sessions may use dev-only flows (a `/replay` chat message); the relay marks them. */
const requestIsDev = Effect.map(
  HttpServerRequest.HttpServerRequest,
  (req) => req.headers[BOX_DEV_HEADER] === "1",
)

/** Runs `f` for the signed-in user; a request without one is refused. */
const signedIn = <A, R>(f: (user: string) => Effect.Effect<A, ApiError, R>) =>
  Effect.flatMap(requestUser, (user) =>
    user === null ? Effect.fail(new BadRequest({ message: "no signed-in user" })) : f(user),
  )

/** The provider named in the path; anything else is refused. */
const cliProvider = Effect.flatMap(HttpRouter.params, (p) =>
  Schema.decodeUnknown(CliProvider)(p.provider ?? "").pipe(Effect.mapError(() => new BadRequest({ message: "unknown provider" }))),
)

/** The frozen provider catalog accepted by clients installed before OpenCode Go and the Console login. */
const legacyCliProviders: Readonly<Record<string, true>> = { "claude-cli": true, "codex-cli": true, "antigravity-cli": true }

/** A client advertises the provider literals it can decode; omitting the query keeps the installed-client contract. */
const cliArray = <A extends { readonly provider: CliProvider }>(rows: readonly A[]) =>
  Effect.map(HttpServerRequest.HttpServerRequest, (req) => {
    const advertised = new URL(req.url, "http://localhost").searchParams.get("providers")
    const accepted = advertised === null ? null : new Set(advertised.split(","))
    return rows.filter((row) => accepted === null ? legacyCliProviders[row.provider] === true : accepted.has(row.provider))
  })

/** The composer's chosen model (`?model=`); the box resolves the harness that will actually run. */
const chosenModel = Effect.gen(function* () {
  const req = yield* HttpServerRequest.HttpServerRequest
  const raw = new URL(req.url, "http://localhost").searchParams.get("model") ?? ""
  if (raw === "") return yield* Effect.fail(new BadRequest({ message: "model is required" }))
  return yield* Schema.decodeUnknown(AgentModel)(raw).pipe(
    Effect.mapError(() => new BadRequest({ message: `unknown model "${raw}"` })),
  )
})

/** The query parameters of the request. */
const searchParams = Effect.map(HttpServerRequest.HttpServerRequest, (req) => new URL(req.url, "http://localhost").searchParams)

/** `?tz=`: the IANA time zone to count days in; an unknown zone is refused. */
const timeZone = Effect.flatMap(searchParams, (params) => {
  const zone = params.get("tz") ?? ""
  return Effect.try({
    try: () => dayFormat(zone).resolvedOptions().timeZone,
    catch: () => new BadRequest({ message: `unknown time zone "${zone}"` }),
  })
})

/** `?root=workspace|home`, or `?root=checkout&checkout=<id>` (`Paths.taskFileDownload`). */
const fileRoot = (params: URLSearchParams): Effect.Effect<FileRoot, BadRequest> => {
  const root = params.get("root")
  const checkoutId = params.get("checkout") ?? ""
  if (root === "workspace" || root === "home") return Effect.succeed(root)
  if (root === "checkout" && checkoutId !== "") return Effect.succeed({ checkoutId })
  return Effect.fail(new BadRequest({ message: "root must be workspace, home or checkout (with checkout=<id>)" }))
}

/** `?repo=` and `?number=` of a pull request route. */
const pullRequestQuery = (params: URLSearchParams): Effect.Effect<{ readonly repo: string; readonly number: number }, BadRequest> => {
  const repo = params.get("repo") ?? ""
  if (repo === "") return Effect.fail(new BadRequest({ message: "repo is required" }))
  const number = Number(params.get("number") ?? "")
  if (!Number.isSafeInteger(number) || number <= 0) {
    return Effect.fail(new BadRequest({ message: "number must be a positive integer" }))
  }
  return Effect.succeed({ repo, number })
}

/** What the REST API needs from outside the core, such as the control plane that routes a watched pull request's activity. */
export interface RouterHooks {
  /**
   * Tells the control plane to route a pull request's activity to the thread, or to stop. Null on a box that has no
   * control plane; watching then has nowhere to go.
   */
  readonly watchPullRequest:
    | ((user: string, taskId: string, repo: string, number: number, watching: boolean) => Effect.Effect<void, { readonly message: string }>)
    | null
}

const NO_HOOKS: RouterHooks = { watchPullRequest: null }

/**
 * Applies a view action; a watch also tells the control plane, when this box has one. Ownership is checked before the
 * control plane is told, so a pull request the thread does not own never leaves a watch route behind. The control
 * plane learns first and the registry second; a failed registry write puts back the watching state the registry had
 * before the request and the original failure surfaces.
 */
const applyPullRequestAction = (core: CoreShape, hooks: RouterHooks, user: string, taskId: string, action: ThreadPullRequestAction) =>
  action.action === "watch"
    ? Effect.gen(function* () {
        const watch = hooks.watchPullRequest
        if (watch === null) {
          return yield* Effect.fail(new BadRequest({ message: "this box has no control plane to watch pull requests with" }))
        }
        const before = yield* core.requireOwnedPullRequest(user, taskId, action.repo, action.number)
        yield* watch(user, taskId, action.repo, action.number, action.watching).pipe(
          Effect.mapError((e) => new InternalError({ message: e.message })),
        )
        return yield* core.actOnPullRequest(user, taskId, action).pipe(
          // The registry still says what it said before the request, so the control plane must say that too: the
          // watch is an idempotent upsert, and reverting to the request's own state would undo a watch the registry
          // keeps (or re-add one it never had).
          Effect.catchAll((e) =>
            watch(user, taskId, action.repo, action.number, before.watching).pipe(
              Effect.catchAll(() => Effect.void),
              Effect.zipRight(Effect.fail(e)),
            ),
          ),
        )
      })
    : core.actOnPullRequest(user, taskId, action)

/**
 * Streams one of the thread's files as a download. The agent wrote it, so whatever it is, it never renders as a page
 * on the app's origin: always `application/octet-stream`, an attachment, in a sandbox. `headOnly` answers with the
 * headers alone, so the app can learn whether the download would succeed (and through the relay, whether it fits)
 * before handing the URL to the browser.
 */
const serveDownload = (core: CoreShape, taskId: string, headOnly: boolean) =>
  Effect.gen(function* () {
    const params = yield* searchParams
    const root = yield* fileRoot(params)
    const path = params.get("path") ?? ""
    const { handle, size } = yield* signedIn((user) => core.download(user, taskId, root, path))
    const name = path.slice(path.lastIndexOf("/") + 1)
    let body: BodyInit | null = null
    if (headOnly || size === 0) {
      yield* Effect.promise(() => handle.close())
    } else {
      // Exactly the `size` bytes declared: the agent may still be writing the file, and a body longer than its
      // Content-Length breaks the response. One that shrank since ends short, and the download fails rather than
      // pretending to be whole. The stream closes the file when it ends, fails, or the client goes away. It is a
      // `node:stream/web` stream, which TypeScript does not see as the global `ReadableStream`, though it is one.
      body = Readable.toWeb(handle.createReadStream({ start: 0, end: size - 1 })) as unknown as BodyInit
    }
    return HttpServerResponse.fromWeb(
      new Response(body, {
        headers: {
          "content-type": "application/octet-stream",
          "content-length": String(size),
          "content-disposition": `attachment; filename*=UTF-8''${encodeURIComponent(name)}`,
          "content-security-policy": "sandbox",
          "x-content-type-options": "nosniff",
          "cache-control": "no-store",
        },
      }),
    )
  }).pipe(Effect.catchAll((e) => Effect.succeed(errorResponse(e))))

/** GET downloads a thread file; HEAD answers the same headers without the body. */
const downloadRoutes = (core: CoreShape) =>
  HttpRouter.empty.pipe(
    HttpRouter.get("/api/tasks/:id/files/download", Effect.flatMap(pathId, (id) => serveDownload(core, id, false))),
    HttpRouter.head("/api/tasks/:id/files/download", Effect.flatMap(pathId, (id) => serveDownload(core, id, true))),
  )

const servePreview = (core: CoreShape, taskId: string) =>
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest
    const webRequest = yield* HttpServerRequest.toWeb(request).pipe(
      Effect.mapError(() => new BadRequest({ message: "cannot read preview request" })),
    )
    const user = yield* requestUser
    if (user === null) return errorResponse(new BadRequest({ message: "no signed-in user" }))
    return yield* core.previewRequest(user, taskId, webRequest).pipe(
      Effect.map(HttpServerResponse.fromWeb),
      Effect.catchAll((e) => Effect.succeed(errorResponse(e))),
    )
  })

export const makeRouter = (
  core: CoreShape,
  cliAuth: CliAuthShape,
  capabilities: BoxCapabilities,
  models: ModelDiscoveryShape,
  hooks: RouterHooks = NO_HOOKS,
) =>
  HttpRouter.empty.pipe(
    HttpRouter.get(
      "/api/health",
      Effect.succeed(HttpServerResponse.unsafeJson(Schema.decodeSync(Health)({ ok: true, version: VERSION, api: BOX_API }))),
    ),
    // Sandbox and desktop posture of this box: a signed-in user only, unlike health. 401 when no user is presented.
    HttpRouter.get(
      "/api/capabilities",
      requestUser.pipe(
        Effect.flatMap((user) =>
          Effect.succeed(
            user === null
              ? HttpServerResponse.unsafeJson({ _tag: "Unauthorized", message: "no signed-in user" }, { status: 401 })
              : HttpServerResponse.unsafeJson(capabilities),
          ),
        ),
      ),
    ),
    // The box's runtime model catalog: curated models plus what this owner's credentials/native logins enumerate.
    // `?refresh=1` bypasses the owner's cache; per-source failures stay in `sources`, never a 5xx catalog.
    HttpRouter.get(
      Paths.models,
      Effect.gen(function* () {
        const user = yield* requestUser
        if (user === null) {
          return HttpServerResponse.unsafeJson({ _tag: "Unauthorized", message: "no signed-in user" }, { status: 401 })
        }
        const refresh = (yield* searchParams).get("refresh") === "1"
        return HttpServerResponse.unsafeJson(yield* models.get(user, { refresh }))
      }),
    ),
    HttpRouter.get(
      Paths.textGenerationSettings,
      respond(signedIn((user) => core.getTextGenerationSettings(user))),
    ),
    HttpRouter.put(
      Paths.textGenerationSettings,
      respond(signedIn((user) =>
        Effect.flatMap(jsonBody(TextGenerationSettings), (settings) => core.setTextGenerationSettings(user, settings)),
      )),
    ),
    HttpRouter.get(
      Paths.threadSettings,
      respond(signedIn((user) => core.getThreadSettings(user))),
    ),
    HttpRouter.put(
      Paths.threadSettings,
      respond(signedIn((user) =>
        Effect.flatMap(jsonBody(ThreadSettings), (settings) => core.setThreadSettings(user, settings)),
      )),
    ),
    // Agent CLI sign-ins of the signed-in user on the box (Connections page); never tokens.
    HttpRouter.get("/api/cli-auth", respond(signedIn((user) => cliAuth.status(user).pipe(Effect.flatMap(cliArray))))),
    HttpRouter.get("/api/cli-auth/usage", respond(signedIn((user) => cliAuth.providerUsage(user).pipe(Effect.flatMap(cliArray))))),
    HttpRouter.post(
      "/api/cli-auth/:provider/login",
      respond(Effect.flatMap(cliProvider, (provider) => signedIn((user) => cliAuth.startLogin(user, provider)))),
    ),
    // Stops a sign-in the user backed out of; its unfinished login home goes with it.
    HttpRouter.post(
      "/api/cli-auth/:provider/login/cancel",
      noContent(Effect.flatMap(cliProvider, (provider) => signedIn((user) => cliAuth.cancelLogin(user, provider)))),
    ),
    HttpRouter.post(
      "/api/cli-auth/:provider/code",
      respond(
        Effect.flatMap(cliProvider, (provider) =>
          signedIn((user) =>
            Effect.flatMap(jsonBody(CliLoginCodeBody), (body) =>
              cliAuth.submitCode(user, provider, body.code, body.accountId),
            ),
          ),
        ),
      ),
    ),
    // Selects the account runs, usage and discovery use for this provider; only a connected login may be chosen.
    HttpRouter.post(
      "/api/cli-auth/:provider/account",
      respond(
        Effect.flatMap(cliProvider, (provider) =>
          signedIn((user) =>
            Effect.flatMap(jsonBody(CliSelectAccountBody), (body) =>
              cliAuth.selectAccount(user, provider, body.accountId),
            ),
          ),
        ),
      ),
    ),
    HttpRouter.post(
      "/api/cli-auth/:provider/key",
      respond(
        Effect.flatMap(cliProvider, (provider) =>
          signedIn((user) =>
            Effect.flatMap(
              jsonBody(PutApiKeyBody).pipe(Effect.mapError(() => new BadRequest({ message: "invalid API key request" }))),
              (body) => cliAuth.submitKey(user, provider, body.apiKey),
            ),
          ),
        ),
      ),
    ),
    HttpRouter.post(
      "/api/cli-auth/:provider/banked-resets/use",
      respond(
        Effect.flatMap(cliProvider, (provider) =>
          signedIn((user) =>
            Effect.flatMap(jsonBody(UseBankedResetBody), (body) =>
              cliAuth.useBankedReset(user, provider, body.resetId),
            ),
          ),
        ),
      ),
    ),
    HttpRouter.del(
      "/api/cli-auth/:provider",
      noContent(
        Effect.flatMap(cliProvider, (provider) =>
          Effect.flatMap(searchParams, (params) =>
            signedIn((user) => cliAuth.logout(user, provider, params.get("accountId") ?? undefined)),
          ),
        ),
      ),
    ),
  ).pipe(
    // Threads of the signed-in user, archived ones included; core answers NotFound for anyone else's.
    HttpRouter.get("/api/tasks", respond(signedIn((user) => core.listTasks(user)))),
    HttpRouter.post(
      "/api/tasks",
      respond(signedIn((user) => Effect.flatMap(jsonBody(CreateTaskBody), (body) => core.createTask(user, body)))),
    ),

    HttpRouter.get(
      "/api/tasks/:id",
      Effect.flatMap(pathId, (id) => respond(signedIn((user) => core.getTask(user, id)))),
    ),
    HttpRouter.del(
      "/api/tasks/:id",
      Effect.flatMap(pathId, (id) => noContent(signedIn((user) => core.deleteTask(user, id)))),
    ),
    HttpRouter.post(
      "/api/tasks/:id/archive",
      Effect.flatMap(pathId, (id) => respond(signedIn((user) => core.archiveTask(user, id)))),
    ),
    HttpRouter.del(
      "/api/tasks/:id/archive",
      Effect.flatMap(pathId, (id) => respond(signedIn((user) => core.unarchiveTask(user, id)))),
    ),
    HttpRouter.post(
      "/api/tasks/:id/fork",
      Effect.flatMap(pathId, (id) =>
        respond(signedIn((user) => Effect.flatMap(jsonBody(ForkTaskBody), (body) => core.forkTask(user, id, body.messageId)))),
      ),
    ),
    HttpRouter.get(
      "/api/tasks/:id/messages",
      Effect.flatMap(pathId, (id) => respond(signedIn((user) => core.listMessages(user, id)))),
    ),
    HttpRouter.post(
      "/api/tasks/:id/delegations/:childId/cancel",
      Effect.flatMap(HttpRouter.params, (p) => respond(signedIn((user) =>
        Effect.zipRight(core.getTask(user, p.id ?? ""), core.cancelDelegation(p.id ?? "", p.childId ?? "")).pipe(Effect.map((status) => status.task)),
      ))),
    ),
    HttpRouter.put(
      "/api/tasks/:id/usage-limit",
      Effect.flatMap(pathId, (id) =>
        respond(
          signedIn((user) =>
            Effect.flatMap(jsonBody(SetUsageLimitAutoResumeBody), (body) =>
              core.setUsageLimitAutoResume(user, id, body.autoResume),
            ),
          ),
        ),
      ),
    ),
    // Real commands of the harness the thread's next message runs on, discovered in the thread workspace.
    HttpRouter.get(
      "/api/tasks/:id/commands",
      Effect.flatMap(pathId, (id) =>
        respond(signedIn((user) => Effect.flatMap(chosenModel, (model) => core.commands(user, id, model)))),
      ),
    ),
    HttpRouter.post(
      "/api/tasks/:id/messages",
      Effect.flatMap(pathId, (id) =>
        respond(
          Effect.flatMap(requestIsDev, (dev) =>
            signedIn((user) =>
              Effect.flatMap(jsonBody(SendMessageBody), (body) =>
                core.sendMessage(user, id, body.text, { model: body.model, effort: body.effort }, body.attachments ?? [], dev),
              ),
            ),
          ),
        ),
      ),
    ),
    HttpRouter.post(
      "/api/tasks/:id/github-activity",
      Effect.flatMap(pathId, (id) => noContent(signedIn((user) => Effect.flatMap(
        jsonBody(Schema.Struct({ repo: Schema.String, number: Schema.Number, kind: Schema.String, deliveryId: Schema.String })),
        (body) => core.githubActivity(user, id, body.repo, body.number, body.kind, body.deliveryId),
      )))),
    ),
    // The control plane dropped a watch (its pull request closed on GitHub): clear the registry's watch mark. A late or
    // repeated call is a no-op; the entry stays because the thread still manages the pull request.
    HttpRouter.post(
      "/api/tasks/:id/pull-request/watching",
      Effect.flatMap(pathId, (id) => noContent(signedIn((user) => Effect.flatMap(
        jsonBody(SetPullRequestWatchingBody),
        (body) => Effect.zipRight(
          core.getTask(user, id),
          // The control plane only sends `watching: false`; `true` is not this route's business.
          body.watching ? Effect.void : core.forgetPullRequestWatch(id, body.repo, body.number),
        ),
      )))),
    ),
    HttpRouter.post(
      "/api/tasks/:id/uploads",
      Effect.flatMap(pathId, (id) =>
        respond(signedIn((user) => Effect.flatMap(uploadInput, (input) => core.upload(user, id, input)))),
      ),
    ),
    HttpRouter.get(
      "/api/tasks/:id/runs",
      Effect.flatMap(pathId, (id) => respond(signedIn((user) => core.listRuns(user, id)))),
    ),
    HttpRouter.get("/api/usage", respond(signedIn((user) => core.usage(user, new Date())))),
    HttpRouter.get(
      "/api/usage/activity",
      respond(signedIn((user) => Effect.flatMap(timeZone, (zone) => core.usageActivity(user, new Date(), zone)))),
    ),
    HttpRouter.post(
      "/api/runs/:id/cancel",
      Effect.flatMap(pathId, (id) => respond(signedIn((user) => core.cancelRun(user, id)))),
    ),
  ).pipe(
    HttpRouter.get(
      "/api/runs/:id/items",
      Effect.flatMap(pathId, (id) => respond(signedIn((user) => core.runItems(user, id)))),
    ),
    HttpRouter.get(
      "/api/tasks/:id/diff",
      Effect.flatMap(pathId, (id) => respond(signedIn((user) => core.diff(user, id)))),
    ),
    HttpRouter.get(
      "/api/tasks/:id/files",
      Effect.gen(function* () {
        const id = yield* pathId
        const hidden = (yield* searchParams).get("hidden") === "1"
        return yield* respond(signedIn((user) => core.files(user, id, hidden)))
      }),
    ),
    HttpRouter.concat(downloadRoutes(core)),
    // The pull request view of a thread: its list, one pull request, its diff, and the changes the view asks of it.
    HttpRouter.get(
      "/api/tasks/:id/pull-requests",
      Effect.flatMap(pathId, (id) => respond(signedIn((user) => core.threadPullRequests(user, id)))),
    ),
    HttpRouter.get(
      "/api/tasks/:id/pull-request/diff",
      Effect.flatMap(pathId, (id) =>
        respond(
          signedIn((user) =>
            Effect.flatMap(searchParams, (params) =>
              Effect.flatMap(pullRequestQuery(params), (pr) => core.threadPullRequestDiff(user, id, pr.repo, pr.number)),
            ),
          ),
        ),
      ),
    ),
    HttpRouter.get(
      "/api/tasks/:id/pull-request",
      Effect.flatMap(pathId, (id) =>
        respond(
          signedIn((user) =>
            Effect.flatMap(searchParams, (params) =>
              Effect.flatMap(pullRequestQuery(params), (pr) => core.threadPullRequest(user, id, pr.repo, pr.number)),
            ),
          ),
        ),
      ),
    ),
    HttpRouter.post(
      "/api/tasks/:id/pull-request/action",
      Effect.flatMap(pathId, (id) =>
        respond(
          signedIn((user) =>
            Effect.flatMap(jsonBody(ThreadPullRequestAction), (action) =>
              applyPullRequestAction(core, hooks, user, id, action),
            ),
          ),
        ),
      ),
    ),
    // Bytes of a file attached to one of the owner's task messages; the MIME type is the content type. Users upload
    // any type, so the response may not run as a page on the app's origin (e.g. an uploaded text/html).
    HttpRouter.get(
      "/api/tasks/:id/attachments/:attachmentId",
      Effect.flatMap(HttpRouter.params, (p) =>
        signedIn((user) => core.attachment(user, p.id ?? "", p.attachmentId ?? "")).pipe(
          Effect.map((a) =>
            HttpServerResponse.uint8Array(a.bytes, {
              contentType: a.mimeType,
              headers: { "content-security-policy": "sandbox", "x-content-type-options": "nosniff" },
            }),
          ),
          Effect.catchAll((e) => Effect.succeed(errorResponse(e))),
        ),
      ),
    ),
    // A checkout's repository icon. The blob in the path names the bytes, so the browser keeps it for good. SVGs may
    // carry script: like attachments, the response never runs as a page on the app's origin.
    HttpRouter.get(
      "/api/tasks/:id/checkouts/:checkoutId/icon/:blob",
      Effect.flatMap(HttpRouter.params, (p) =>
        signedIn((user) => core.checkoutIcon(user, p.id ?? "", p.checkoutId ?? "", p.blob ?? "")).pipe(
          Effect.map((icon) =>
            HttpServerResponse.uint8Array(icon.bytes, {
              contentType: icon.mimeType,
              headers: {
                "cache-control": "private, max-age=31536000, immutable",
                "content-security-policy": "sandbox",
                "x-content-type-options": "nosniff",
              },
            }),
          ),
          Effect.catchAll((e) => Effect.succeed(errorResponse(e))),
        ),
      ),
    ),
    // An image a tool call returned. The id is the bytes' hash, so the browser keeps it for good; like attachments,
    // the response never runs as a page on the app's origin.
    HttpRouter.get(
      "/api/tasks/:id/runs/:runId/images/:imageId",
      Effect.flatMap(HttpRouter.params, (p) =>
        signedIn((user) => core.runImage(user, p.id ?? "", p.runId ?? "", p.imageId ?? "")).pipe(
          Effect.map((image) =>
            HttpServerResponse.uint8Array(image.bytes, {
              contentType: image.mimeType,
              headers: {
                "cache-control": "private, max-age=31536000, immutable",
                "content-security-policy": "sandbox",
                "x-content-type-options": "nosniff",
              },
            }),
          ),
          Effect.catchAll((e) => Effect.succeed(errorResponse(e))),
        ),
      ),
    ),
  ).pipe(
    // pipe takes at most 20 functions: the preview and desktop routes are their own group.
    HttpRouter.post(
      "/api/tasks/:id/preview/session",
      Effect.flatMap(pathId, (id) => respond(signedIn((user) => core.previewSession(user, id)))),
    ),
    HttpRouter.all(
      "/api/tasks/:id/preview",
      Effect.flatMap(pathId, (id) => servePreview(core, id)),
    ),
    HttpRouter.all(
      "/api/tasks/:id/preview/*",
      Effect.flatMap(pathId, (id) => servePreview(core, id)),
    ),
    HttpRouter.get(
      "/api/tasks/:id/desktop",
      Effect.flatMap(pathId, (id) => respond(signedIn((user) => core.desktopStatus(user, id)))),
    ),
    HttpRouter.post(
      "/api/tasks/:id/desktop",
      Effect.flatMap(pathId, (id) => respond(signedIn((user) => core.desktopStart(user, id)))),
    ),
    HttpRouter.del(
      "/api/tasks/:id/desktop",
      Effect.flatMap(pathId, (id) =>
        respond(signedIn((user) => core.desktopStop(user, id).pipe(Effect.zipRight(core.desktopStatus(user, id))))),
      ),
    ),
    HttpRouter.put(
      "/api/tasks/:id/desktop/quality",
      Effect.flatMap(pathId, (id) =>
        respond(
          signedIn((user) =>
            Effect.flatMap(jsonBody(SetDesktopQualityBody), (body) => core.desktopSetQuality(user, id, body.quality)),
          ),
        ),
      ),
    ),
  )

/**
 * Builds a fetch-style handler for the REST API. Unknown routes return 404.
 * CORS is open to every origin (web and Electron clients).
 */
export const makeWebHandler = (
  core: CoreShape,
  cliAuth: CliAuthShape,
  capabilities: BoxCapabilities,
  models: ModelDiscoveryShape,
  hooks: RouterHooks = NO_HOOKS,
) =>
  Effect.gen(function* () {
    const app = yield* HttpRouter.toHttpApp(makeRouter(core, cliAuth, capabilities, models, hooks))
    const notFound = HttpServerResponse.unsafeJson({ _tag: "NotFound", message: "no such route" }, { status: 404 })
    const withCors = HttpMiddleware.cors({
      allowedOrigins: () => true,
      allowedMethods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
      allowedHeaders: ["content-type", "authorization"],
    })
    const handled = app.pipe(Effect.catchTag("RouteNotFound", () => Effect.succeed(notFound)))
    return HttpApp.toWebHandler(withCors(handled))
  })
