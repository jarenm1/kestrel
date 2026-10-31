import { WebSocket } from "ws"
import type { StreamSocket } from "../http/streams"

/**
 * Adapts a `ws` socket to the StreamSocket the stream routes serve. Text received before a listener is registered is
 * held and delivered on registration; sends on a closed socket are dropped; text arriving once the socket is closing is dropped; the close listeners run once.
 */
export const wsStreamSocket = (ws: WebSocket): StreamSocket => {
  let open = true
  let textListener: ((data: string) => void) | null = null
  const pendingText: string[] = []
  const closeListeners: Array<() => void> = []

  const finish = (): void => {
    if (!open) return
    open = false
    for (const listener of closeListeners.splice(0)) listener()
  }

  ws.on("message", (data, isBinary) => {
    if (isBinary || !open || ws.readyState !== WebSocket.OPEN) return
    const text = data.toString()
    if (textListener === null) pendingText.push(text)
    else textListener(text)
  })
  ws.on("close", finish)
  ws.on("error", finish)

  return {
    sendText: (data) => {
      if (open && ws.readyState === WebSocket.OPEN) ws.send(data)
    },
    sendBinary: (data) => {
      if (open && ws.readyState === WebSocket.OPEN) ws.send(data)
    },
    close: (code, reason) => {
      if (!open) return
      ws.close(code, reason)
      finish()
    },
    onText: (listener) => {
      textListener = listener
      for (const text of pendingText.splice(0)) listener(text)
    },
    onClose: (listener) => {
      if (open) closeListeners.push(listener)
      else listener()
    },
  }
}
