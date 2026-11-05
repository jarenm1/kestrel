import { Either, Schema } from "effect"
import {
  DesktopRtcServerMessage,
  DesktopStatus,
  Paths,
  ServerEvent,
  TaskStats,
  type DesktopRtcClientMessage,
} from "@cloudagents/protocol"
import { socketUrl, taskTarget, type Target } from "@/api/client"

function decodeText<A, I>(schema: Schema.Schema<A, I>, text: string): A | null {
  try {
    const result = Schema.decodeUnknownEither(schema)(JSON.parse(text))
    return Either.isRight(result) ? result.right : null
  } catch {
    return null
  }
}

/**
 * Opens a WebSocket once its URL is resolved (a user box's URL carries a fresh token), then hands it to `attach`.
 * Returns a function that closes it without firing `onClose`; closing before the socket exists cancels the open. A
 * failure to resolve the URL reports through `onFailure`.
 */
function openSocket(
  resolve: () => Promise<string>,
  attach: (socket: WebSocket) => void,
  onFailure: () => void,
): () => void {
  let socket: WebSocket | undefined
  let closed = false
  resolve().then(
    (url) => {
      if (closed) return
      socket = new WebSocket(url)
      attach(socket)
    },
    () => {
      if (!closed) onFailure()
    },
  )
  return () => {
    closed = true
    if (socket !== undefined) {
      socket.onclose = null
      socket.close()
    }
  }
}

/** Opens a ServerEvent WebSocket and returns a function that closes it without firing `onClose`. */
function openEvents(
  resolve: () => Promise<string>,
  handlers: { onOpen: () => void; onEvent: (event: ServerEvent) => void; onClose: () => void },
): () => void {
  return openSocket(
    resolve,
    (socket) => {
      socket.onopen = handlers.onOpen
      socket.onmessage = (msg: MessageEvent<unknown>) => {
        if (typeof msg.data !== "string") return
        const event = decodeText(ServerEvent, msg.data)
        if (event) handlers.onEvent(event)
      }
      socket.onclose = handlers.onClose
    },
    handlers.onClose,
  )
}

/**
 * Subscribes to a task's ServerEvent stream, on the box the thread lives on. Callers re-snapshot over REST in `onOpen`;
 * events that race the snapshot are reconciled by id. Returns a function that closes the socket.
 */
export function openTaskEvents(
  taskId: string,
  handlers: { onOpen: () => void; onEvent: (event: ServerEvent) => void; onClose: () => void },
): () => void {
  return openEvents(async () => socketUrl(Paths.taskEventsWs(taskId), await taskTarget(taskId)), handlers)
}

/**
 * Subscribes to the thread list stream of one box: `task.updated` for the user's threads on it, and `task.deleted`.
 * `target` is Kestrel's box (`null`) or a user box.
 */
export function openUserEvents(
  target: Target,
  handlers: { onOpen: () => void; onEvent: (event: ServerEvent) => void; onClose: () => void },
): () => void {
  return openEvents(() => socketUrl(Paths.eventsWs, target), handlers)
}

/**
 * Subscribes to a task's stats stream: the first frame of a connection carries the window so far, later frames carry
 * new samples. Returns a function that closes the socket.
 */
export function openTaskStats(
  taskId: string,
  handlers: { onFrame: (stats: TaskStats) => void; onClose: () => void },
): () => void {
  return openSocket(
    async () => socketUrl(Paths.taskStatsWs(taskId), await taskTarget(taskId)),
    (socket) => {
      socket.onmessage = (msg: MessageEvent<unknown>) => {
        if (typeof msg.data !== "string") return
        const stats = decodeText(TaskStats, msg.data)
        if (stats) handlers.onFrame(stats)
      }
      socket.onclose = handlers.onClose
    },
    handlers.onClose,
  )
}

/**
 * Where a desktop stream connects: a task on the box its thread lives on, or an explicit WebSocket URL (the embed,
 * whose URL carries its own auth query).
 */
export type DesktopSource = { taskId: string } | { url: string }

export interface DesktopHandlers {
  onStatus: (status: DesktopStatus) => void
  onSignal: (message: DesktopRtcServerMessage) => void
  /**
   * The socket closed, or never opened (`code` null). `opened` tells a refused or failed handshake from a stream that
   * dropped after it was live.
   */
  onClose: (close: { code: number | null; opened: boolean }) => void
}

export interface DesktopConnection {
  /** WebRTC signaling to the box; no-op until the socket is open. */
  send: (message: DesktopRtcClientMessage) => void
  close: () => void
}

/** Opens the desktop WebSocket: DesktopStatus text frames and WebRTC signaling, both ways. Media and input are WebRTC. */
export function openDesktopStream(source: DesktopSource, handlers: DesktopHandlers): DesktopConnection {
  let socket: WebSocket | undefined
  let opened = false
  const closeSocket = openSocket(
    async () => {
      if ("url" in source) return source.url
      return socketUrl(Paths.taskDesktopWs(source.taskId), await taskTarget(source.taskId))
    },
    (ws) => {
      socket = ws
      ws.onopen = () => {
        opened = true
      }
      ws.onmessage = (msg: MessageEvent<unknown>) => {
        if (typeof msg.data !== "string") return
        const status = decodeText(DesktopStatus, msg.data)
        if (status) {
          handlers.onStatus(status)
          return
        }
        const signal = decodeText(DesktopRtcServerMessage, msg.data)
        if (signal) handlers.onSignal(signal)
      }
      ws.onclose = (ev) => handlers.onClose({ code: ev.code, opened })
    },
    () => handlers.onClose({ code: null, opened: false }),
  )
  return {
    send: (message) => {
      if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify(message))
    },
    close: closeSocket,
  }
}
