import { randomUUID } from "node:crypto"
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
   * Asks the guest for the GPU (`true`) or releases it (`false`). Resolves when the guest answers this wish: ok once the
   * GPU is attached (or released), rejects when it denies. The current wish is sent again, with the same id, on every new
   * connection, so a wish or a release made while disconnected still reaches the guest.
   */
  readonly setWanted: (wanted: boolean) => Promise<void>
  /** The box enrolled and saved its secret: the guest drops the enrollment token from its env file. Sent on every connection. */
  readonly markEnrolled: () => void
  /** Sends the current activity now, even when unchanged. */
  readonly sendActivityNow: () => void
  readonly close: () => void
}

/**
 * Keeps one connection to the guest agent: sends hello, activity, the GPU wish and enrollment, and answers the guest's requests.
 * A frame longer than the contract allows, or a dropped connection, closes the link; it reconnects with backoff. A
 * frame that does not decode (unknown tags included) is ignored, so a newer guest cannot break an older box.
 */
export const startGuestLink = (options: GuestLinkOptions): GuestLink => {
  const minMs = options.reconnectMinMs ?? 1_000
  const maxMs = options.reconnectMaxMs ?? 30_000
  const pollMs = options.pollMs ?? 1_000
  const heartbeatMs = options.heartbeatMs ?? BOX_ACTIVITY_INTERVAL_MS

  let socket: Socket | null = null
  // True from the socket's connect until its close: a frame made while connecting is sent by the connect replay.
  let connected = false
  let closed = false
  // The current GPU wish, with the id the guest answers it under. Replayed on every new connection.
  let wish: { readonly id: string; readonly wanted: boolean } | null = null
  // Wishes the guest has not answered yet, by id.
  const awaiting = new Map<string, { resolve: () => void; reject: (error: Error) => void }>()
  // Once enrolled, every new connection tells the guest, so it drops the enrollment token from the env file.
  let enrolled = false
  let delay = minMs
  let reconnectTimer: NodeJS.Timeout | undefined
  let lastSent: string | null = null
  let lastSentAt = 0
  let inbox: Promise<void> = Promise.resolve()

  const write = (frame: BoxToGuest): boolean => {
    if (socket === null || !connected || socket.destroyed || !socket.writable) return false
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
      case "reply": {
        const waiter = awaiting.get(frame.id)
        if (waiter === undefined) return
        awaiting.delete(frame.id)
        if (frame.ok) waiter.resolve()
        else waiter.reject(new Error(frame.error ?? "the guest refused the request"))
        return
      }
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
      connected = true
      delay = minMs
      write({ _tag: "hello", boxVersion: options.boxVersion })
      if (wish !== null) write({ _tag: "gpuWanted", id: wish.id, wanted: wish.wanted })
      if (enrolled) write({ _tag: "enrolled" })
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
      connected = false
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
      const next = { id: randomUUID(), wanted: value }
      const previous = wish
      wish = next
      const answer = new Promise<void>((resolve, reject) => {
        if (closed) reject(new Error("the box is stopping"))
        else awaiting.set(next.id, { resolve, reject })
      })
      // The guest answers only the latest wish (the reconnect replay carries only it), so an older wish still waiting is
      // settled by this answer when it asks for the same state, and refused when it asks for the other one.
      const superseded = previous === null ? undefined : awaiting.get(previous.id)
      if (previous !== null && superseded !== undefined) {
        awaiting.delete(previous.id)
        if (previous.wanted === value) answer.then(superseded.resolve, superseded.reject)
        else
          superseded.reject(
            new Error(value ? "the GPU was requested again before the release finished" : "the GPU was released before it attached"),
          )
      }
      // A caller that does not await the answer (a release, a withdrawn wish) still gets its failure logged.
      answer.catch((error: unknown) =>
        options.warn(
          `guest GPU ${value ? "request" : "release"} failed: ${error instanceof Error ? error.message : String(error)}`,
        ),
      )
      write({ _tag: "gpuWanted", id: next.id, wanted: value })
      return answer
    },
    markEnrolled: () => {
      enrolled = true
      write({ _tag: "enrolled" })
    },
    sendActivityNow: () => sendActivity(true),
    close: () => {
      closed = true
      clearInterval(poll)
      clearTimeout(reconnectTimer)
      socket?.destroy()
      socket = null
      for (const waiter of awaiting.values()) waiter.reject(new Error("the box is stopping"))
      awaiting.clear()
    },
  }
}
