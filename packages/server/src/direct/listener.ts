import type { IncomingMessage } from "node:http"
import type { Duplex } from "node:stream"
import { Effect, Either, Runtime, Schema } from "effect"
import { BOX_TOKEN_QUERY, BOX_USER_HEADER, Paths, WebRtcAnswer, WebRtcOffer } from "@cloudagents/protocol"
import { WebSocketServer } from "ws"
import type { CoreShape } from "../core/service"
import { BOX_DEV_HEADER } from "../tunnel"
import { serveStream, streamRoute, type WsServices } from "../http/streams"
import type { BoxAuth } from "./auth"
import { wsStreamSocket } from "./socket"
import { makeRtcServer } from "./rtc"

/** Carries a preview frame's token to the core, which checks it belongs to the task. */
const PREVIEW_TOKEN_HEADER = "x-kestrel-preview-token"

/** `/_preview/<token>/<taskId>[/rest]`: a preview frame addressed by its own URL. */
const PREVIEW_FRAME = /^\/_preview\/([0-9a-f-]{36})\/([^/]+)(\/.*)?$/
/** The page a preview frame is on; its subresources are root-relative and arrive with only this Referer. */
const PREVIEW_REFERER = /^\/_preview\/([0-9a-f-]{36})\/([^/]+)(?:\/.*)?$/

const REASON: Record<number, string> = { 401: "Unauthorized", 404: "Not Found", 503: "Service Unavailable" }

interface Rejection {
  readonly status: number
  readonly tag: "Unauthorized" | "NotFound" | "Unavailable"
  readonly message: string
}

interface Routed {
  /** The request's URL on this box: a preview frame's URL mapped to the task's preview route, else its own. */
  readonly url: URL
  /** Signed-in user the request acts for; null when no box token was presented. */
  readonly user: string | null
  /** When the box token lapses, epoch seconds; null unless a box token was presented. */
  readonly expiresAt: number | null
  readonly dev: boolean
  /** Set only for preview frames: the frame's token, which the core checks against the task. */
  readonly previewToken: string | null
}

export interface DirectListenerDeps {
  readonly auth: BoxAuth
  readonly core: Pick<CoreShape, "previewTokenFor">
  /** The app's web handler (`makeWebHandler`), serving HTTP requests whose identity is already set. */
  readonly webHandler: (request: Request) => Promise<Response>
  readonly runtime: Runtime.Runtime<WsServices>
}

export interface DirectListener {
  readonly handle: (request: Request) => Promise<Response>
  readonly upgrade: (request: IncomingMessage, socket: Duplex, head: Buffer) => void
  readonly close: () => void
}

const bearerOrQueryToken = (url: URL, authorization: string | null): string | null => {
  const bearer = authorization === null ? null : /^Bearer\s+(.+)$/i.exec(authorization)?.[1]
  return bearer ?? url.searchParams.get(BOX_TOKEN_QUERY)
}

const previewRoute = (url: URL, referer: string | null): { token: string; taskId: string; path: string } | null => {
  const frame = PREVIEW_FRAME.exec(url.pathname)
  if (frame !== null) {
    const [, token = "", taskId = "", rest = ""] = frame
    return { token, taskId, path: `${rest}${url.search}` }
  }
  if (referer === null) return null
  let refererPath: string
  try {
    refererPath = new URL(referer).pathname
  } catch {
    return null
  }
  const page = PREVIEW_REFERER.exec(refererPath)
  if (page === null) return null
  const [, token = "", taskId = ""] = page
  return { token, taskId, path: `${url.pathname}${url.search}` }
}

const route = async (
  deps: DirectListenerDeps,
  url: URL,
  referer: string | null,
  authorization: string | null,
): Promise<Routed | Rejection> => {
  const preview = previewRoute(url, referer)
  if (preview !== null) {
    const session = await Effect.runPromise(deps.core.previewTokenFor(preview.token))
    if (session === null || session.taskId !== preview.taskId) {
      return { status: 404, tag: "NotFound", message: "preview session is invalid" }
    }
    return {
      url: new URL(`${Paths.taskPreview(preview.taskId)}${preview.path}`, url),
      user: session.user,
      dev: false,
      previewToken: preview.token,
      expiresAt: null,
    }
  }
  const token = bearerOrQueryToken(url, authorization)
  url.searchParams.delete(BOX_TOKEN_QUERY)
  if (token === null) return { url, user: null, expiresAt: null, dev: false, previewToken: null }
  const outcome = await Effect.runPromise(Effect.either(deps.auth.authenticate(token)))
  if (Either.isLeft(outcome)) {
    const error = outcome.left
    return error._tag === "Unauthorized"
      ? { status: 401, tag: "Unauthorized", message: error.message }
      : { status: 503, tag: "Unavailable", message: error.message }
  }
  return {
    url,
    user: outcome.right.sub,
    expiresAt: outcome.right.exp,
    dev: outcome.right.dev === true,
    previewToken: null,
  }
}

const withIdentity = (headers: Headers, routed: Routed): Headers => {
  if (routed.user !== null) headers.set(BOX_USER_HEADER, routed.user)
  if (routed.dev) headers.set(BOX_DEV_HEADER, "1")
  if (routed.previewToken !== null) {
    headers.delete("cookie")
    headers.delete("authorization")
    headers.set(PREVIEW_TOKEN_HEADER, routed.previewToken)
  }
  return headers
}

const withReferrerPolicy = (response: Response): Response => {
  const headers = new Headers(response.headers)
  headers.set("referrer-policy", "strict-origin-when-cross-origin")
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers })
}

const withAllowOrigin = (response: Response, origin: string | null): Response => {
  if (origin === null) return response
  const headers = new Headers(response.headers)
  headers.set("access-control-allow-origin", origin)
  headers.append("vary", "Origin")
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers })
}

export const makeDirectListener = (deps: DirectListenerDeps): DirectListener => {
  const wss = new WebSocketServer({ noServer: true })

  const rtc = makeRtcServer({ webHandler: deps.webHandler, runtime: deps.runtime })

  const answerOffer = async (request: Request, routed: Routed): Promise<Response> => {
    if (routed.user === null || routed.expiresAt === null) {
      return Response.json({ _tag: "Unauthorized", message: "box token is required" }, { status: 401 })
    }
    const offer = Schema.decodeUnknownEither(Schema.parseJson(WebRtcOffer))(await request.text())
    if (Either.isLeft(offer)) {
      return Response.json({ _tag: "BadRequest", message: "body must be a WebRTC offer" }, { status: 400 })
    }
    let answer: WebRtcAnswer | null
    try {
      answer = await rtc.answer({ user: routed.user, dev: routed.dev }, offer.right, routed.expiresAt)
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      return Response.json({ _tag: "BadRequest", message }, { status: 400 })
    }
    if (answer === null) {
      return Response.json(
        { _tag: "Unavailable", message: "this box already serves its maximum of WebRTC channels" },
        { status: 503 },
      )
    }
    return Response.json(answer)
  }

  const handle = async (request: Request): Promise<Response> => {
    const url = new URL(request.url)
    const routed = await route(deps, url, request.headers.get("referer"), request.headers.get("authorization"))
    if ("status" in routed) {
      const rejected = new Response(JSON.stringify({ _tag: routed.tag, message: routed.message }), {
        status: routed.status,
        headers: { "content-type": "application/json" },
      })
      return url.pathname === Paths.webrtcOffer ? withAllowOrigin(rejected, request.headers.get("origin")) : rejected
    }
    if (request.method === "POST" && routed.url.pathname === Paths.webrtcOffer) {
      return withAllowOrigin(await answerOffer(request, routed), request.headers.get("origin"))
    }
    const body = request.method === "GET" || request.method === "HEAD" ? undefined : await request.arrayBuffer()
    const headers = withIdentity(new Headers(request.headers), routed)
    const response = await deps.webHandler(new Request(routed.url, { method: request.method, headers, body }))
    return routed.previewToken === null ? response : withReferrerPolicy(response)
  }

  const upgrade = (request: IncomingMessage, socket: Duplex, head: Buffer): void => {
    const url = new URL(request.url ?? "/", "http://box.local")
    const referer = typeof request.headers.referer === "string" ? request.headers.referer : null
    const authorization = typeof request.headers.authorization === "string" ? request.headers.authorization : null
    const offered = request.headers["sec-websocket-protocol"]
    const protocol = typeof offered === "string" ? offered.split(",")[0]?.trim() : undefined
    void route(deps, url, referer, authorization).then((routed) => {
      if ("status" in routed) return rejectUpgrade(socket, routed)
      if (routed.user === null) {
        return rejectUpgrade(socket, { status: 401, tag: "Unauthorized", message: "box token is required" })
      }
      const found = streamRoute(
        routed.url.pathname,
        `${routed.url.pathname}${routed.url.search}`,
        routed.previewToken === null ? undefined : protocol,
      )
      if (found === null) return rejectUpgrade(socket, { status: 404, tag: "NotFound", message: "no such stream" })
      const user = routed.user
      wss.handleUpgrade(request, socket, head, (ws) => {
        Runtime.runFork(deps.runtime)(serveStream(found, user, wsStreamSocket(ws)))
      })
    })
  }

  return { handle, upgrade, close: rtc.close }
}

const rejectUpgrade = (socket: Duplex, rejection: Rejection): void => {
  const body = JSON.stringify({ _tag: rejection.tag, message: rejection.message })
  socket.end(
    `HTTP/1.1 ${rejection.status} ${REASON[rejection.status] ?? "Error"}\r\n` +
      `content-type: application/json\r\ncontent-length: ${Buffer.byteLength(body)}\r\nconnection: close\r\n\r\n${body}`,
  )
}
