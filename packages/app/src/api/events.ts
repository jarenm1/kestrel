import { Either, Schema } from "effect"
import { DesktopAck, DesktopInput, DesktopStatus, Paths, ServerEvent } from "@cloudagents/protocol"
import { WS_URL } from "@/config"

function decodeText<A, I>(schema: Schema.Schema<A, I>, text: string): A | null {
  try {
    const result = Schema.decodeUnknownEither(schema)(JSON.parse(text))
    return Either.isRight(result) ? result.right : null
  } catch {
    return null
  }
}

/**
 * Subscribes to a task's ServerEvent stream. Callers re-snapshot over REST in `onOpen`; events that race
 * the snapshot are reconciled by id. Returns a function that closes the socket.
 */
export function openTaskEvents(
  taskId: string,
  handlers: { onOpen: () => void; onEvent: (event: ServerEvent) => void; onClose: () => void },
): () => void {
  const socket = new WebSocket(WS_URL + Paths.taskEventsWs(taskId))
  socket.onopen = handlers.onOpen
  socket.onmessage = (msg: MessageEvent<unknown>) => {
    if (typeof msg.data !== "string") return
    const event = decodeText(ServerEvent, msg.data)
    if (event) handlers.onEvent(event)
  }
  socket.onclose = handlers.onClose
  return () => {
    socket.onclose = null
    socket.close()
  }
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

/** Acks go out after this many binary frames or this long, whichever comes first, so the server bounds what is in flight. */
const ACK_EVERY_FRAMES = 6
const ACK_EVERY_MS = 100

/** Opens the desktop stream WebSocket: status text frames, fMP4 binary frames, input and ack text frames. */
export function openDesktopStream(taskId: string, handlers: DesktopHandlers): DesktopConnection {
  const socket = new WebSocket(WS_URL + Paths.taskDesktopWs(taskId))
  socket.binaryType = "arraybuffer"
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
    if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(ack))
  }
  socket.onmessage = (msg: MessageEvent<unknown>) => {
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
  socket.onclose = handlers.onClose
  return {
    send: (input) => {
      if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(input))
    },
    close: () => {
      socket.onclose = null
      window.clearTimeout(ackTimer)
      socket.close()
    },
  }
}
