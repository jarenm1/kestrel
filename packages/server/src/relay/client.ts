import { Context, Duration, Either, Effect, Runtime, Schema } from "effect"
import {
  CREDENTIALS_HEADER,
  RELAY_PROTOCOL_VERSION,
  decodeFrame,
  encodeFrame,
  type RelayCredentials,
  type RelayFrame,
} from "@cloudagents/protocol"
import { WebSocket } from "ws"
import { VERSION } from "../config"
import { CredentialStore } from "../credentials"
import { CLOSE_NOT_FOUND, CLOSE_UNAUTHORIZED, serveStream, streamRoute, type WsServices } from "../http/streams"
import { serveTunnelHttp, TUNNEL_ORIGIN } from "../tunnel"
import { RelayStream } from "./stream"

export interface RelayOptions {
  /** Control plane base URL (http(s) or ws(s)); the box dials `path` under it. */
  readonly controlUrl: string
  /** Path dialled under `controlUrl`: `RELAY_CONNECT_PATH` for the relay, `BOX_CONTROL_PATH` for a direct box's control socket. */
  readonly path: string
  /** Credentials sent with the upgrade request, e.g. `Authorization: Bearer <box token>`. */
  readonly headers: Readonly<Record<string, string>>
  /** Serves a tunnelled HTTP request with the box's local `/api/*` handler. */
  readonly handle: (req: Request) => Promise<Response>
}

type Store = Context.Tag.Service<typeof CredentialStore>

const RECONNECT_MIN_MS = 1_000
const RECONNECT_MAX_MS = 30_000
const PING_INTERVAL_MS = 20_000
/** Silence longer than this means the relay connection is dead even if TCP has not noticed. */
const SILENCE_TIMEOUT_MS = 60_000
/** Close code the control plane sends when a newer connection from the same box replaces this one. */
const CLOSE_REPLACED = 4000

/** How one connection attempt ended. `refused`: the control plane turned the box away, so an immediate retry is pointless. */
interface Attempt {
  readonly opened: boolean
  readonly refused: boolean
}

const Credentials = Schema.parseJson(
  Schema.Struct({
    user: Schema.String,
    github: Schema.optional(Schema.String),
    anthropic: Schema.optional(Schema.String),
    openai: Schema.optional(Schema.String),
    dev: Schema.optional(Schema.Boolean),
  }),
)

const relayUrl = (controlUrl: string, path: string): string => {
  const url = new URL(controlUrl)
  url.protocol = url.protocol === "https:" || url.protocol === "wss:" ? "wss:" : "ws:"
  url.pathname = `${url.pathname.replace(/\/+$/, "")}${path}`
  url.search = ""
  url.hash = ""
  return url.toString()
}

/**
 * Keeps the box connected to the control plane for the life of the process. Reconnects with
 * exponential backoff (1s doubling to 30s); a connection that opened resets the backoff.
 */
export const runRelay = (options: RelayOptions): Effect.Effect<void, never, CredentialStore | WsServices> =>
  Effect.gen(function* () {
    const runtime = yield* Effect.runtime<CredentialStore | WsServices>()
    const store = yield* CredentialStore
    const url = relayUrl(options.controlUrl, options.path)
    let delay = RECONNECT_MIN_MS
    for (;;) {
      const attempt = yield* connectOnce(url, options, store, runtime)
      if (attempt.opened) delay = RECONNECT_MIN_MS
      // A refused box waits longest: the same credentials are refused again, and a replaced box must not fight its successor.
      if (attempt.refused) delay = RECONNECT_MAX_MS
      yield* Effect.logWarning(`relay connection closed; retrying in ${delay}ms`)
      yield* Effect.sleep(Duration.millis(delay))
      delay = Math.min(delay * 2, RECONNECT_MAX_MS)
    }
  })

/** Resolves with how the connection ended, once it closes. Interruption tears the socket down. */
const connectOnce = (
  url: string,
  options: RelayOptions,
  store: Store,
  runtime: Runtime.Runtime<CredentialStore | WsServices>,
): Effect.Effect<Attempt> =>
  Effect.async<Attempt>((resume) => {
    const runFork = Runtime.runFork(runtime)
    const ws = new WebSocket(url, { headers: options.headers })
    const streams = new Map<number, RelayStream>()
    let opened = false
    let refused = false
    let settled = false
    let lastSeen = Date.now()

    const send = (data: string | Uint8Array) => {
      if (ws.readyState === WebSocket.OPEN) ws.send(data)
    }

    const keepalive = setInterval(() => {
      if (Date.now() - lastSeen > SILENCE_TIMEOUT_MS) {
        ws.terminate()
        return
      }
      send(encodeFrame({ t: "ping" }))
    }, PING_INTERVAL_MS)

    const finish = (code: number) => {
      if (settled) return
      settled = true
      clearInterval(keepalive)
      for (const stream of streams.values()) stream.receiveClose()
      streams.clear()
      resume(Effect.succeed({ opened, refused: refused || code === CLOSE_REPLACED }))
    }

    const dispatch = (frame: RelayFrame) => {
      switch (frame.t) {
        case "http": {
          const creds = absorbCredentials(frame.headers, store)
          const identity = creds === null ? null : { user: creds.user, dev: creds.dev === true }
          void serveTunnelHttp(frame, options.handle, identity, (reply) => send(encodeFrame(reply)))
          return
        }
        case "ws-open": {
          const url = new URL(frame.path, TUNNEL_ORIGIN)
          const protocol = frame.headers["x-kestrel-preview-protocol"]?.split(",")[0]?.trim()
          const route = streamRoute(url.pathname, frame.path, protocol)
          if (route === null) {
            send(encodeFrame({ t: "ws-close", id: frame.id, code: CLOSE_NOT_FOUND, reason: "not found" }))
            return
          }
          const user = absorbCredentials(frame.headers, store)?.user ?? null
          if (user === null) {
            send(encodeFrame({ t: "ws-close", id: frame.id, code: CLOSE_UNAUTHORIZED, reason: "no signed-in user" }))
            return
          }
          const stream = new RelayStream(frame.id, send)
          streams.set(frame.id, stream)
          stream.onClose(() => streams.delete(frame.id))
          runFork(serveStream(route, user, stream))
          return
        }
        case "ws-text":
          streams.get(frame.id)?.receiveText(frame.data)
          return
        case "ws-close":
          streams.get(frame.id)?.receiveClose()
          return
        case "ping":
          send(encodeFrame({ t: "pong" }))
          return
        case "hello":
        case "http-res":
        case "pong":
          return
      }
    }

    ws.on("open", () => {
      opened = true
      send(encodeFrame({ t: "hello", version: RELAY_PROTOCOL_VERSION, boxVersion: VERSION }))
      Effect.runSync(Effect.logInfo(`relay connected to ${url}`))
    })
    ws.on("message", (data, isBinary) => {
      lastSeen = Date.now()
      // Inbound binary frames have no consumer: the local handlers only accept text input.
      if (isBinary) return
      const frame = decodeFrame(data.toString())
      if (frame === null) {
        Effect.runSync(Effect.logWarning("relay: dropped malformed frame"))
        return
      }
      dispatch(frame)
    })
    ws.on("error", (err) => {
      Effect.runSync(Effect.logWarning(`relay socket error: ${err.message}`))
    })
    // The control plane answered the upgrade with a plain HTTP response: a refusal (401) or a route that is not there.
    ws.on("unexpected-response", (_req, res) => {
      refused = res.statusCode === 401
      res.resume()
      finish(0)
      ws.terminate()
    })
    ws.on("close", (code) => finish(code))

    return Effect.sync(() => {
      clearInterval(keepalive)
      ws.terminate()
    })
  })

/** Stores the signed-in user's credentials from a tunnelled request; returns them, null when absent or malformed. */
const absorbCredentials = (headers: Readonly<Record<string, string>>, store: Store): RelayCredentials | null => {
  const raw = headers[CREDENTIALS_HEADER]
  if (raw === undefined) return null
  const decoded = Schema.decodeUnknownEither(Credentials)(raw)
  if (Either.isLeft(decoded)) {
    Effect.runSync(Effect.logWarning("relay: credentials header is malformed; ignored"))
    return null
  }
  Effect.runSync(store.set(decoded.right))
  return decoded.right
}
