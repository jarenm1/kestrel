import { Effect, Runtime, Schema } from "effect"
import { DesktopInput } from "@cloudagents/protocol"
import { EventHub } from "../core/events"
import { CoreService } from "../core/service"
import { DesktopManager } from "../desktop"

export type WsServices = CoreService | DesktopManager | EventHub

/**
 * One bidirectional stream to a browser: a node `ws` socket on the local listener, or a stream
 * tunnelled through the control plane relay. Sends on a closed socket are dropped.
 */
export interface StreamSocket {
  readonly sendText: (data: string) => void
  readonly sendBinary: (data: Uint8Array) => void
  readonly close: (code?: number, reason?: string) => void
  /** Registers the text-message listener. */
  readonly onText: (listener: (data: string) => void) => void
  /** Runs `listener` once the socket has closed; immediately if it already has. */
  readonly onClose: (listener: () => void) => void
}

export interface StreamRoute {
  readonly kind: "events" | "desktop"
  readonly taskId: string
}

const EVENTS_PATH = /^\/api\/tasks\/([^/]+)\/events$/
const DESKTOP_PATH = /^\/api\/tasks\/([^/]+)\/desktop\/stream$/

/** Maps a WebSocket pathname (no query) to its stream route; null when the path is not a stream. */
export const streamRoute = (pathname: string): StreamRoute | null => {
  const events = EVENTS_PATH.exec(pathname)
  if (events) return { kind: "events", taskId: decodeURIComponent(events[1] ?? "") }
  const desktop = DESKTOP_PATH.exec(pathname)
  if (desktop) return { kind: "desktop", taskId: decodeURIComponent(desktop[1] ?? "") }
  return null
}

/** Close code sent when the task does not exist. */
export const CLOSE_NOT_FOUND = 4404
/** Close code sent when the desktop cannot be attached. */
const CLOSE_INTERNAL = 1011

const closeWith = (socket: StreamSocket, code: number, message: string) =>
  Effect.sync(() => socket.close(code, message.slice(0, 120)))

const serveEvents = (socket: StreamSocket, taskId: string): Effect.Effect<void, never, CoreService | EventHub> =>
  Effect.gen(function* () {
    const core = yield* CoreService
    const hub = yield* EventHub
    const found = yield* core.getTask(taskId).pipe(Effect.either)
    if (found._tag === "Left") {
      return yield* closeWith(socket, CLOSE_NOT_FOUND, found.left.message)
    }
    yield* Effect.acquireUseRelease(
      Effect.sync(() => hub.subscribe(taskId, (event) => socket.sendText(JSON.stringify(event)))),
      () => Effect.async<void>((resume) => socket.onClose(() => resume(Effect.void))),
      (unsubscribe) => Effect.sync(unsubscribe),
    )
  })

const serveDesktop = (socket: StreamSocket, taskId: string): Effect.Effect<void, never, WsServices> =>
  Effect.gen(function* () {
    const core = yield* CoreService
    const desktop = yield* DesktopManager
    const runtime = yield* Effect.runtime<WsServices>()
    const fork = Runtime.runFork(runtime)
    const found = yield* core.getTask(taskId).pipe(Effect.either)
    if (found._tag === "Left") {
      return yield* closeWith(socket, CLOSE_NOT_FOUND, found.left.message)
    }

    const decodeInput = Schema.decodeUnknown(Schema.parseJson(DesktopInput))
    const handleInput = (raw: string) =>
      Effect.gen(function* () {
        const event = yield* decodeInput(raw).pipe(Effect.either)
        if (event._tag === "Left") {
          yield* Effect.logWarning(`desktop input rejected: ${event.left.message}`)
          return
        }
        yield* desktop
          .input(taskId, event.right)
          .pipe(Effect.catchAll((e) => Effect.logWarning(`desktop input failed: ${e.message}`)))
      })

    yield* Effect.acquireUseRelease(
      desktop.subscribe(taskId, {
        onStatus: (status) => socket.sendText(JSON.stringify(status)),
        onMedia: (chunk) => socket.sendBinary(chunk),
      }),
      () =>
        Effect.gen(function* () {
          socket.onText((data) => fork(handleInput(data)))
          yield* Effect.async<void>((resume) => socket.onClose(() => resume(Effect.void)))
        }),
      (unsubscribe) => unsubscribe,
    ).pipe(Effect.catchAll((e) => closeWith(socket, CLOSE_INTERNAL, e.message)))
  })

/** Runs the handler for a stream route against one socket. Never fails: errors close the socket. */
export const serveStream = (route: StreamRoute, socket: StreamSocket): Effect.Effect<void, never, WsServices> =>
  route.kind === "events" ? serveEvents(socket, route.taskId) : serveDesktop(socket, route.taskId)
