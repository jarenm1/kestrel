import {
  ControlPaths,
  MAX_NEST_FRAME_BYTES,
  NEST_CAPACITY_INTERVAL_MS,
  NEST_HOST_ID_HEADER,
  NEST_HOST_PROTOCOL,
  NEST_INVENTORY_CHUNK_VMS,
  decodeNestControlFrame,
  type NestHostCommand,
  type NestHostFrame,
  type NestVmReport,
} from "@cloudagents/protocol"
import { WebSocket, type RawData } from "ws"
import { errorMessage } from "./errors"
import type { VmManager } from "./vm-manager"

const BACKOFF_MIN_MS = 1_000
const BACKOFF_MAX_MS = 60_000
/** After a refusal (unknown host, bad secret, protocol mismatch) an operator has to act; retry slowly. */
const REFUSED_RETRY_MS = 10 * 60_000

export interface ControlLinkOptions {
  readonly controlUrl: string
  readonly hostId: string
  readonly secret: string
  readonly slug: string
  readonly agentVersion: string
  readonly imageId: string
  readonly manager: VmManager
  readonly log: (message: string) => void
}

/**
 * The host's one WebSocket to the control plane (`ControlPaths.nestHostConnect`). It reports the host's state on every
 * connection (`hello`), capacity once a minute, and VM changes as they happen; it runs the control plane's commands
 * through the manager and answers each with a `result`. Results are kept until a live socket carries them, so a
 * command that finishes while disconnected is reported on the next `hello`.
 */
export class ControlLink {
  private socket: WebSocket | null = null
  private retryTimer: NodeJS.Timeout | undefined
  private capacityTimer: NodeJS.Timeout | undefined
  private backoffMs = BACKOFF_MIN_MS
  private refused = false
  private stopped = false

  constructor(private readonly opts: ControlLinkOptions) {}

  start(): void {
    this.connect()
  }

  stop(): void {
    this.stopped = true
    clearTimeout(this.retryTimer)
    this.retryTimer = undefined
    this.socket?.close()
  }

  /** A VM changed. Not sent while disconnected: the next `hello` carries every VM. */
  sendVm(vm: NestVmReport): void {
    this.send({ _tag: "vm", vm })
  }

  /** A request reached ingress for a box this host may not wake by itself. */
  sendWakeRequest(boxId: string): void {
    this.send({ _tag: "wakeRequest", boxId })
  }

  private connect(): void {
    const url = new URL(ControlPaths.nestHostConnect, this.opts.controlUrl).toString()
    let socket: WebSocket
    try {
      socket = new WebSocket(url, {
        headers: {
          authorization: `Bearer ${this.opts.secret}`,
          [NEST_HOST_ID_HEADER]: this.opts.hostId,
        },
        maxPayload: MAX_NEST_FRAME_BYTES,
      })
    } catch (error) {
      this.opts.log(`cannot dial the control plane: ${errorMessage(error)}`)
      this.retryLater()
      return
    }
    this.socket = socket
    socket.on("open", () => this.onOpen(socket))
    socket.on("message", (data, isBinary) => this.onMessage(socket, data, isBinary))
    socket.on("error", () => this.opts.log("control link error"))
    socket.on("close", () => this.onClose(socket))
  }

  private onOpen(socket: WebSocket): void {
    if (socket !== this.socket) return
    this.backoffMs = BACKOFF_MIN_MS
    const sent = this.send({
      _tag: "hello",
      protocol: NEST_HOST_PROTOCOL,
      hostId: this.opts.hostId,
      agentVersion: this.opts.agentVersion,
      slug: this.opts.slug,
      imageId: this.opts.imageId,
      capacity: this.opts.manager.capacity(),
    })
    if (!sent) return
    this.sendPendingResults()
    this.sendInventory()
    this.capacityTimer = setInterval(
      () => this.send({ _tag: "capacity", capacity: this.opts.manager.capacity() }),
      NEST_CAPACITY_INTERVAL_MS,
    )
  }

  /** Results of commands that finished while disconnected. Each one stays stored until a frame carrying it is sent. */
  private sendPendingResults(): void {
    for (const result of this.opts.manager.pendingResults()) {
      const sent = this.send({
        _tag: "result",
        commandId: result.commandId,
        ok: result.ok,
        ...(result.error !== undefined ? { error: result.error } : {}),
      })
      if (sent) this.opts.manager.markReported([result.commandId])
    }
  }

  /** The host's VMs in chunks; the last chunk is marked, and the control plane evicts stale copies only after it. */
  private sendInventory(): void {
    const vms = this.opts.manager.reports()
    let offset = 0
    do {
      const chunk = vms.slice(offset, offset + NEST_INVENTORY_CHUNK_VMS)
      offset += NEST_INVENTORY_CHUNK_VMS
      if (!this.send({ _tag: "inventory", vms: chunk, last: offset >= vms.length })) return
    } while (offset < vms.length)
  }

  private onMessage(socket: WebSocket, data: RawData, isBinary: boolean): void {
    if (socket !== this.socket) return
    if (isBinary) return this.drop(socket, "binary frame")
    const decoded = decodeNestControlFrame(data.toString())
    if (decoded._tag === "Left") return this.drop(socket, "frame does not decode")
    const frame = decoded.right
    switch (frame._tag) {
      case "command":
        void this.runCommand(frame.commandId, frame.command)
        return
      case "lease":
        this.opts.manager.setLease(frame.validUntil)
        return
      case "refused":
        this.opts.log(`control plane refused the connection: ${frame.reason}`)
        this.refused = true
        socket.close()
        return
    }
  }

  private async runCommand(commandId: string, command: NestHostCommand): Promise<void> {
    const { outcome, vm } = await this.opts.manager.execute(commandId, command)
    const sent = this.send({
      _tag: "result",
      commandId,
      ok: outcome.ok,
      ...(outcome.error !== undefined ? { error: outcome.error } : {}),
      ...(vm !== null ? { vm } : {}),
    })
    if (sent) this.opts.manager.markReported([commandId])
  }

  private onClose(socket: WebSocket): void {
    if (socket !== this.socket) return
    this.socket = null
    clearInterval(this.capacityTimer)
    this.capacityTimer = undefined
    if (this.stopped) return
    this.retryLater()
  }

  private drop(socket: WebSocket, reason: string): void {
    this.opts.log(`dropping the control connection: ${reason}`)
    socket.close()
  }

  /** Reconnects after a jittered delay that doubles up to `BACKOFF_MAX_MS` (or `REFUSED_RETRY_MS` after a refusal). */
  private retryLater(): void {
    if (this.stopped || this.retryTimer !== undefined) return
    const wait = this.refused ? REFUSED_RETRY_MS : this.backoffMs
    this.refused = false
    this.backoffMs = Math.min(this.backoffMs * 2, BACKOFF_MAX_MS)
    const delay = wait / 2 + Math.random() * (wait / 2)
    this.retryTimer = setTimeout(() => {
      this.retryTimer = undefined
      this.connect()
    }, delay)
  }

  /** Sends a frame on the live socket. Returns false when there is no live socket or the frame is over the cap. */
  private send(frame: NestHostFrame): boolean {
    const socket = this.socket
    if (socket === null || socket.readyState !== WebSocket.OPEN) return false
    const text = JSON.stringify(frame)
    if (Buffer.byteLength(text) > MAX_NEST_FRAME_BYTES) {
      this.opts.log(`not sending a ${frame._tag} frame over ${MAX_NEST_FRAME_BYTES} bytes`)
      return false
    }
    socket.send(text)
    return true
  }
}
