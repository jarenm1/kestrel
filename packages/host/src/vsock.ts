import { randomUUID } from "node:crypto"
import { createConnection, type Socket } from "node:net"
import {
  decodeGuestToHost,
  GUEST_AGENT_VSOCK_PORT,
  MAX_GUEST_FRAME_BYTES,
  type GuestReply,
  type GuestToHost,
  type HostToGuest,
} from "@cloudagents/protocol"
import { sleep } from "./proc"

const NEWLINE = 0x0a
const HANDSHAKE_TIMEOUT_MS = 10_000

/** A line longer than the frame cap: the peer is broken or hostile; the connection is dropped. */
export class FrameTooLongError extends Error {}

/** The guest did not answer a request within its timeout. */
export class GuestTimeoutError extends Error {}

/** The vsock connection is closed; pending requests fail with this. */
export class GuestClosedError extends Error {}

/** Splits a byte stream into newline-terminated lines, enforcing a per-line byte cap. */
export class LineFramer {
  private pending: Buffer = Buffer.alloc(0)

  constructor(private readonly maxLineBytes: number) {}

  push(chunk: Buffer): string[] {
    this.pending = Buffer.concat([this.pending, chunk])
    const lines: string[] = []
    let start = 0
    let newline = this.pending.indexOf(NEWLINE, start)
    while (newline !== -1) {
      if (newline - start > this.maxLineBytes) throw new FrameTooLongError(`line exceeds ${this.maxLineBytes} bytes`)
      lines.push(this.pending.subarray(start, newline).toString("utf8"))
      start = newline + 1
      newline = this.pending.indexOf(NEWLINE, start)
    }
    if (this.pending.length - start > this.maxLineBytes) throw new FrameTooLongError(`line exceeds ${this.maxLineBytes} bytes`)
    this.pending = this.pending.subarray(start)
    return lines
  }
}

type Waiter = { readonly resolve: (reply: GuestReply) => void; readonly reject: (error: Error) => void; readonly timer: Timer }

/**
 * A hybrid-vsock connection from the host to the guest agent: the VMM's unix socket, `CONNECT <port>`, `OK <port>`,
 * then newline-delimited JSON frames. Requests carry an `id` and are answered by a `reply` with the same id.
 */
export class GuestLink {
  private readonly pending = new Map<string, Waiter>()
  private readonly frameHandlers: ((frame: GuestToHost) => void)[] = []
  /** Frames that arrived before the first handler was registered (e.g. a hello sent with the handshake). */
  private backlog: GuestToHost[] = []
  private readonly closeHandlers: (() => void)[] = []
  private closed = false

  private constructor(private readonly socket: Socket) {
    socket.on("close", () => this.close())
    socket.on("error", () => this.close())
  }

  /** Connects, completes the handshake, and returns once the guest accepted the port. */
  static connect(socketPath: string, port: number = GUEST_AGENT_VSOCK_PORT): Promise<GuestLink> {
    const { promise, resolve, reject } = Promise.withResolvers<GuestLink>()
    const socket = createConnection({ path: socketPath })
    const framer = new LineFramer(MAX_GUEST_FRAME_BYTES)
    let link: GuestLink | null = null
    const timer = setTimeout(() => {
      socket.destroy()
      reject(new GuestTimeoutError(`vsock handshake with ${socketPath} timed out`))
    }, HANDSHAKE_TIMEOUT_MS)
    const fail = (error: Error) => {
      clearTimeout(timer)
      socket.destroy()
      reject(error)
    }
    socket.on("connect", () => socket.write(`CONNECT ${port}\n`))
    socket.on("error", (error) => fail(error))
    socket.on("close", () => fail(new GuestClosedError("vsock closed during handshake")))
    socket.on("data", (chunk) => {
      let lines: string[]
      try {
        lines = framer.push(chunk)
      } catch (error) {
        fail(error instanceof Error ? error : new Error(String(error)))
        return
      }
      if (link === null) {
        const [handshake, ...rest] = lines
        if (handshake === undefined) return
        if (!handshake.startsWith("OK ")) {
          fail(new GuestClosedError(`vsock refused port ${port}: ${handshake}`))
          return
        }
        clearTimeout(timer)
        link = new GuestLink(socket)
        resolve(link)
        for (const line of rest) link.receive(line)
        return
      }
      for (const line of lines) link.receive(line)
    })
    return promise
  }

  /**
   * Registers a handler for every decodable guest frame (hello, status, gpuWanted). Frames received before the first
   * handler was registered are replayed to it, in order.
   */
  onFrame(handler: (frame: GuestToHost) => void): void {
    this.frameHandlers.push(handler)
    const backlog = this.backlog
    this.backlog = []
    for (const frame of backlog) handler(frame)
  }

  onClose(handler: () => void): void {
    this.closeHandlers.push(handler)
  }

  isClosed(): boolean {
    return this.closed
  }

  /** Sends a request and waits for its reply. Resolves with the reply, which may report `ok: false`. */
  request(frame: HostToGuest, timeoutMs: number): Promise<GuestReply> {
    if (this.closed) return Promise.reject(new GuestClosedError("guest connection is closed"))
    const { promise, resolve, reject } = Promise.withResolvers<GuestReply>()
    const timer = setTimeout(() => {
      this.pending.delete(frame.id)
      reject(new GuestTimeoutError(`guest did not answer ${frame._tag} within ${timeoutMs} ms`))
    }, timeoutMs)
    this.pending.set(frame.id, { resolve, reject, timer })
    this.write(frame)
    return promise
  }

  /** Sends a frame that expects no reply. */
  send(frame: HostToGuest): void {
    if (this.closed) throw new GuestClosedError("guest connection is closed")
    this.write(frame)
  }

  private write(frame: HostToGuest): void {
    this.socket.write(`${JSON.stringify(frame)}\n`)
  }

  private receive(line: string): void {
    const decoded = decodeGuestToHost(line)
    if (decoded._tag === "Left") return
    const frame = decoded.right
    if (frame._tag === "reply") {
      const waiter = this.pending.get(frame.id)
      if (waiter === undefined) return
      this.pending.delete(frame.id)
      clearTimeout(waiter.timer)
      waiter.resolve(frame)
      return
    }
    if (this.frameHandlers.length === 0) {
      this.backlog.push(frame)
      return
    }
    for (const handler of this.frameHandlers) handler(frame)
  }

  /** Closes the connection and fails every pending request. Idempotent. */
  close(): void {
    if (this.closed) return
    this.closed = true
    for (const [id, waiter] of this.pending) {
      clearTimeout(waiter.timer)
      this.pending.delete(id)
      waiter.reject(new GuestClosedError("guest connection closed"))
    }
    this.socket.destroy()
    for (const handler of this.closeHandlers) handler()
  }
}

export type GuestHello = Extract<GuestToHost, { readonly _tag: "hello" }>

/** Resolves with the guest's hello, or null when the link closes or `timeoutMs` passes first. */
const waitForHello = (link: GuestLink, timeoutMs: number): Promise<GuestHello | null> => {
  const { promise, resolve } = Promise.withResolvers<GuestHello | null>()
  const timer = setTimeout(() => resolve(null), timeoutMs)
  link.onFrame((frame) => {
    if (frame._tag !== "hello") return
    clearTimeout(timer)
    resolve(frame)
  })
  link.onClose(() => {
    clearTimeout(timer)
    resolve(null)
  })
  return promise
}

/**
 * Connects to a guest agent that may still be booting. Retries until the guest accepts the port and sends its hello,
 * and throws after `timeoutMs`.
 */
export const connectGuest = async (
  socketPath: string,
  timeoutMs: number,
): Promise<{ readonly link: GuestLink; readonly hello: GuestHello }> => {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    try {
      const link = await GuestLink.connect(socketPath)
      const hello = await waitForHello(link, Math.max(0, deadline - Date.now()))
      if (hello !== null) return { link, hello }
      link.close()
    } catch {
      // the guest is not listening yet; retry below
    }
    if (Date.now() >= deadline) throw new GuestTimeoutError(`guest agent did not say hello within ${timeoutMs} ms`)
    await sleep(250)
  }
}

/** A fresh request id for host -> guest requests. */
export const newRequestId = (): string => randomUUID()
