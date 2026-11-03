// Minimal Chrome DevTools Protocol client over Bun's WebSocket: enough to drive one page.

type Listener = (params: unknown) => void

interface CdpMessage {
  id?: number
  method?: string
  params?: unknown
  result?: unknown
  error?: { message: string; data?: string }
}

interface Evaluated {
  result: { value?: unknown }
  exceptionDetails?: { text: string; exception?: { description?: string } }
}

export class Cdp {
  private nextId = 1
  private readonly pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>()
  private readonly listeners = new Map<string, Set<Listener>>()

  private constructor(private readonly ws: WebSocket) {
    ws.onmessage = (ev) => {
      const msg = JSON.parse(String(ev.data)) as CdpMessage
      if (msg.id !== undefined) {
        const p = this.pending.get(msg.id)
        if (!p) return
        this.pending.delete(msg.id)
        if (msg.error) p.reject(new Error(`${msg.error.message}: ${msg.error.data ?? ""}`))
        else p.resolve(msg.result)
        return
      }
      if (msg.method === undefined) return
      for (const fn of this.listeners.get(msg.method) ?? []) fn(msg.params)
    }
    ws.onclose = () => {
      for (const p of this.pending.values()) p.reject(new Error("CDP connection closed"))
      this.pending.clear()
    }
  }

  /** Opens a new blank page on the Chrome listening on `port` and attaches to it. */
  static async newPage(port: number): Promise<Cdp> {
    const res = await fetch(`http://127.0.0.1:${port}/json/new?about:blank`, { method: "PUT" })
    const target = (await res.json()) as { webSocketDebuggerUrl: string }
    const ws = new WebSocket(target.webSocketDebuggerUrl)
    const opened = Promise.withResolvers<void>()
    ws.onopen = () => opened.resolve()
    ws.onerror = () => opened.reject(new Error("CDP websocket failed"))
    await opened.promise
    return new Cdp(ws)
  }

  send<T = unknown>(method: string, params: Record<string, unknown> = {}): Promise<T> {
    const id = this.nextId++
    const { promise, resolve, reject } = Promise.withResolvers<unknown>()
    this.pending.set(id, { resolve, reject })
    this.ws.send(JSON.stringify({ id, method, params }))
    return promise as Promise<T>
  }

  on(method: string, fn: Listener): void {
    let set = this.listeners.get(method)
    if (!set) this.listeners.set(method, (set = new Set()))
    set.add(fn)
  }

  /** Evaluates `expression` in the page, awaiting promises; throws on a page exception. */
  async evaluate<T = unknown>(expression: string): Promise<T> {
    const res = await this.send<Evaluated>("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true })
    if (res.exceptionDetails) {
      throw new Error(res.exceptionDetails.exception?.description ?? res.exceptionDetails.text)
    }
    return res.result.value as T
  }

  close(): void {
    this.ws.close()
  }
}
