import type { IncomingMessage, Server } from "node:http"
import type { Duplex } from "node:stream"
import { Runtime } from "effect"
import { WebSocket, WebSocketServer } from "ws"
import { serveStream, streamRoute, type StreamSocket, type WsServices } from "./streams"

/** Adapts a node `ws` socket to the transport-agnostic StreamSocket used by the stream handlers. */
export const nodeStreamSocket = (ws: WebSocket): StreamSocket => ({
  sendText: (data) => {
    if (ws.readyState === WebSocket.OPEN) ws.send(data)
  },
  sendBinary: (data) => {
    if (ws.readyState === WebSocket.OPEN) ws.send(data)
  },
  close: (code, reason) => ws.close(code, reason),
  onText: (listener) => {
    ws.on("message", (data: WebSocket.RawData) => listener(data.toString()))
  },
  onClose: (listener) => {
    if (ws.readyState === WebSocket.CLOSED) listener()
    else ws.once("close", () => listener())
  },
})

/**
 * Attaches the WebSocket endpoints to an existing node http server via the upgrade event.
 * Unknown upgrade paths are destroyed.
 */
export const attachWebSockets = (server: Server, runtime: Runtime.Runtime<WsServices>): WebSocketServer => {
  const runFork = Runtime.runFork(runtime)
  const wss = new WebSocketServer({ noServer: true })

  server.on("upgrade", (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    const route = streamRoute(new URL(req.url ?? "/", "http://localhost").pathname)
    if (!route) {
      socket.destroy()
      return
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      runFork(serveStream(route, nodeStreamSocket(ws)))
    })
  })

  return wss
}
