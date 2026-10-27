import { Either, Schema } from "effect"
import { DesktopInput, DesktopStatus, Paths, ServerEvent } from "@cloudagents/protocol"
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

/** Opens the desktop stream WebSocket: status text frames, fMP4 binary frames, input text frames. */
export function openDesktopStream(taskId: string, handlers: DesktopHandlers): DesktopConnection {
  const socket = new WebSocket(WS_URL + Paths.taskDesktopWs(taskId))
  socket.binaryType = "arraybuffer"
  socket.onmessage = (msg: MessageEvent<unknown>) => {
    if (typeof msg.data === "string") {
      const status = decodeText(DesktopStatus, msg.data)
      if (status) handlers.onStatus(status)
      return
    }
    if (msg.data instanceof ArrayBuffer) handlers.onMedia(new Uint8Array(msg.data))
  }
  socket.onclose = handlers.onClose
  return {
    send: (input) => {
      if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(input))
    },
    close: () => {
      socket.onclose = null
      socket.close()
    },
  }
}
