import { Effect, Schema } from "effect"
import { HttpApp, HttpMiddleware, HttpRouter, HttpServerRequest, HttpServerResponse } from "@effect/platform"
import { BadRequest, Conflict, CreateRepoBody, CreateTaskBody, Health, InternalError, NotFound, SendMessageBody } from "@cloudagents/protocol"
import { VERSION } from "../config"
import { cliAuthStatus } from "../cliauth"
import type { CoreShape } from "../core/service"

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

const pathId = Effect.map(HttpRouter.params, (p) => p.id ?? "")

export const makeRouter = (core: CoreShape) =>
  HttpRouter.empty.pipe(
    HttpRouter.get(
      "/api/health",
      Effect.succeed(HttpServerResponse.unsafeJson(Schema.decodeSync(Health)({ ok: true, version: VERSION }))),
    ),
    // Agent CLI logins on the box itself (Connections page); never tokens.
    HttpRouter.get("/api/cli-auth", respond(cliAuthStatus())),

    HttpRouter.get("/api/repos", respond(core.listRepos())),
    HttpRouter.post(
      "/api/repos",
      respond(Effect.flatMap(jsonBody(CreateRepoBody), (body) => core.createRepo(body.url, body.name))),
    ),
    HttpRouter.get(
      "/api/repos/:id",
      Effect.flatMap(pathId, (id) => respond(core.getRepo(id))),
    ),
    HttpRouter.del(
      "/api/repos/:id",
      Effect.flatMap(pathId, (id) => noContent(core.deleteRepo(id))),
    ),
    HttpRouter.get(
      "/api/repos/:id/tasks",
      Effect.flatMap(pathId, (id) => respond(core.listTasks(id))),
    ),
    HttpRouter.post(
      "/api/repos/:id/tasks",
      Effect.flatMap(pathId, (id) =>
        respond(Effect.flatMap(jsonBody(CreateTaskBody), (body) => core.createTask(id, body))),
      ),
    ),

    HttpRouter.get(
      "/api/tasks/:id",
      Effect.flatMap(pathId, (id) => respond(core.getTask(id))),
    ),
    HttpRouter.del(
      "/api/tasks/:id",
      Effect.flatMap(pathId, (id) => noContent(core.deleteTask(id))),
    ),
    HttpRouter.get(
      "/api/tasks/:id/messages",
      Effect.flatMap(pathId, (id) => respond(core.listMessages(id))),
    ),
    HttpRouter.post(
      "/api/tasks/:id/messages",
      Effect.flatMap(pathId, (id) =>
        respond(Effect.flatMap(jsonBody(SendMessageBody), (body) => core.sendMessage(id, body.text))),
      ),
    ),
    HttpRouter.get(
      "/api/tasks/:id/runs",
      Effect.flatMap(pathId, (id) => respond(core.listRuns(id))),
    ),
    HttpRouter.post(
      "/api/runs/:id/cancel",
      Effect.flatMap(pathId, (id) => respond(core.cancelRun(id))),
    ),
    HttpRouter.get(
      "/api/tasks/:id/diff",
      Effect.flatMap(pathId, (id) => respond(core.diff(id))),
    ),

    HttpRouter.get(
      "/api/tasks/:id/desktop",
      Effect.flatMap(pathId, (id) => respond(core.desktopStatus(id))),
    ),
    HttpRouter.post(
      "/api/tasks/:id/desktop",
      Effect.flatMap(pathId, (id) => respond(core.desktopStart(id))),
    ),
    HttpRouter.del(
      "/api/tasks/:id/desktop",
      Effect.flatMap(pathId, (id) => respond(core.desktopStop(id).pipe(Effect.zipRight(core.desktopStatus(id))))),
    ),
  )

/**
 * Builds a fetch-style handler for the REST API. Unknown routes return 404.
 * CORS is open to every origin (web and Electron clients).
 */
export const makeWebHandler = (core: CoreShape) =>
  Effect.gen(function* () {
    const app = yield* HttpRouter.toHttpApp(makeRouter(core))
    const notFound = HttpServerResponse.unsafeJson({ _tag: "NotFound", message: "no such route" }, { status: 404 })
    const withCors = HttpMiddleware.cors({
      allowedOrigins: () => true,
      allowedMethods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
      allowedHeaders: ["content-type"],
    })
    const handled = app.pipe(Effect.catchTag("RouteNotFound", () => Effect.succeed(notFound)))
    return HttpApp.toWebHandler(withCors(handled))
  })
