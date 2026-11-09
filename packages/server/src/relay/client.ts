import { Context, Duration, Either, Effect, Runtime, Schema } from "effect"
import { createHash } from "node:crypto"
import {
  CREDENTIALS_HEADER,
  RELAY_CONNECT_PATH,
  RELAY_PROTOCOL_VERSION,
  decodeFrame,
  encodeFrame,
  type RelayCredentials,
  type RelayFrame,
} from "@cloudagents/protocol"
import { WebSocket } from "ws"
import { VERSION } from "../config"
import { CredentialStore } from "../credentials"
import { CLOSE_NOT_FOUND, CLOSE_UNAUTHORIZED, serveStream, streamRoute, type StreamRoute, type WsServices } from "../http/streams"
import { serveTunnelHttp, TUNNEL_ORIGIN } from "../tunnel"
import { RelayStream } from "./stream"

export interface RelayOptions {
  /** Control plane base URL (http(s) or ws(s)); the box dials `RELAY_CONNECT_PATH` under it. */
  readonly controlUrl: string
  readonly boxToken: string
  /** Serves a tunnelled HTTP request with the box's local `/api/*` handler. */
  readonly handle: (req: Request) => Promise<Response>
}

type Store = Context.Tag.Service<typeof CredentialStore>

const RECONNECT_MIN_MS = 1_000
const RECONNECT_MAX_MS = 30_000
const PING_INTERVAL_MS = 20_000
/** Silence longer than this means the relay connection is dead even if TCP has not noticed. */
const SILENCE_TIMEOUT_MS = 60_000

const Credentials = Schema.parseJson(
  Schema.Struct({
    user: Schema.String,
    github: Schema.optional(Schema.String),
    providers: Schema.optional(Schema.Record({ key: Schema.String, value: Schema.String })),
    anthropic: Schema.optional(Schema.String),
    openai: Schema.optional(Schema.String),
    dev: Schema.optional(Schema.Boolean),
  }),
)

const relayUrl = (controlUrl: string): string => {
  const url = new URL(controlUrl)
  url.protocol = url.protocol === "https:" || url.protocol === "wss:" ? "wss:" : "ws:"
  url.pathname = `${url.pathname.replace(/\/+$/, "")}${RELAY_CONNECT_PATH}`
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
    const url = relayUrl(options.controlUrl)
    let delay = RECONNECT_MIN_MS
    for (;;) {
      const opened = yield* connectOnce(url, options, store, runtime)
      if (opened) delay = RECONNECT_MIN_MS
      yield* Effect.logWarning(`relay connection closed; retrying in ${delay}ms`)
      yield* Effect.sleep(Duration.millis(delay))
      delay = Math.min(delay * 2, RECONNECT_MAX_MS)
    }
  })

/** How many recent HTTP request ids are remembered for duplicate suppression. */
const MAX_RECENT_HTTP_IDS = 1024

/** A stable digest of everything that makes one tunnelled request distinct; header order cannot change it. */
const httpFingerprint = (frame: Extract<RelayFrame, { t: "http" }>): string => {
  const headers = Object.keys(frame.headers)
    .sort()
    .map((name) => [name, frame.headers[name]])
  return createHash("sha256")
    .update(JSON.stringify([frame.method, frame.path, headers, frame.body ?? null]))
    .digest("hex")
}

export interface RelayDispatcher {
  readonly dispatch: (frame: RelayFrame) => void
  /** Closes every tunnelled stream and forgets them. */
  readonly close: () => void
}

export interface RelayDispatcherOptions {
  readonly send: (data: string | Uint8Array) => void
  readonly store: Store
  readonly handle: (req: Request) => Promise<Response>
  readonly runStream: (route: StreamRoute, user: string, socket: RelayStream) => void
}

/**
 * Serves the frames of one relay connection. An `http` request is executed at most once even if the control plane
 * retries its frame with the same id; a duplicate `ws-open` for a live id is ignored instead of replacing (and later
 * orphaning) the stream it names.
 */
export const makeRelayDispatcher = (options: RelayDispatcherOptions): RelayDispatcher => {
  const streams = new Map<number, RelayStream>()
  /**
   * Recent HTTP ids and the exact request each carried. Insertion order is the eviction order. An id alone is not
   * enough: the Hub's allocator restarts low ids after hibernation, so a different request may legitimately reuse an
   * id the box has already seen. Only the same request is a retry.
   */
  const recentHttp = new Map<number, string>()

  /** True only for an exact retry of a recently served request; a reused id with different content is served. */
  const seenHttp = (frame: Extract<RelayFrame, { t: "http" }>): boolean => {
    const fingerprint = httpFingerprint(frame)
    if (recentHttp.get(frame.id) === fingerprint) return true
    recentHttp.delete(frame.id)
    recentHttp.set(frame.id, fingerprint)
    if (recentHttp.size > MAX_RECENT_HTTP_IDS) {
      const oldest = recentHttp.keys().next().value
      if (oldest !== undefined) recentHttp.delete(oldest)
    }
    return false
  }

  const dispatch = (frame: RelayFrame): void => {
    switch (frame.t) {
      case "http": {
        if (seenHttp(frame)) return
        const creds = absorbCredentials(frame.headers, options.store)
        const identity = creds === null ? null : { user: creds.user, dev: creds.dev === true }
        void serveTunnelHttp(frame, options.handle, identity, (reply) => options.send(encodeFrame(reply)))
        return
      }
      case "ws-open": {
        if (streams.has(frame.id)) return
        const url = new URL(frame.path, TUNNEL_ORIGIN)
        const protocol = frame.headers["x-kestrel-preview-protocol"]?.split(",")[0]?.trim()
        const route = streamRoute(url.pathname, frame.path, protocol)
        if (route === null) {
          options.send(encodeFrame({ t: "ws-close", id: frame.id, code: CLOSE_NOT_FOUND, reason: "not found" }))
          return
        }
        const user = absorbCredentials(frame.headers, options.store)?.user ?? null
        if (user === null) {
          options.send(encodeFrame({ t: "ws-close", id: frame.id, code: CLOSE_UNAUTHORIZED, reason: "no signed-in user" }))
          return
        }
        const stream = new RelayStream(frame.id, options.send)
        streams.set(frame.id, stream)
        stream.onClose(() => {
          if (streams.get(frame.id) === stream) streams.delete(frame.id)
        })
        options.runStream(route, user, stream)
        return
      }
      case "ws-text":
        streams.get(frame.id)?.receiveText(frame.data)
        return
      case "ws-close":
        streams.get(frame.id)?.receiveClose()
        return
      case "ping":
        options.send(encodeFrame({ t: "pong" }))
        return
      case "hello":
      case "http-res":
      case "pong":
        return
    }
  }

  return {
    dispatch,
    close: () => {
      for (const stream of streams.values()) stream.receiveClose()
      streams.clear()
    },
  }
}

/** Resolves with whether the connection opened, once it closes. Interruption tears the socket down. */
const connectOnce = (
  url: string,
  options: RelayOptions,
  store: Store,
  runtime: Runtime.Runtime<CredentialStore | WsServices>,
): Effect.Effect<boolean> =>
  Effect.async<boolean>((resume) => {
    const runFork = Runtime.runFork(runtime)
    const ws = new WebSocket(url, { headers: { Authorization: `Bearer ${options.boxToken}` } })
    let opened = false
    let lastSeen = Date.now()

    const send = (data: string | Uint8Array) => {
      if (ws.readyState === WebSocket.OPEN) ws.send(data)
    }

    const dispatcher = makeRelayDispatcher({
      send,
      store,
      handle: options.handle,
      runStream: (route, user, stream) => runFork(serveStream(route, user, stream)),
    })

    const keepalive = setInterval(() => {
      if (Date.now() - lastSeen > SILENCE_TIMEOUT_MS) {
        ws.terminate()
        return
      }
      send(encodeFrame({ t: "ping" }))
    }, PING_INTERVAL_MS)

    const finish = () => {
      clearInterval(keepalive)
      dispatcher.close()
      resume(Effect.succeed(opened))
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
      dispatcher.dispatch(frame)
    })
    ws.on("error", (err) => {
      Effect.runSync(Effect.logWarning(`relay socket error: ${err.message}`))
    })
    ws.on("close", finish)

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
