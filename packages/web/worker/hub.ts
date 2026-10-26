import { DurableObject } from "cloudflare:workers"
import {
  RELAY_CONNECT_PATH,
  RELAY_PROTOCOL_VERSION,
  decodeBinary,
  decodeFrame,
  encodeBinary,
  encodeFrame,
  fromBase64,
  toBase64,
  type BoxStatus,
  type RelayCredentials,
  type RelayFrame,
} from "@cloudagents/protocol"
import { errorResponse, headersToRecord, isHopByHop } from "./http"
import type { Env } from "./env"

/**
 * Singleton Durable Object (`idFromName("main")`) holding all control-plane state and the
 * outbound relay to the agent box.
 *
 * - SQLite tables: users, sessions, connections, oauth_states.
 * - The box holds one hibernatable WebSocket (tag "box"); its metadata lives in the socket attachment.
 * - Browser HTTP requests are tunnelled as `http` frames and resolved by `http-res` (30s timeout → 504).
 * - Browser WebSockets are accepted with the standard API (they pin the object in memory) and
 *   piped to the box as `ws-open` / `ws-text` / binary / `ws-close`.
 *
 * Methods are RPC-callable from the Worker; `fetch` handles `/box/connect` and tunnelled `/api/*`.
 */

const BOX_TAG = "box"
const HTTP_TIMEOUT_MS = 30_000
/** Close code sent to browsers when the box goes away (custom range; 1001 is not settable). */
const BOX_GONE_CLOSE_CODE = 4001

/** Headers the box must never see from the browser. Hop-by-hop headers are dropped by `headersToRecord`. */
const DROP_FOR_BOX: Record<string, true> = {
  cookie: true,
  authorization: true,
  "sec-websocket-key": true,
  "sec-websocket-version": true,
  "sec-websocket-extensions": true,
  "sec-websocket-protocol": true,
  "sec-websocket-accept": true,
}

/** Status codes whose responses must not carry a body. */
const NULL_BODY_STATUS: Record<number, true> = { 101: true, 103: true, 204: true, 205: true, 304: true }

export type OAuthKind = "login" | "connect"

export type UserRecord = { login: string; name: string | null; avatarUrl: string }

export type OAuthStateRecord = { kind: OAuthKind; provider: string; returnTo: string }

type PendingHttp = { resolve: (res: Response) => void; timer: number }

type BoxAttachment = { connectedAt: string; boxVersion: string | null }

type HttpFrame = Extract<RelayFrame, { t: "http" }>

/** Valid close code for WebSocket.close(): 1000 or 3000–4999; anything else becomes 1000. */
const closeCode = (code: number | undefined): number =>
  code === 1000 || (code !== undefined && code >= 3000 && code <= 4999) ? code : 1000

const closeQuietly = (ws: WebSocket, code: number, reason: string): void => {
  try {
    ws.close(code, reason)
  } catch {
    // already closed
  }
}

export class Hub extends DurableObject<Env> {
  private readonly pending = new Map<number, PendingHttp>()
  private readonly streams = new Map<number, WebSocket>()
  private nextId = 1

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env)
    void ctx.blockConcurrencyWhile(async () => {
      const sql = ctx.storage.sql
      sql.exec(`CREATE TABLE IF NOT EXISTS users (
        login TEXT PRIMARY KEY,
        name TEXT,
        avatar_url TEXT NOT NULL
      )`)
      sql.exec(`CREATE TABLE IF NOT EXISTS sessions (
        id TEXT PRIMARY KEY,
        login TEXT NOT NULL,
        expires_at INTEGER NOT NULL
      )`)
      sql.exec(`CREATE TABLE IF NOT EXISTS connections (
        login TEXT NOT NULL,
        provider TEXT NOT NULL,
        secret TEXT NOT NULL,
        account TEXT,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY (login, provider)
      )`)
      sql.exec(`CREATE TABLE IF NOT EXISTS oauth_states (
        state TEXT PRIMARY KEY,
        kind TEXT NOT NULL,
        provider TEXT NOT NULL,
        return_to TEXT NOT NULL,
        expires_at INTEGER NOT NULL
      )`)
    })
  }

  // -------------------------------------------------------------------------
  // Users and sessions
  // -------------------------------------------------------------------------

  upsertUser(user: UserRecord): void {
    this.ctx.storage.sql.exec(
      `INSERT INTO users (login, name, avatar_url) VALUES (?, ?, ?)
       ON CONFLICT(login) DO UPDATE SET name = excluded.name, avatar_url = excluded.avatar_url`,
      user.login,
      user.name,
      user.avatarUrl,
    )
  }

  getUser(login: string): UserRecord | null {
    const row = this.ctx.storage.sql
      .exec<{ login: string; name: string | null; avatarUrl: string }>(
        "SELECT login, name, avatar_url AS avatarUrl FROM users WHERE login = ?",
        login,
      )
      .toArray()[0]
    return row ?? null
  }

  createSession(id: string, login: string, expiresAt: number): void {
    const sql = this.ctx.storage.sql
    sql.exec("DELETE FROM sessions WHERE expires_at <= ?", Date.now())
    sql.exec("INSERT INTO sessions (id, login, expires_at) VALUES (?, ?, ?)", id, login, expiresAt)
  }

  /** Login for a live session id, or null when unknown or expired. */
  sessionLogin(id: string): string | null {
    const sql = this.ctx.storage.sql
    sql.exec("DELETE FROM sessions WHERE expires_at <= ?", Date.now())
    const row = sql.exec<{ login: string }>("SELECT login FROM sessions WHERE id = ?", id).toArray()[0]
    return row?.login ?? null
  }

  deleteSession(id: string): void {
    this.ctx.storage.sql.exec("DELETE FROM sessions WHERE id = ?", id)
  }

  // -------------------------------------------------------------------------
  // Connections
  // -------------------------------------------------------------------------

  /** Connected providers for a user (secrets are not returned). */
  connections(login: string): { provider: string; account: string | null }[] {
    return this.ctx.storage.sql
      .exec<{ provider: string; account: string | null }>(
        "SELECT provider, account FROM connections WHERE login = ?",
        login,
      )
      .toArray()
  }

  putConnection(login: string, provider: string, secret: string, account: string | null): void {
    this.ctx.storage.sql.exec(
      `INSERT INTO connections (login, provider, secret, account, updated_at) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(login, provider) DO UPDATE SET
         secret = excluded.secret, account = excluded.account, updated_at = excluded.updated_at`,
      login,
      provider,
      secret,
      account,
      Date.now(),
    )
  }

  deleteConnection(login: string, provider: string): void {
    this.ctx.storage.sql.exec("DELETE FROM connections WHERE login = ? AND provider = ?", login, provider)
  }

  /** Secrets forwarded to the box in the `x-cloudagents-credentials` header. */
  credentials(login: string): RelayCredentials {
    const out: { user: string; github?: string; anthropic?: string; openai?: string } = { user: login }
    const rows = this.ctx.storage.sql
      .exec<{ provider: string; secret: string }>("SELECT provider, secret FROM connections WHERE login = ?", login)
      .toArray()
    for (const row of rows) {
      switch (row.provider) {
        case "github":
          out.github = row.secret
          break
        case "anthropic":
          out.anthropic = row.secret
          break
        case "openai":
          out.openai = row.secret
          break
      }
    }
    return out
  }

  // -------------------------------------------------------------------------
  // OAuth state (single use, 10 minutes)
  // -------------------------------------------------------------------------

  createOAuthState(state: string, kind: OAuthKind, provider: string, returnTo: string, expiresAt: number): void {
    const sql = this.ctx.storage.sql
    sql.exec("DELETE FROM oauth_states WHERE expires_at <= ?", Date.now())
    sql.exec(
      "INSERT INTO oauth_states (state, kind, provider, return_to, expires_at) VALUES (?, ?, ?, ?, ?)",
      state,
      kind,
      provider,
      returnTo,
      expiresAt,
    )
  }

  /** Deletes the state row and returns it if it existed and has not expired. */
  consumeOAuthState(state: string): OAuthStateRecord | null {
    const sql = this.ctx.storage.sql
    const row = sql
      .exec<{ kind: OAuthKind; provider: string; returnTo: string; expiresAt: number }>(
        "SELECT kind, provider, return_to AS returnTo, expires_at AS expiresAt FROM oauth_states WHERE state = ?",
        state,
      )
      .toArray()[0]
    sql.exec("DELETE FROM oauth_states WHERE state = ?", state)
    if (!row || row.expiresAt <= Date.now()) return null
    return { kind: row.kind, provider: row.provider, returnTo: row.returnTo }
  }

  // -------------------------------------------------------------------------
  // Box presence
  // -------------------------------------------------------------------------

  boxStatus(): BoxStatus {
    const ws = this.ctx.getWebSockets(BOX_TAG)[0]
    if (!ws) return { online: false, connectedAt: null, boxVersion: null }
    const att = this.attachment(ws)
    return { online: true, connectedAt: att.connectedAt, boxVersion: att.boxVersion }
  }

  // -------------------------------------------------------------------------
  // Worker-facing fetch: /box/connect (box upgrade) and /api/* (tunnelled to the box)
  // -------------------------------------------------------------------------

  override async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url)
    if (url.pathname === RELAY_CONNECT_PATH) return this.acceptBox(request)
    if (url.pathname.startsWith("/api/")) return this.relay(request, url)
    return errorResponse(404, "NotFound", `no route for ${url.pathname}`)
  }

  private acceptBox(request: Request): Response {
    if (request.headers.get("upgrade")?.toLowerCase() !== "websocket") {
      return errorResponse(426, "UpgradeRequired", "expected a WebSocket upgrade")
    }
    // Latest connection wins: fail anything in flight on the previous box and drop its socket.
    this.failAll()
    for (const old of this.ctx.getWebSockets(BOX_TAG)) closeQuietly(old, 4000, "replaced")

    const pair = new WebSocketPair()
    const client = pair[0]
    const server = pair[1]
    const attachment: BoxAttachment = { connectedAt: new Date().toISOString(), boxVersion: null }
    this.ctx.acceptWebSocket(server, [BOX_TAG])
    server.serializeAttachment(attachment)
    return new Response(null, { status: 101, webSocket: client })
  }

  private async relay(request: Request, url: URL): Promise<Response> {
    const box = this.ctx.getWebSockets(BOX_TAG)[0]
    if (!box) return errorResponse(503, "BoxOffline", "agent box is not connected")

    const path = url.pathname + url.search
    const headers = headersToRecord(request.headers, DROP_FOR_BOX)

    if (request.headers.get("upgrade")?.toLowerCase() === "websocket") {
      return this.openStream(box, path, headers)
    }

    const body =
      request.method === "GET" || request.method === "HEAD" ? undefined : new Uint8Array(await request.arrayBuffer())
    const frame: HttpFrame = {
      t: "http",
      id: this.allocId(),
      method: request.method,
      path,
      headers,
      ...(body && body.byteLength > 0 ? { body: toBase64(body) } : {}),
    }
    return this.request(box, frame)
  }

  private request(box: WebSocket, frame: HttpFrame): Promise<Response> {
    const { promise, resolve } = Promise.withResolvers<Response>()
    const timer = setTimeout(() => {
      this.pending.delete(frame.id)
      resolve(errorResponse(504, "GatewayTimeout", "agent box did not respond in time"))
    }, HTTP_TIMEOUT_MS)
    this.pending.set(frame.id, { resolve, timer })
    try {
      box.send(encodeFrame(frame))
    } catch {
      clearTimeout(timer)
      this.pending.delete(frame.id)
      resolve(errorResponse(502, "BadGateway", "agent box is unreachable"))
    }
    return promise
  }

  private openStream(box: WebSocket, path: string, headers: Record<string, string>): Response {
    const id = this.allocId()
    const pair = new WebSocketPair()
    const client = pair[0]
    const server = pair[1]
    server.accept()
    this.streams.set(id, server)

    server.addEventListener("message", (event) => {
      try {
        if (typeof event.data === "string") {
          box.send(encodeFrame({ t: "ws-text", id, data: event.data }))
        } else {
          box.send(encodeBinary(id, new Uint8Array(event.data)))
        }
      } catch {
        this.streams.delete(id)
        closeQuietly(server, 1000, "agent box unreachable")
      }
    })

    server.addEventListener("close", (event) => {
      if (this.streams.get(id) !== server) return
      this.streams.delete(id)
      try {
        box.send(encodeFrame({ t: "ws-close", id, code: closeCode(event.code), reason: (event.reason ?? "").slice(0, 40) }))
      } catch {
        // box already gone; failAll has or will close the rest
      }
    })

    try {
      box.send(encodeFrame({ t: "ws-open", id, path, headers }))
    } catch {
      this.streams.delete(id)
      closeQuietly(server, 1000, "agent box unreachable")
      return errorResponse(502, "BadGateway", "agent box is unreachable")
    }
    return new Response(null, { status: 101, webSocket: client })
  }

  // -------------------------------------------------------------------------
  // Box socket (hibernatable)
  // -------------------------------------------------------------------------

  override webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): void {
    if (typeof message === "string") {
      const frame = decodeFrame(message)
      if (frame) this.onFrame(ws, frame)
      return
    }
    const bin = decodeBinary(new Uint8Array(message))
    if (bin) this.streams.get(bin.id)?.send(bin.payload)
  }

  override webSocketClose(ws: WebSocket, code: number): void {
    this.boxLost(ws)
    closeQuietly(ws, closeCode(code), "")
  }

  override webSocketError(ws: WebSocket): void {
    this.boxLost(ws)
    closeQuietly(ws, 1000, "")
  }

  private onFrame(ws: WebSocket, frame: RelayFrame): void {
    switch (frame.t) {
      case "hello":
        if (frame.version !== RELAY_PROTOCOL_VERSION) {
          closeQuietly(ws, 4002, "unsupported relay protocol version")
          return
        }
        ws.serializeAttachment({ ...this.attachment(ws), boxVersion: frame.boxVersion })
        return
      case "ping":
        ws.send(encodeFrame({ t: "pong" }))
        return
      case "http-res": {
        const p = this.pending.get(frame.id)
        if (!p) return
        this.pending.delete(frame.id)
        clearTimeout(p.timer)
        p.resolve(this.toResponse(frame))
        return
      }
      case "ws-text":
        this.streams.get(frame.id)?.send(frame.data)
        return
      case "ws-close": {
        const s = this.streams.get(frame.id)
        this.streams.delete(frame.id)
        if (s) closeQuietly(s, closeCode(frame.code), (frame.reason ?? "").slice(0, 40))
        return
      }
      default:
        // pong, and frames only the control plane sends (http, ws-open)
        return
    }
  }

  private toResponse(frame: Extract<RelayFrame, { t: "http-res" }>): Response {
    const valid = frame.status >= 200 && frame.status <= 599
    const status = valid ? frame.status : 502
    const headers = new Headers()
    for (const [name, value] of Object.entries(frame.headers)) {
      if (!isHopByHop(name)) headers.set(name, value)
    }
    const body = frame.body && NULL_BODY_STATUS[status] !== true ? fromBase64(frame.body) : null
    return new Response(body, { status, headers })
  }

  private boxLost(ws: WebSocket): void {
    // A replaced box closes after its successor attached; only a true disconnect fails in-flight work.
    if (this.ctx.getWebSockets(BOX_TAG).some((s) => s !== ws)) return
    this.failAll()
  }

  private failAll(): void {
    for (const p of this.pending.values()) {
      clearTimeout(p.timer)
      p.resolve(errorResponse(502, "BadGateway", "agent box disconnected"))
    }
    this.pending.clear()
    for (const s of this.streams.values()) closeQuietly(s, BOX_GONE_CLOSE_CODE, "agent box disconnected")
    this.streams.clear()
  }

  private attachment(ws: WebSocket): BoxAttachment {
    const att = ws.deserializeAttachment() as BoxAttachment | null
    return att ?? { connectedAt: new Date(0).toISOString(), boxVersion: null }
  }

  private allocId(): number {
    const id = this.nextId
    this.nextId = id >= 0xffffffff ? 1 : id + 1
    return id
  }
}
