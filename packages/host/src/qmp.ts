import { createConnection, type Socket } from "node:net"

type Message = Record<string, unknown>

interface Waiter {
  resolve(message: Message): void
  reject(error: Error): void
}

/**
 * Minimal QMP client over a unix socket. Reads newline-delimited JSON, skips asynchronous `event`
 * messages, and enforces a timeout on every reply. One request is in flight at a time.
 */
export class QmpConnection {
  private buffer = ""
  private readonly queued: Message[] = []
  private waiter: Waiter | null = null
  private failure: Error | null = null

  private constructor(private readonly socket: Socket) {
    socket.setEncoding("utf8")
    socket.on("data", (chunk: string) => this.onData(chunk))
    socket.on("error", (error) => this.fail(error))
    socket.on("close", () => this.fail(new Error("QMP socket closed")))
  }

  /** Connects and consumes the greeting. Rejects on connect error, timeout, or a non-QMP greeting. */
  static async connect(path: string, timeoutMs: number): Promise<QmpConnection> {
    const { promise, resolve, reject } = Promise.withResolvers<Socket>()
    const socket = createConnection({ path })
    const timer = setTimeout(() => {
      socket.destroy()
      reject(new Error(`QMP connect to ${path} timed out`))
    }, timeoutMs)
    socket.once("connect", () => {
      clearTimeout(timer)
      resolve(socket)
    })
    socket.once("error", (error) => {
      clearTimeout(timer)
      reject(error)
    })
    const connection = new QmpConnection(await promise)
    try {
      const greeting = await connection.take(timeoutMs)
      if (!("QMP" in greeting)) throw new Error("peer did not send a QMP greeting")
    } catch (error) {
      connection.close()
      throw error
    }
    return connection
  }

  /** Sends one command and returns its `return` value. Throws on a QMP `error` reply. */
  async execute(command: string, timeoutMs: number, args?: Message): Promise<unknown> {
    const request = args === undefined ? { execute: command } : { execute: command, arguments: args }
    this.socket.write(`${JSON.stringify(request)}\n`)
    for (;;) {
      const message = await this.take(timeoutMs)
      if ("event" in message) continue
      if ("error" in message) throw new Error(`QMP ${command} failed: ${JSON.stringify(message.error)}`)
      return message.return
    }
  }

  close(): void {
    this.socket.destroy()
  }

  private take(timeoutMs: number): Promise<Message> {
    const next = this.queued.shift()
    if (next !== undefined) return Promise.resolve(next)
    if (this.failure !== null) return Promise.reject(this.failure)
    const { promise, resolve, reject } = Promise.withResolvers<Message>()
    const timer = setTimeout(() => {
      this.waiter = null
      reject(new Error("QMP reply timed out"))
    }, timeoutMs)
    this.waiter = {
      resolve: (message) => {
        clearTimeout(timer)
        resolve(message)
      },
      reject: (error) => {
        clearTimeout(timer)
        reject(error)
      },
    }
    return promise
  }

  private deliver(message: Message): void {
    if (this.waiter === null) {
      this.queued.push(message)
      return
    }
    const waiter = this.waiter
    this.waiter = null
    waiter.resolve(message)
  }

  private onData(chunk: string): void {
    this.buffer += chunk
    for (let newline = this.buffer.indexOf("\n"); newline >= 0; newline = this.buffer.indexOf("\n")) {
      const line = this.buffer.slice(0, newline).trim()
      this.buffer = this.buffer.slice(newline + 1)
      if (line === "") continue
      try {
        this.deliver(JSON.parse(line) as Message)
      } catch (error) {
        this.fail(error instanceof Error ? error : new Error(String(error)))
        return
      }
    }
  }

  private fail(error: Error): void {
    if (this.failure !== null) return
    this.failure = error
    if (this.waiter !== null) {
      const waiter = this.waiter
      this.waiter = null
      waiter.reject(error)
    }
  }
}

/** True when a QMP server answers its greeting on `path` within `timeoutMs`. */
export const probeQmp = async (path: string, timeoutMs: number): Promise<boolean> => {
  let connection: QmpConnection | null = null
  try {
    connection = await QmpConnection.connect(path, timeoutMs)
    return true
  } catch {
    return false
  } finally {
    connection?.close()
  }
}

/** Opens a session, negotiates capabilities, runs one command, and closes the session. */
export const qmpCommand = async (
  path: string,
  command: string,
  timeoutMs: number,
  args?: Message,
): Promise<unknown> => {
  const connection = await QmpConnection.connect(path, timeoutMs)
  try {
    await connection.execute("qmp_capabilities", timeoutMs)
    return await connection.execute(command, timeoutMs, args)
  } finally {
    connection.close()
  }
}
