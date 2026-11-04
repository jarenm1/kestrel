import { createConnection, type Socket } from "node:net"
import { Either } from "effect"
import {
  BOX_ACTIVITY_INTERVAL_MS,
  MAX_GUEST_FRAME_BYTES,
  decodeGuestToBox,
  type BoxActivity,
  type BoxToGuest,
  type GpuState,
  type GuestToBox,
} from "@cloudagents/protocol"

/** What the box does when the guest asks. Each handler settles once; a rejection is sent back as a failed reply. */
export interface GuestHandlers {
  readonly quiesce: () => Promise<void>
  readonly resumed: () => Promise<void>
  readonly releaseGpu: () => Promise<void>
  /** Not a request: nothing is sent back. Calls are serialized with the requests, in arrival order. */
  readonly gpuState: (state: GpuState, pciAddress: string | null) => Promise<void>
}

export interface GuestLinkOptions {
  readonly socketPath: string
  readonly boxVersion: string
  readonly activity: () => BoxActivity
  readonly handlers: GuestHandlers
  readonly warn: (message: string) => void
  /** Reconnect backoff, doubling from min to max. Defaults: 1 s to 30 s, as the relay's. */
  readonly reconnectMinMs?: number
  readonly reconnectMaxMs?: number
  /** How often the box checks its activity for a change, and the heartbeat interval. Defaults: 1 s and the contract's. */
  readonly pollMs?: number
  readonly heartbeatMs?: number
}

export interface GuestLink {
  /**
   * Asks the guest for the GPU (`true`) or releases it (`false`). The wish is kept across reconnects: it is sent again
   * on every new connection while it holds.
   */
  readonly setWanted: (wanted: boolean) => void
  /** Sends the current activity now, even when unchanged. */
  readonly sendActivityNow: () => void
  readonly close: () => void
}

/**
 * Keeps one connection to the guest agent: sends hello, activity and the GPU wish, and answers the guest's requests.
 * A frame longer than the contract allows, or a dropped connection, closes the link; it reconnects with backoff. A
 * frame that does not decode (unknown tags included) is ignored, so a newer guest cannot break an older box.
 */
export const startGuestLink = (options: GuestLinkOptions): GuestLink => {
  const minMs = options.reconnectMinMs ?? 1_000
  const maxMs = options.reconnectMaxMs ?? 30_000
  const pollMs = options.pollMs ?? 1_000
  const heartbeatMs = options.heartbeatMs ?? BOX_ACTIVITY_INTERVAL_MS

  let socket: Socket | null = null
  let closed = false
  let wanted = false
  let delay = minMs
  let reconnectTimer: NodeJS.Timeout | undefined
  let lastSent: string | null = null
  let lastSentAt = 0
  let inbox: Promise<void> = Promise.resolve()

  const write = (frame: BoxToGuest): boolean => {
    if (socket === null || socket.destroyed || !socket.writable) return false
    socket.write(`${JSON.stringify(frame)}\n`)
    return true
  }

  const sendActivity = (force: boolean): void => {
    if (socket === null) return
    const activity = options.activity()
    const json = JSON.stringify(activity)
    const now = Date.now()
    if (!force && json === lastSent && now - lastSentAt < heartbeatMs) return
    if (!write({ _tag: "activity", activity })) return
    lastSent = json
    lastSentAt = now
  }

  const reply = async (id: string, handler: () => Promise<void>): Promise<void> => {
    try {
      await handler()
      write({ _tag: "reply", id, ok: true })
    } catch (error) {
      write({ _tag: "reply", id, ok: false, error: error instanceof Error ? error.message : String(error) })
    }
  }

  const handle = async (frame: GuestToBox): Promise<void> => {
    switch (frame._tag) {
      case "quiesce":
        return reply(frame.id, options.handlers.quiesce)
      case "resumed":
        return reply(frame.id, options.handlers.resumed)
      case "releaseGpu":
        return reply(frame.id, options.handlers.releaseGpu)
      case "gpuState":
        try {
          await options.handlers.gpuState(frame.state, frame.pciAddress)
        } catch (error) {
          options.warn(`guest gpuState ${frame.state} failed: ${error instanceof Error ? error.message : String(error)}`)
        }
        return
      case "reply":
        return
    }
  }

  const receive = (line: string): void => {
    const decoded = decodeGuestToBox(line)
    if (Either.isLeft(decoded)) return
    inbox = inbox.then(() => handle(decoded.right))
  }

  const connect = (): void => {
    reconnectTimer = undefined
    if (closed) return
    const current = createConnection(options.socketPath)
    socket = current
    let buffered: Buffer = Buffer.alloc(0)

    current.on("connect", () => {
      delay = minMs
      write({ _tag: "hello", boxVersion: options.boxVersion })
      if (wanted) write({ _tag: "gpuWanted", wanted: true })
      sendActivity(true)
    })

    current.on("data", (chunk: Buffer) => {
      buffered = Buffer.concat([buffered, chunk])
      for (;;) {
        const newline = buffered.indexOf(0x0a)
        if (newline === -1) {
          if (buffered.length > MAX_GUEST_FRAME_BYTES) {
            options.warn("guest frame exceeds the frame limit; reconnecting")
            current.destroy()
          }
          return
        }
        if (newline > MAX_GUEST_FRAME_BYTES) {
          options.warn("guest frame exceeds the frame limit; reconnecting")
          current.destroy()
          return
        }
        const line = buffered.subarray(0, newline).toString("utf8")
        buffered = buffered.subarray(newline + 1)
        if (line !== "") receive(line)
      }
    })

    current.on("error", (error) => {
      options.warn(`guest agent link: ${(error as NodeJS.ErrnoException).code ?? error.message}`)
    })

    current.on("close", () => {
      if (socket === current) socket = null
      if (closed) return
      const wait = delay
      delay = Math.min(delay * 2, maxMs)
      reconnectTimer = setTimeout(connect, wait)
    })
  }

  connect()
  const poll = setInterval(() => sendActivity(false), pollMs)

  return {
    setWanted: (value) => {
      wanted = value
      write({ _tag: "gpuWanted", wanted: value })
    },
    sendActivityNow: () => sendActivity(true),
    close: () => {
      closed = true
      clearInterval(poll)
      clearTimeout(reconnectTimer)
      socket?.destroy()
      socket = null
    },
  }
}
