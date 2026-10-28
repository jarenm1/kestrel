import { Effect, Runtime, Schema } from "effect"
import { DesktopAck, DesktopInput } from "@cloudagents/protocol"
import { EventHub } from "../core/events"
import { CoreService } from "../core/service"
import { DesktopManager, type MediaKind } from "../desktop"

export type WsServices = CoreService | DesktopManager | EventHub

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

/** Close code sent when the task does not exist or belongs to someone else. */
export const CLOSE_NOT_FOUND = 4404
/** Close code sent when a stream arrives without a signed-in user. */
export const CLOSE_UNAUTHORIZED = 4401
/** Close code sent when the desktop cannot be attached. */
const CLOSE_INTERNAL = 1011

/**
 * A viewer's lag is how long its oldest unacked frame has been on the way. Over FLOW_LAG_HIGH_MS the server withholds
 * deltas; a withheld viewer resumes at the next keyframe once its lag is under FLOW_LAG_LOW_MS (or nothing is unacked).
 * A join burst is fine as long as the viewer acks it promptly: only a viewer that stays behind is throttled.
 */
export const FLOW_LAG_HIGH_MS = 1000
export const FLOW_LAG_LOW_MS = 250
/**
 * Send times kept per viewer, oldest first. At 60 fps this is ~17 s, far past FLOW_LAG_HIGH_MS. Past it the oldest
 * record is dropped, so the reported lag is then a lower bound.
 */
const FLOW_TRACK_LIMIT = 1024

/**
 * Per-viewer flow control for desktop media. The viewer acks how many binary frames it has received; the server records
 * when each frame was sent. While the oldest unacked frame is over FLOW_LAG_HIGH_MS old the server withholds deltas,
 * which a decoder cannot use without their predecessors anyway, and resumes at a keyframe once that frame is under
 * FLOW_LAG_LOW_MS old. Init segments always go out. A viewer that never acks is never throttled.
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

  ack(frames: number): void {
    this.acked = Math.min(Math.max(this.acked ?? 0, frames), this.sent)
    while (this.inFlight[0] !== undefined && this.inFlight[0].index < this.acked) this.inFlight.shift()
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

const serveDesktop = (socket: StreamSocket, user: string, taskId: string): Effect.Effect<void, never, WsServices> =>
  Effect.gen(function* () {
    const core = yield* CoreService
    const desktop = yield* DesktopManager
    const runtime = yield* Effect.runtime<WsServices>()
    const fork = Runtime.runFork(runtime)
    const found = yield* core.getTask(user, taskId).pipe(Effect.either)
    if (found._tag === "Left") {
      return yield* closeWith(socket, CLOSE_NOT_FOUND, found.left.message)
    }

    const flow = new MediaFlow((message) => fork(Effect.logDebug(message)))
    const decodeMessage = Schema.decodeUnknown(Schema.parseJson(Schema.Union(DesktopAck, DesktopInput)))
    const handleMessage = (raw: string) =>
      Effect.gen(function* () {
        const message = yield* decodeMessage(raw).pipe(Effect.either)
        if (message._tag === "Left") {
          yield* Effect.logWarning(`desktop message rejected: ${message.left.message}`)
          return
        }
        if (message.right._tag === "stream.ack") {
          flow.ack(message.right.frames)
          return
        }
        yield* desktop
          .streamInput(taskId, message.right)
          .pipe(Effect.catchAll((e) => Effect.logWarning(`desktop input failed: ${e.message}`)))
      })

    yield* Effect.acquireUseRelease(
      desktop.subscribe(taskId, {
        onStatus: (status) => socket.sendText(JSON.stringify(status)),
        onMedia: (chunk, kind) => {
          if (flow.offer(kind)) socket.sendBinary(chunk)
        },
      }),
      () =>
        Effect.gen(function* () {
          socket.onText((data) => fork(handleMessage(data)))
          yield* Effect.async<void>((resume) => socket.onClose(() => resume(Effect.void)))
        }),
      (unsubscribe) => unsubscribe,
    ).pipe(Effect.catchAll((e) => closeWith(socket, CLOSE_INTERNAL, e.message)))
  })

/** Runs the handler for a stream route against one socket for the signed-in `user`. Never fails: errors close the socket. */
export const serveStream = (route: StreamRoute, user: string, socket: StreamSocket): Effect.Effect<void, never, WsServices> =>
  route.kind === "events" ? serveEvents(socket, user, route.taskId) : serveDesktop(socket, user, route.taskId)
