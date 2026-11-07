import { Effect, Runtime, Schema } from "effect"
import { DesktopInput, DesktopRtcClientMessage, type DesktopRtcServerMessage, type DesktopStatus } from "@cloudagents/protocol"
import { Config } from "../config"
import { EventHub } from "../core/events"
import { CoreService } from "../core/service"
import { DesktopManager, DesktopRtcSession, MediaTap, managedTurn, sessionIceServers } from "../desktop"
import { TaskStatsService } from "../stats"
import { ActivityTracker } from "../platform/tracker"

export type WsServices = CoreService | DesktopManager | EventHub | Config | TaskStatsService | ActivityTracker

/**
 * One bidirectional stream to a browser, tunnelled through the control plane relay.
 * Sends on a closed socket are dropped.
 */
export interface StreamSocket {
  readonly sendText: (data: string) => void
  readonly close: (code?: number, reason?: string) => void
  /** Registers the text-message listener. */
  readonly onText: (listener: (data: string) => void) => void
  /** Runs `listener` once the socket has closed; immediately if it already has. */
  readonly onClose: (listener: () => void) => void
}

export type StreamRoute =
  | { readonly kind: "events" | "desktop"; readonly taskId: string }
  | { readonly kind: "user-events" }
  | { readonly kind: "stats"; readonly taskId: string }
  | { readonly kind: "preview"; readonly taskId: string; readonly path: string; readonly protocol?: string }

const USER_EVENTS_PATH = "/api/events"
const STATS_PATH = /^\/api\/tasks\/([^/]+)\/stats\/stream$/
const EVENTS_PATH = /^\/api\/tasks\/([^/]+)\/events$/
const DESKTOP_PATH = /^\/api\/tasks\/([^/]+)\/desktop\/stream$/
const PREVIEW_PATH = /^\/api\/tasks\/([^/]+)\/preview(?:\/.*)?$/

/** Maps a relayed WebSocket URL to its thread stream route. */
export const streamRoute = (pathname: string, requestPath = pathname, protocol?: string): StreamRoute | null => {
  if (pathname === USER_EVENTS_PATH) return { kind: "user-events" }
  const events = EVENTS_PATH.exec(pathname)
  if (events) return { kind: "events", taskId: decodeURIComponent(events[1] ?? "") }
  const stats = STATS_PATH.exec(pathname)
  if (stats) return { kind: "stats", taskId: decodeURIComponent(stats[1] ?? "") }
  const desktop = DESKTOP_PATH.exec(pathname)
  if (desktop) return { kind: "desktop", taskId: decodeURIComponent(desktop[1] ?? "") }
  const preview = PREVIEW_PATH.exec(pathname)
  if (!preview?.[1]) return null
  const requestUrl = new URL(requestPath, "http://box.local")
  const prefix = `/api/tasks/${preview[1]}/preview`
  const path = `${requestUrl.pathname.slice(prefix.length) || "/"}${requestUrl.search}`
  return {
    kind: "preview",
    taskId: decodeURIComponent(preview[1]),
    path,
    ...(protocol ? { protocol } : {}),
  }
}

/** Close code sent when the task does not exist or belongs to someone else. */
export const CLOSE_NOT_FOUND = 4404
/** Close code sent when a stream arrives without a signed-in user. */
export const CLOSE_UNAUTHORIZED = 4401
/** Close code sent when the desktop cannot be attached. */
const CLOSE_INTERNAL = 1011

const closeWith = (socket: StreamSocket, code: number, message: string) =>
  Effect.sync(() => socket.close(code, message.slice(0, 120)))

const serveEvents = (socket: StreamSocket, user: string, taskId: string): Effect.Effect<void, never, CoreService | EventHub> =>
  Effect.gen(function* () {
    const core = yield* CoreService
    const hub = yield* EventHub
    const found = yield* core.getTask(user, taskId).pipe(Effect.either)
    if (found._tag === "Left") {
      return yield* closeWith(socket, CLOSE_NOT_FOUND, found.left.message)
    }
    yield* Effect.acquireUseRelease(
      Effect.sync(() => hub.subscribe(taskId, (event) => socket.sendText(JSON.stringify(event)))),
      () => Effect.async<void>((resume) => socket.onClose(() => resume(Effect.void))),
      (unsubscribe) => Effect.sync(unsubscribe),
    )
  })

const serveUserEvents = (socket: StreamSocket, user: string): Effect.Effect<void, never, EventHub> =>
  Effect.gen(function* () {
    const hub = yield* EventHub
    yield* Effect.acquireUseRelease(
      Effect.sync(() =>
        hub.subscribeAll((event) => {
          const mine =
            event._tag === "task.updated"
              ? event.task.owner === user
              : event._tag === "task.deleted" && event.owner === user
          if (mine) socket.sendText(JSON.stringify(event))
        }),
      ),
      () => Effect.async<void>((resume) => socket.onClose(() => resume(Effect.void))),
      (unsubscribe) => Effect.sync(unsubscribe),
    )
  })

const serveStats = (socket: StreamSocket, user: string, taskId: string): Effect.Effect<void, never, CoreService | TaskStatsService> =>
  Effect.gen(function* () {
    const core = yield* CoreService
    const stats = yield* TaskStatsService
    const found = yield* core.getTask(user, taskId).pipe(Effect.either)
    if (found._tag === "Left") {
      return yield* closeWith(socket, CLOSE_NOT_FOUND, found.left.message)
    }
    let intervalMs = 0
    yield* Effect.acquireUseRelease(
      stats.subscribe(taskId, (samples) => socket.sendText(JSON.stringify({ intervalMs, samples }))),
      (subscription) =>
        Effect.gen(function* () {
          intervalMs = subscription.initial.intervalMs
          socket.sendText(JSON.stringify(subscription.initial))
          yield* Effect.async<void>((resume) => socket.onClose(() => resume(Effect.void)))
        }),
      (subscription) => Effect.sync(subscription.unsubscribe),
    )
  })

const serveDesktop = (socket: StreamSocket, user: string, taskId: string): Effect.Effect<void, never, WsServices> =>
  Effect.gen(function* () {
    const core = yield* CoreService
    const desktop = yield* DesktopManager
    const config = yield* Config
    const runtime = yield* Effect.runtime<WsServices>()
    const fork = Runtime.runFork(runtime)
    const runPromise = Runtime.runPromise(runtime)
    const found = yield* core.getTask(user, taskId).pipe(Effect.either)
    if (found._tag === "Left") {
      return yield* closeWith(socket, CLOSE_NOT_FOUND, found.left.message)
    }

    // Holds this viewer's config and GOP, so a WebRTC peer that joins or asks for a keyframe is resynced from here.
    const tap = new MediaTap()
    let socketClosed = false
    const decodeInput = Schema.decodeUnknown(Schema.parseJson(DesktopInput))
    const sendSignal = (message: DesktopRtcServerMessage) => {
      if (!socketClosed) socket.sendText(JSON.stringify(message))
    }
    const managed = managedTurn(config)
    const rtc = new DesktopRtcSession(config.webrtc, taskId, tap, {
      send: sendSignal,
      onInput: (raw, channel) =>
        fork(
          Effect.gen(function* () {
            const input = yield* decodeInput(raw)
            if (channel === "pointer" && input._tag !== "mouse.move") {
              yield* Effect.logWarning(`desktop pointer channel carried ${input._tag}`)
              return
            }
            yield* desktop.streamInput(taskId, input)
          }).pipe(Effect.catchAll((e) => Effect.logWarning(`desktop input failed: ${e.message}`))),
        ),
      profileChanged: () => Effect.runSync(desktop.refreshProfile(taskId)),
      debug: (message) => fork(Effect.logDebug(message)),
    })
    // A status or a config must not outpace the one before it: a slow credential fetch may not deliver its config after
    // a later status. Closing the socket also ends the queue: nothing is written to a socket the browser left.
    let signalQueue: Promise<void> = Promise.resolve()
    const enqueue = (run: () => Promise<void>): void => {
      if (socketClosed) return
      signalQueue = signalQueue
        .then(() => (socketClosed ? undefined : run()))
        .catch((e: unknown) => {
          if (!socketClosed) {
            fork(Effect.logWarning(`desktop stream failed: ${e instanceof Error ? e.message : String(e)}`))
          }
        })
    }
    const sendStatus = (status: DesktopStatus) => {
      if (!socketClosed) socket.sendText(JSON.stringify(status))
    }
    // Sent once per running desktop on this socket, ahead of its status: the viewer holds the ICE servers before it
    // offers. A viewer retrying on an old one asks again, for TURN credentials that have not expired.
    let configSent = false
    const sendConfig = async (): Promise<void> => {
      const resolved = await sessionIceServers(config.webrtc, managed, taskId)
      if (socketClosed) return
      if (resolved.warning !== null) fork(Effect.logWarning(resolved.warning))
      // Resolved here, on the config path, so the box's own answer never waits on the control plane. A failed fetch
      // leaves both peers on the box's own configuration.
      rtc.setIceServers(resolved.iceServers, resolved.managed)
      sendSignal({
        _tag: "rtc.config",
        iceServers: resolved.iceServers,
        iceTransportPolicy: config.webrtc.policy,
      })
    }
    const decodeMessage = Schema.decodeUnknown(Schema.parseJson(DesktopRtcClientMessage))
    const handleMessage = (raw: string) =>
      Effect.gen(function* () {
        if (socketClosed) return
        const message = yield* decodeMessage(raw).pipe(Effect.either)
        if (message._tag === "Left") {
          yield* Effect.logWarning(`desktop message rejected: ${message.left.message}`)
          return
        }
        const signal = message.right
        if (signal._tag === "rtc.config.request") {
          if (configSent) enqueue(sendConfig)
          return
        }
        yield* Effect.promise(() => rtc.handle(signal))
      })

    yield* Effect.acquireUseRelease(
      desktop.subscribe(taskId, {
        get baselineOnly(): boolean {
          return rtc.baselineOnly
        },
        onStatus: (status) => {
          if (status.state !== "running") {
            configSent = false
            enqueue(async () => sendStatus(status))
          } else if (configSent) {
            enqueue(async () => sendStatus(status))
          } else {
            configSent = true
            enqueue(async () => {
              await sendConfig()
              sendStatus(status)
            })
          }
        },
        onMedia: (unit) => {
          tap.push(unit)
          rtc.push(unit)
        },
        onAudio: (opus, timestamp) => rtc.pushAudio(opus, timestamp),
      }),
      () =>
        Effect.gen(function* () {
          socket.onText((data) => fork(handleMessage(data)))
          yield* Effect.async<void>((resume) => socket.onClose(() => resume(Effect.void)))
        }),
      (unsubscribe) =>
        Effect.zipRight(
          Effect.sync(() => {
            socketClosed = true
          }),
          Effect.zipRight(unsubscribe, Effect.sync(() => rtc.close())),
        ),
    ).pipe(Effect.catchAll((e) => closeWith(socket, CLOSE_INTERNAL, e.message)))
  })


const servePreview = (
  route: Extract<StreamRoute, { kind: "preview" }>,
  user: string,
  socket: StreamSocket,
): Effect.Effect<void, never, WsServices> =>
  Effect.gen(function* () {
    const core = yield* CoreService
    const upstream = yield* core.previewSocket(user, route.taskId, route.path, route.protocol).pipe(Effect.either)
    if (upstream._tag === "Left") {
      return yield* closeWith(socket, CLOSE_NOT_FOUND, upstream.left.message)
    }
    upstream.right.onText((data) => socket.sendText(data))
    upstream.right.onClose(() => socket.close())
    socket.onText(upstream.right.sendText)
    socket.onClose(upstream.right.close)
    yield* Effect.async<void>((resume) => socket.onClose(() => resume(Effect.void)))
  })
const routeStream = (route: StreamRoute, user: string, socket: StreamSocket): Effect.Effect<void, never, WsServices> => {
  switch (route.kind) {
    case "events":
      return serveEvents(socket, user, route.taskId)
    case "user-events":
      return serveUserEvents(socket, user)
    case "stats":
      return serveStats(socket, user, route.taskId)
    case "desktop":
      return serveDesktop(socket, user, route.taskId)
    case "preview":
      return servePreview(route, user, socket)
  }
}

/**
 * Runs the handler for a stream route against one socket for the signed-in `user`. Never fails: errors close the
 * socket. A message a client sends is activity; every stream except a preview counts as a viewer while it is open.
 */
export const serveStream = (route: StreamRoute, user: string, rawSocket: StreamSocket): Effect.Effect<void, never, WsServices> =>
  Effect.gen(function* () {
    const tracker = yield* ActivityTracker
    // Forwarded one by one: RelayStream's methods live on its prototype, where an object spread would drop them.
    const socket: StreamSocket = {
      sendText: (data) => rawSocket.sendText(data),
      close: (code, reason) => rawSocket.close(code, reason),
      onClose: (listener) => rawSocket.onClose(listener),
      onText: (listener) =>
        rawSocket.onText((data) => {
          Effect.runSync(tracker.touch)
          listener(data)
        }),
    }
    const leave = route.kind === "preview" ? Effect.void : yield* tracker.viewerJoined
    yield* routeStream(route, user, socket).pipe(Effect.ensuring(leave))
  })
