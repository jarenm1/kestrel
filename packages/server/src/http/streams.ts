import { Effect, Runtime, Schema } from "effect"
import { DesktopAck, DesktopInput } from "@cloudagents/protocol"
import { Config } from "../config"
import { EventHub } from "../core/events"
import { CoreService } from "../core/service"
import { DesktopManager, MediaBundler, type MediaKind } from "../desktop"
import { TaskStatsService } from "../stats"

export type WsServices = CoreService | DesktopManager | EventHub | Config | TaskStatsService

/**
 * One bidirectional stream to a browser, tunnelled through the control plane relay.
 * Sends on a closed socket are dropped.
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

/**
 * A viewer's lag is how long its oldest unacked frame has been on the way. Over FLOW_LAG_HIGH_MS the server withholds
 * deltas. A withheld viewer resumes from the cached GOP once its lag is under FLOW_LAG_LOW_MS (or nothing is unacked).
 * A join burst is fine as long as the viewer acks it promptly: only a viewer that stays behind is throttled.
 */
export const FLOW_LAG_HIGH_MS = 1000
/**
 * Above the browser's ack interval (250 ms) plus RTT: the lag measured at an ack is roughly that interval plus RTT,
 * so a lower threshold would resync a viewer that is not actually behind.
 */
export const FLOW_LAG_LOW_MS = 400
/**
 * Send times kept per viewer, oldest first. At 60 fps this is ~17 s, far past FLOW_LAG_HIGH_MS. Past it the oldest
 * record is dropped, so the reported lag is then a lower bound.
 */
const FLOW_TRACK_LIMIT = 1024

/**
 * Per-viewer flow control for desktop media. The viewer acks how many binary frames it has received; the server records
 * when each frame was sent. While the oldest unacked frame is over FLOW_LAG_HIGH_MS old the server withholds deltas,
 * which a decoder cannot use without their predecessors anyway. A withheld viewer that catches up (lag under
 * FLOW_LAG_LOW_MS, or nothing unacked) is resynced from the cached GOP, since a static desktop may produce no keyframe
 * for a long time; otherwise it resumes at the next keyframe. Init segments always go out. A viewer that never acks is never throttled.
 */
export class MediaFlow {
  private sent = 0
  private acked: number | null = null
  /** Frames sent and not yet acked, oldest first: index among sent frames and send time. */
  private inFlight: { index: number; sentAt: number }[] = []
  private withholding = false
  private skipped = 0

  constructor(
    private readonly debug: (message: string) => void,
    private readonly now: () => number = () => performance.now(),
  ) {}

  /** Records the viewer's acks. Returns true when a withheld viewer is back under FLOW_LAG_LOW_MS and should be resynced. */
  ack(frames: number): boolean {
    this.acked = Math.min(Math.max(this.acked ?? 0, frames), this.sent)
    while (this.inFlight[0] !== undefined && this.inFlight[0].index < this.acked) this.inFlight.shift()
    return this.withholding && this.lag() < FLOW_LAG_LOW_MS
  }

  /** Ends withholding once the viewer has been resynced from the cached GOP. */
  resume(): void {
    this.withholding = false
    this.debug(`desktop viewer resynced from the cached GOP after skipping ${this.skipped} frames`)
    this.skipped = 0
  }

  /** How long the oldest unacked frame has been on the way; 0 when nothing is unacked. */
  private lag(): number {
    const oldest = this.inFlight[0]
    return oldest === undefined ? 0 : this.now() - oldest.sentAt
  }

  /** Whether `kind` should be sent now; counts it as sent when it is. */
  offer(kind: MediaKind): boolean {
    if (kind !== "init" && this.acked !== null) {
      const lag = this.lag()
      if (this.withholding) {
        if (kind === "delta" || lag >= FLOW_LAG_LOW_MS) {
          this.skipped++
          return false
        }
        this.withholding = false
        this.debug(`desktop viewer caught up; resumed at a keyframe after skipping ${this.skipped} frames`)
        this.skipped = 0
      } else if (kind === "delta" && lag > FLOW_LAG_HIGH_MS) {
        this.withholding = true
        this.skipped++
        this.debug(`desktop viewer ${Math.round(lag)} ms behind; withholding deltas until a keyframe`)
        return false
      }
    }
    this.inFlight.push({ index: this.sent, sentAt: this.now() })
    if (this.inFlight.length > FLOW_TRACK_LIMIT) this.inFlight.shift()
    this.sent++
    return true
  }
}

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
    const found = yield* core.getTask(user, taskId).pipe(Effect.either)
    if (found._tag === "Left") {
      return yield* closeWith(socket, CLOSE_NOT_FOUND, found.left.message)
    }

    const flow = new MediaFlow((message) => fork(Effect.logDebug(message)))
    const send = (chunk: Uint8Array, kind: MediaKind): void => {
      if (flow.offer(kind)) socket.sendBinary(chunk)
    }
    // Bundling happens before flow control: a bundle is one message to the viewer, and one frame to ack.
    const bundler = new MediaBundler(config.desktopBundleMs, send)
    const decodeMessage = Schema.decodeUnknown(Schema.parseJson(Schema.Union(DesktopAck, DesktopInput)))
    const handleMessage = (raw: string) =>
      Effect.gen(function* () {
        const message = yield* decodeMessage(raw).pipe(Effect.either)
        if (message._tag === "Left") {
          yield* Effect.logWarning(`desktop message rejected: ${message.left.message}`)
          return
        }
        if (message.right._tag === "stream.ack") {
          if (!flow.ack(message.right.frames)) return
          const gop = yield* desktop.cachedGop(taskId).pipe(
            Effect.catchAll((e) => Effect.logWarning(`desktop resync failed: ${e.message}`).pipe(Effect.as(null))),
          )
          if (gop === null) return
          flow.resume()
          for (const [i, fragment] of gop.entries()) bundler.push(fragment, i === 0 ? "key" : "delta")
          return
        }
        yield* desktop
          .streamInput(taskId, message.right)
          .pipe(Effect.catchAll((e) => Effect.logWarning(`desktop input failed: ${e.message}`)))
      })

    yield* Effect.acquireUseRelease(
      desktop.subscribe(taskId, {
        // Held media was produced before this status, so it goes out first: the viewer sees them in order.
        onStatus: (status) => {
          bundler.flush()
          socket.sendText(JSON.stringify(status))
        },
        onMedia: (chunk, kind) => bundler.push(chunk, kind),
      }),
      () =>
        Effect.gen(function* () {
          socket.onText((data) => fork(handleMessage(data)))
          yield* Effect.async<void>((resume) => socket.onClose(() => resume(Effect.void)))
        }),
      (unsubscribe) => Effect.zipRight(unsubscribe, Effect.sync(() => bundler.close())),
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
/** Runs the handler for a stream route against one socket for the signed-in `user`. Never fails: errors close the socket. */
export const serveStream = (route: StreamRoute, user: string, socket: StreamSocket): Effect.Effect<void, never, WsServices> => {
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
