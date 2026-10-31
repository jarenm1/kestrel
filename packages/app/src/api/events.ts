import { Either, Schema } from "effect"
import { DesktopAck, DesktopInput, DesktopStatus, Paths, ServerEvent, TaskStats } from "@cloudagents/protocol"
import { socketUrl } from "@/api/client"

function decodeText<A, I>(schema: Schema.Schema<A, I>, text: string): A | null {
  try {
    const result = Schema.decodeUnknownEither(schema)(JSON.parse(text))
    return Either.isRight(result) ? result.right : null
  } catch {
    return null
  }
}

/**
 * Opens a WebSocket to `path` once its URL is resolved (a user box's URL carries a fresh token), then hands it to
 * `attach`. Returns a function that closes it without firing `onClose`; closing before the socket exists cancels the
 * open. A failure to resolve the URL reports through `onFailure`.
 */
function openSocket(path: string, attach: (socket: WebSocket) => void, onFailure: () => void): () => void {
  let socket: WebSocket | undefined
  let closed = false
  socketUrl(path).then(
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
  path: string,
  handlers: { onOpen: () => void; onEvent: (event: ServerEvent) => void; onClose: () => void },
): () => void {
  return openSocket(
    path,
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
 * Subscribes to a task's ServerEvent stream. Callers re-snapshot over REST in `onOpen`; events that race
 * the snapshot are reconciled by id. Returns a function that closes the socket.
 */
export function openTaskEvents(
  taskId: string,
  handlers: { onOpen: () => void; onEvent: (event: ServerEvent) => void; onClose: () => void },
): () => void {
  return openEvents(Paths.taskEventsWs(taskId), handlers)
}

/** Subscribes to the signed-in user's thread list stream: `task.updated` for its own threads and `task.deleted`. */
export function openUserEvents(handlers: {
  onOpen: () => void
  onEvent: (event: ServerEvent) => void
  onClose: () => void
}): () => void {
  return openEvents(Paths.eventsWs, handlers)
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
    Paths.taskStatsWs(taskId),
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

export interface DesktopHandlers {
  onStatus: (status: DesktopStatus) => void
  /** Binary frames: first is the init segment, then media fragments. */
  onMedia: (bytes: Uint8Array<ArrayBuffer>) => void
  onClose: () => void
}

export interface DesktopConnection {
  send: (input: DesktopInput) => void
  close: () => void
}

/**
 * Acks go out after this many binary messages or this long, whichever comes first, so the server bounds what is in
 * flight. Acks are billed relay messages, hence the spacing: the lag an ack reports is about this interval plus a
 * round trip, and the box's resync threshold (FLOW_LAG_LOW_MS = 400) has to sit above that. One message may carry
 * several fragments when the box bundles them; acks count messages, as the box's flow control does.
 */
const ACK_EVERY_FRAMES = 15
const ACK_EVERY_MS = 250

/** Opens the desktop stream WebSocket: status text frames, fMP4 binary frames, input and ack text frames. */
export function openDesktopStream(taskId: string, handlers: DesktopHandlers): DesktopConnection {
  let socket: WebSocket | undefined
  let received = 0
  let acked = 0
  let ackedAt = performance.now()
  let ackTimer: number | undefined
  const sendAck = () => {
    window.clearTimeout(ackTimer)
    ackTimer = undefined
    acked = received
    ackedAt = performance.now()
    const ack: DesktopAck = { _tag: "stream.ack", frames: received }
    if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify(ack))
  }
  const closeSocket = openSocket(
    Paths.taskDesktopWs(taskId),
    (opened) => {
      socket = opened
      opened.binaryType = "arraybuffer"
      opened.onmessage = (msg: MessageEvent<unknown>) => {
        if (typeof msg.data === "string") {
          const status = decodeText(DesktopStatus, msg.data)
          if (status) handlers.onStatus(status)
          return
        }
        if (!(msg.data instanceof ArrayBuffer)) return
        received++
        if (received - acked >= ACK_EVERY_FRAMES || performance.now() - ackedAt >= ACK_EVERY_MS) sendAck()
        else ackTimer ??= window.setTimeout(sendAck, ACK_EVERY_MS)
        handlers.onMedia(new Uint8Array(msg.data))
      }
      opened.onclose = handlers.onClose
    },
    handlers.onClose,
  )
  return {
    send: (input) => {
      if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify(input))
    },
    close: () => {
      window.clearTimeout(ackTimer)
      closeSocket()
    },
  }
}
