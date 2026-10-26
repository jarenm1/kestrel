import { encodeBinary, encodeFrame } from "@cloudagents/protocol"
import type { StreamSocket } from "../http/streams"

/**
 * Box-side end of one WebSocket the control plane tunnels over the relay connection.
 * It implements StreamSocket so the shared stream handlers run unchanged. Text that arrives
 * before a listener is registered is buffered so no early message is lost.
 */
export class RelayStream implements StreamSocket {
  readonly id: number
  private readonly send: (data: string | Uint8Array) => void
  private open = true
  private textListener: ((data: string) => void) | null = null
  private readonly pendingText: string[] = []
  private closeListeners: Array<() => void> = []

  constructor(id: number, send: (data: string | Uint8Array) => void) {
    this.id = id
    this.send = send
  }

  sendText(data: string): void {
    if (this.open) this.send(encodeFrame({ t: "ws-text", id: this.id, data }))
  }

  sendBinary(data: Uint8Array): void {
    if (this.open) this.send(encodeBinary(this.id, data))
  }

  close(code?: number, reason?: string): void {
    if (!this.open) return
    this.send(encodeFrame({ t: "ws-close", id: this.id, code, reason }))
    this.finish()
  }

  onText(listener: (data: string) => void): void {
    this.textListener = listener
    for (const data of this.pendingText.splice(0)) listener(data)
  }

  onClose(listener: () => void): void {
    if (this.open) this.closeListeners.push(listener)
    else listener()
  }

  /** Delivers a text message from the browser. */
  receiveText(data: string): void {
    if (!this.open) return
    if (this.textListener) this.textListener(data)
    else this.pendingText.push(data)
  }

  /** The browser left (or the relay dropped): closes locally without echoing a `ws-close`. */
  receiveClose(): void {
    this.finish()
  }

  private finish(): void {
    if (!this.open) return
    this.open = false
    const listeners = this.closeListeners
    this.closeListeners = []
    for (const listener of listeners) listener()
  }
}
