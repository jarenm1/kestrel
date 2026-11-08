import { DurableObject } from "cloudflare:workers"
import { Either, Option, Schema } from "effect"
import {
  CREDENTIALS_HEADER,
  ControlPaths,
  Paths,
  RELAY_CONNECT_PATH,
  RELAY_PROTOCOL_VERSION,
  AutomationTrigger,
  BOX_TOKEN_QUERY,
  BOX_TOKEN_TTL_SECONDS,
  MAX_USER_BOXES,
  PAIRING_TTL_SECONDS,
  signBoxToken,
  decodeBinary,
  decodeFrame,
  encodeBinary,
  encodeFrame,
  fromBase64,
  toBase64,
  decodeNestHostFrame,
  MAX_NEST_FRAME_BYTES,
  NEST_HOST_ID_HEADER,
  NEST_HOST_PROTOCOL,
  type ApprovePairingBody,
  type Automation,
  type AutomationRun,
  type BoxStatus,
  type BoxList,
  type BoxSelf,
  type BoxToken,
  type FileToken,
  type CreateAutomationBody,
  type CreateBoxBody,
  type BoxActivityReport,
  type CreateTaskBody,
  type CreateFleetBoxBody,
  type CreatedBox,
  type CreatedFleetBox,
  type FleetActivity,
  type FleetBox,
  type FleetBoxList,
  type ToolFailureList,
  type ToolFailureReport,
  type PairingPoll,
  type PairingStart,
  type PairingStartBody,
  type PendingPairing,
  type RelayCredentials,
  type RelayFrame,
  type UpdateAutomationBody,
  type UpdateBoxBody,
  type UpdateFleetBoxBody,
  type UserBox,
  type CreateMeterHostBody,
  type CreatedMeterHost,
  type MeterBatch,
  type MeterHostList,
  type MeterIngestResult,
  type MeterReport,
  type MeterReportBody,
  type CreateNestBoxBody,
  type NestControlFrame,
  type NestEnrollBody,
  type NestEnrollResult,
  type NestHostList,
  type NestLimits,
} from "@cloudagents/protocol"
import { errorResponse, headersToRecord, isHopByHop, safeEqual } from "./http"
import { fetchPullRequest, matchGithubTrigger, type PullRequestEvent, type PullRequestInfo } from "./github"
import { localDate, nextFireTime } from "./cron"
import { claimHookRow, type HookRow } from "./hooks"
import { ensureAutomationsTable } from "./automations-table"
import { ensurePrWatchTables } from "./pr-watches-table"
import { composePrompt } from "./prompt"
import { SESSION_HEADER, FILE_TOKEN_HEADER, isAllowedLogin, type Env } from "./env"
import {
  createDesktopToken,
  deleteSessionDesktopTokens,
  desktopStreamTask,
  desktopTokenSession,
  ensureDesktopTokensTable,
} from "./desktop-tokens"
import {
  createFileToken,
  deleteSessionFileTokens,
  ensureFileTokensTable,
  fileTokenSession,
  isBoxFilePath,
} from "./file-tokens"
import {
  deleteFleetBox,
  ensureFleetTable,
  fleetBox,
  insertFleetBox,
  listFleetBoxes,
  managedBoxAccess,
  managedBoxFor,
  managedBoxSecretValid,
  rotateFleetBoxSecret,
  updateFleetBox,
  type ManagedBoxRow,
} from "./fleet-table"
import {
  ensureMeterTables,
  insertMeterHost,
  listMeterHosts,
  meterHostSecret,
  METER_RETENTION_DAYS,
  meterRecordsInWindow,
  meterRetentionCutoff,
  purgeExpiredMeterRecords,
  storeMeterRecords,
} from "./meter-table"
import { reconcileMeter } from "./meter-reconcile"
import { commonToolFailures, ensureToolFailuresTable, recordToolFailures } from "./tool-failures-table"
import { deleteBoxActivity, ensureBoxActivityTable, fleetActivity, recordBoxActivity } from "./activity-table"
import { NestFleet, type NestOutcome } from "./nest-fleet"
import { ensureNestTables } from "./nest-table"
import { NEST_STANDARD_LIMITS, newSecret, nestLimitsError, publicUrlFor } from "./nest-control"

/** A failed box call: the HTTP status and error body the Worker answers with. */
export type BoxFailure = { ok: false; status: number; tag: string; message: string }
export type BoxOutcome<T> = { ok: true; value: T } | BoxFailure

const UNAUTHENTICATED: BoxFailure = { ok: false, status: 401, tag: "Unauthorized", message: "sign in required" }
const NO_SUCH_BOX: BoxFailure = { ok: false, status: 404, tag: "NotFound", message: "no such box" }
const NO_SUCH_PAIRING: BoxFailure = { ok: false, status: 404, tag: "NotFound", message: "no such pairing or it expired" }
const INVALID_BOX_CREDENTIALS: BoxFailure = { ok: false, status: 401, tag: "Unauthorized", message: "invalid box credentials" }
const NOT_ASSIGNED: BoxFailure = { ok: false, status: 403, tag: "Forbidden", message: "user is not assigned to this box" }
const INVALID_METER_HOST: BoxFailure = {
  ok: false,
  status: 401,
  tag: "Unauthorized",
  message: "invalid meter host credentials",
}
const NEST_DISABLED: BoxFailure = { ok: false, status: 404, tag: "NotFound", message: "Nest is not enabled" }
const NO_NEST_CAPACITY: BoxFailure = { ok: false, status: 503, tag: "NoCapacity", message: "no Nest host has room for a new box" }

/** Pairing codes: 8 characters from 32 symbols with no 0, O, 1 or I. 32 divides 256, so each byte is unbiased. */
const PAIRING_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"
const newPairingCode = (): string =>
  Array.from(crypto.getRandomValues(new Uint8Array(8)), (byte) => PAIRING_ALPHABET.charAt(byte & 31)).join("")

/**
 * Singleton Durable Object (`idFromName("main")`) holding all control-plane state and the
 * outbound relay to the agent box.
 *
 * - SQLite tables: users, sessions, connections, user_boxes, oauth_states, automations, automation_runs, github_hooks,
 *   webhook_deliveries, box_pairings.
 * - The box holds one hibernatable WebSocket (tag "box"); its metadata lives in the socket attachment.
 * - Browser HTTP requests are tunnelled as `http` frames and resolved by `http-res` (30s timeout → 504).
 * - Browser WebSockets are accepted with the standard API (they pin the object in memory) and
 *   piped to the box as `ws-open` / `ws-text` / binary / `ws-close`.
 *
 * Methods are RPC-callable from the Worker; `fetch` handles `/box/connect` and `/api/*` signed in by session id.
 */

const BOX_TAG = "box"
const NEST_HOST_TAG = "nest-host"

/** Longest an automation call waits for a Nest box to report `running`, and how often it checks. */
const NEST_WAKE_TIMEOUT_MS = 60_000
const NEST_WAKE_POLL_MS = 1_000
/** A Nest host socket's attachment: the host, whether its `hello` was accepted, and whether a newer socket replaced it. */
type NestAttachment = { hostId: string; hello: boolean; retired?: boolean }
const nestAttachment = (ws: WebSocket): NestAttachment | null => ws.deserializeAttachment() as NestAttachment | null
const HTTP_TIMEOUT_MS = 30_000
/** Lifetime of a token the Hub signs for one call to a managed box. */
const MANAGED_CALL_TTL_SECONDS = 5 * 60
/** Close code sent to browsers when the box goes away (custom range; 1001 is not settable). */
const BOX_GONE_CLOSE_CODE = 4001

/** Recent runs kept per automation. */
const RUNS_KEPT = 50
/** How long webhook delivery ids are remembered for deduplication. */
const DELIVERY_RETENTION_MS = 24 * 60 * 60 * 1000

/** Response of `POST /api/repos/:id/tasks`. */
const CreatedTask = Schema.Struct({ id: Schema.String })
/** Error body of box responses (`{ _tag, message }`). */
const BoxErrorBody = Schema.Struct({ message: Schema.String })

/** Result of a box request; `body` is the raw response text. */
export type BoxResult = { ok: boolean; status: number; body: string }

/** Outcome of starting a task for a run. `error` is null when the task started. */
type RunOutcome = { taskId: string | null; error: string | null }

/** A `user_boxes` row as SQL returns it; `nest` comes from elsewhere. */
type UserBoxRow = Omit<UserBox, "nest">

type AutomationRow = {
  id: string
  login: string
  name: string
  repo: string | null
  prompt: string
  model: Automation["model"]
  enabled: number
  triggerJson: string
  nextRunAt: number | null
  createdAt: string
  updatedAt: string
}

const AUTOMATION_COLUMNS =
  "id, login, name, repo, prompt, model, enabled, trigger_json AS triggerJson, next_run_at AS nextRunAt, created_at AS createdAt, updated_at AS updatedAt"

type PairingRow = {
  id: string
  code: string
  name: string | null
  url: string | null
  expiresAt: number
  boxId: string | null
}

const PAIRING_COLUMNS = "id, code, name, url, expires_at AS expiresAt, box_id AS boxId"

/** Pairings in flight at once, across all users; starting another answers 429. The start route needs no sign-in. */
const MAX_LIVE_PAIRINGS = 500

const decodeTrigger = (json: string): AutomationTrigger => Schema.decodeUnknownSync(AutomationTrigger)(JSON.parse(json))

/** Next fire (epoch ms) after `now` for an enabled schedule; null for everything else. */
const nextRunMs = (trigger: AutomationTrigger, enabled: boolean, now: number): number | null =>
  enabled && trigger._tag === "schedule" ? nextFireTime(trigger.cron, trigger.timezone, now) : null

const automationView = (row: AutomationRow): Automation => ({
  id: row.id,
  name: row.name,
  repo: row.repo,
  prompt: row.prompt,
  model: row.model,
  enabled: row.enabled === 1,
  trigger: decodeTrigger(row.triggerJson),
  createdAt: row.createdAt,
  updatedAt: row.updatedAt,
  nextRunAt: row.nextRunAt === null ? null : new Date(row.nextRunAt).toISOString(),
})

const decodeJson = <A, I>(schema: Schema.Schema<A, I>, text: string): A | null => {
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch {
    return null
  }
  return Option.getOrNull(Schema.decodeUnknownOption(schema)(value))
}

const boxError = (res: BoxResult): string =>
  decodeJson(BoxErrorBody, res.body)?.message ?? `agent box responded ${res.status}`

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

/** `dev`: the session came from `/auth/dev-login`. */
export type SessionRecord = { login: string; dev: boolean }

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

  private readonly nest: NestFleet

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env)
    this.nest = new NestFleet(
      ctx.storage.sql,
      {
        send: (hostId, frame) => this.sendNestFrame(hostId, frame),
        connected: (hostId) => this.nestSocket(hostId) !== null,
      },
      env.KESTREL_NEST_DOMAIN ?? "",
    )
    void ctx.blockConcurrencyWhile(async () => {
      const sql = ctx.storage.sql
      sql.exec(`CREATE TABLE IF NOT EXISTS users (
        login TEXT PRIMARY KEY,
        name TEXT,
        avatar_url TEXT NOT NULL
      )`)
      // Users tables created before the `active_box_id` column get it here; existing users use Kestrel's box.
      const userColumns = sql.exec<{ name: string }>("PRAGMA table_info(users)").toArray()
      if (!userColumns.some((c) => c.name === "active_box_id")) {
        sql.exec("ALTER TABLE users ADD COLUMN active_box_id TEXT")
      }
      ensureFleetTable(sql)
      ensureMeterTables(sql)
      ensureNestTables(sql)
      ensureToolFailuresTable(sql)
      ensureBoxActivityTable(sql)
      // An interrupted rebuild must leave either the old tables or the new ones, never a renamed legacy table or a
      // half-copied one; the transaction makes the rename/copy/drop sequence atomic.
      ctx.storage.transactionSync(() => ensurePrWatchTables(sql))
      sql.exec(`CREATE TABLE IF NOT EXISTS sessions (
        id TEXT PRIMARY KEY,
        login TEXT NOT NULL,
        expires_at INTEGER NOT NULL,
        dev INTEGER NOT NULL DEFAULT 0
      )`)
      // Sessions tables created before the `dev` column get it here; existing rows are not dev sessions.
      const sessionColumns = sql.exec<{ name: string }>("PRAGMA table_info(sessions)").toArray()
      if (!sessionColumns.some((c) => c.name === "dev")) {
        sql.exec("ALTER TABLE sessions ADD COLUMN dev INTEGER NOT NULL DEFAULT 0")
      }
      sql.exec(`CREATE TABLE IF NOT EXISTS connections (
        login TEXT NOT NULL,
        provider TEXT NOT NULL,
        secret TEXT NOT NULL,
        account TEXT,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY (login, provider)
      )`)
      sql.exec(`CREATE TABLE IF NOT EXISTS user_boxes (
        id TEXT PRIMARY KEY,
        login TEXT NOT NULL,
        name TEXT NOT NULL,
        url TEXT NOT NULL,
        secret TEXT NOT NULL,
        created_at TEXT NOT NULL
      )`)
      sql.exec(`CREATE TABLE IF NOT EXISTS box_pairings (
        id TEXT PRIMARY KEY,
        code TEXT UNIQUE NOT NULL,
        name TEXT,
        url TEXT,
        expires_at INTEGER NOT NULL,
        box_id TEXT
      )`)
      sql.exec(`CREATE TABLE IF NOT EXISTS oauth_states (
        state TEXT PRIMARY KEY,
        kind TEXT NOT NULL,
        provider TEXT NOT NULL,
        return_to TEXT NOT NULL,
        expires_at INTEGER NOT NULL
      )`)
      ctx.storage.transactionSync(() => ensureAutomationsTable(sql))
      sql.exec(`CREATE TABLE IF NOT EXISTS automation_runs (
        id TEXT PRIMARY KEY,
        automation_id TEXT NOT NULL,
        fired_at TEXT NOT NULL,
        reason TEXT NOT NULL,
        status TEXT NOT NULL,
        task_id TEXT,
        error TEXT
      )`)
      sql.exec(`CREATE TABLE IF NOT EXISTS github_hooks (
        repo TEXT PRIMARY KEY,
        hook_id INTEGER NOT NULL,
        secret TEXT NOT NULL
      )`)
      sql.exec(`CREATE TABLE IF NOT EXISTS webhook_deliveries (
        delivery_id TEXT PRIMARY KEY,
        received_at INTEGER NOT NULL
      )`)
      sql.exec(`CREATE TABLE IF NOT EXISTS preview_sessions (
        token TEXT PRIMARY KEY,
        login TEXT NOT NULL,
        task_id TEXT NOT NULL,
        expires_at INTEGER NOT NULL
      )`)
      ensureFileTokensTable(sql)
      ensureDesktopTokensTable(sql)
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

  /** `dev` marks a session from `/auth/dev-login`. */
  createSession(id: string, login: string, expiresAt: number, dev: boolean): void {
    const sql = this.ctx.storage.sql
    sql.exec("DELETE FROM sessions WHERE expires_at <= ?", Date.now())
    sql.exec("INSERT INTO sessions (id, login, expires_at, dev) VALUES (?, ?, ?, ?)", id, login, expiresAt, dev ? 1 : 0)
  }

  /** The live session with this id, or null when unknown or expired. */
  session(id: string): SessionRecord | null {
    const sql = this.ctx.storage.sql
    sql.exec("DELETE FROM sessions WHERE expires_at <= ?", Date.now())
    const row = sql.exec<{ login: string; dev: number }>("SELECT login, dev FROM sessions WHERE id = ?", id).toArray()[0]
    return row && isAllowedLogin(this.env, row.login, row.dev === 1) ? { login: row.login, dev: row.dev === 1 } : null
  }

  /** Ends a session (sign-out); the file and desktop tokens it minted end with it. */
  deleteSession(id: string): void {
    this.ctx.storage.sql.exec("DELETE FROM sessions WHERE id = ?", id)
    deleteSessionFileTokens(this.ctx.storage.sql, id)
    deleteSessionDesktopTokens(this.ctx.storage.sql, id)
  }

  /** Short-lived preview-only capability; the browser never receives the app session cookie. */
  createPreviewSession(login: string, taskId: string): string {
    const now = Date.now()
    const token = crypto.randomUUID()
    const sql = this.ctx.storage.sql
    sql.exec("DELETE FROM preview_sessions WHERE expires_at <= ?", now)
    sql.exec(
      "INSERT INTO preview_sessions (token, login, task_id, expires_at) VALUES (?, ?, ?, ?)",
      token,
      login,
      taskId,
      now + 24 * 60 * 60 * 1000,
    )
    return token
  }

  /** The owner and task for a live preview token; expired tokens are not valid. */
  previewSession(token: string): { login: string; taskId: string } | null {
    const sql = this.ctx.storage.sql
    const now = Date.now()
    sql.exec("DELETE FROM preview_sessions WHERE expires_at <= ?", now)
    const row = sql
      .exec<{ login: string; taskId: string }>(
        "SELECT login, task_id AS taskId FROM preview_sessions WHERE token = ? AND expires_at > ?",
        token,
        now,
      )
      .toArray()[0]
    return row && isAllowedLogin(this.env, row.login, !!this.env.DEV_SESSION_LOGIN) ? row : null
  }

  /**
   * A short-lived token for box files a WebView or DOM `<img>` loads; it stands in for the session cookie and lasts no
   * longer than the session `sessionId`. Null when that session is not live.
   */
  createFileToken(sessionId: string): FileToken | null {
    if (this.session(sessionId) === null) return null
    return createFileToken(this.ctx.storage.sql, sessionId)
  }

  /** A short-lived token for one task's desktop stream, for a WebView (`desktop-tokens.ts`). Null when `sessionId` is not live. */
  createDesktopToken(sessionId: string, taskId: string): FileToken | null {
    if (this.session(sessionId) === null) return null
    return createDesktopToken(this.ctx.storage.sql, sessionId, taskId)
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

  /** The stored secret of one connection, or null when it is not connected. */
  connectionSecret(login: string, provider: string): string | null {
    return (
      this.ctx.storage.sql
        .exec<{ secret: string }>("SELECT secret FROM connections WHERE login = ? AND provider = ?", login, provider)
        .toArray()[0]?.secret ?? null
    )
  }

  /** The user's connection secrets, by provider. The flat Anthropic/OpenAI slots keep older boxes working. */
  connectionSecrets(login: string): {
    github?: string
    providers: Record<string, string>
    anthropic?: string
    openai?: string
  } {
    const out: { github?: string; providers: Record<string, string>; anthropic?: string; openai?: string } = {
      providers: {},
    }
    const rows = this.ctx.storage.sql
      .exec<{ provider: string; secret: string }>("SELECT provider, secret FROM connections WHERE login = ?", login)
      .toArray()
    for (const row of rows) {
      if (row.provider === "github") {
        out.github = row.secret
        continue
      }
      out.providers[row.provider] = row.secret
      if (row.provider === "anthropic") out.anthropic = row.secret
      if (row.provider === "openai") out.openai = row.secret
    }
    return out
  }

  /** Secrets forwarded to the box in the `x-cloudagents-credentials` header. */
  credentials(login: string): RelayCredentials {
    return { user: login, ...this.connectionSecrets(login) }
  }

  /**
   * Version of the user's connections, `count:latest updated_at`. A box token carries it as `cv`, and `boxSelf`
   * reports it, so a box refetches its credentials once they change.
   */
  private credentialsVersion(login: string): string {
    const row = this.ctx.storage.sql
      .exec<{ count: number; latest: number | null }>(
        "SELECT COUNT(*) AS count, MAX(updated_at) AS latest FROM connections WHERE login = ?",
        login,
      )
      .toArray()[0]
    return `${row?.count ?? 0}:${row?.latest ?? ""}`
  }

  // -------------------------------------------------------------------------
  // User boxes (bring your own box). Browser calls pass the session id and the Hub resolves it, so each call is one
  // request. Failures come back as `BoxFailure` for the Worker to answer.
  // -------------------------------------------------------------------------

  listBoxes(sessionId: string): BoxOutcome<BoxList> {
    const session = this.session(sessionId)
    return session ? { ok: true, value: this.boxList(session.login) } : UNAUTHENTICATED
  }

  createBox(sessionId: string, body: CreateBoxBody): BoxOutcome<CreatedBox> {
    const session = this.session(sessionId)
    if (!session) return UNAUTHENTICATED
    return this.insertBox(session.login, body)
  }

  /** The one insertion path for a new box: `createBox` and pairing approval share it (same limit, new secret). */
  private insertBox(login: string, body: CreateBoxBody, id = crypto.randomUUID()): BoxOutcome<CreatedBox> {
    const sql = this.ctx.storage.sql
    const count =
      sql.exec<{ count: number }>("SELECT COUNT(*) AS count FROM user_boxes WHERE login = ?", login).toArray()[0]
        ?.count ?? 0
    if (count >= MAX_USER_BOXES) {
      return { ok: false, status: 409, tag: "Conflict", message: `at most ${MAX_USER_BOXES} boxes per user` }
    }
    const box: UserBox = { id, name: body.name, url: body.url, createdAt: new Date().toISOString() }
    const secret = newSecret()
    sql.exec(
      "INSERT INTO user_boxes (id, login, name, url, secret, created_at) VALUES (?, ?, ?, ?, ?, ?)",
      box.id,
      login,
      box.name,
      box.url,
      secret,
      box.createdAt,
    )
    return { ok: true, value: { box, secret } }
  }

  updateBox(sessionId: string, id: string, changes: UpdateBoxBody): BoxOutcome<UserBox> {
    const session = this.session(sessionId)
    if (!session) return UNAUTHENTICATED
    const owned = this.ownedBox(session.login, id)
    if (!owned) return NO_SUCH_BOX
    if (changes.url !== undefined && changes.url !== owned.box.url && this.nest.isNestBox(id)) {
      return { ok: false, status: 400, tag: "BadRequest", message: "a Nest box's URL is set by its host" }
    }
    const box: UserBox = { ...owned.box, name: changes.name ?? owned.box.name, url: changes.url ?? owned.box.url }
    this.ctx.storage.sql.exec(
      "UPDATE user_boxes SET name = ?, url = ? WHERE id = ? AND login = ?",
      box.name,
      box.url,
      id,
      session.login,
    )
    return { ok: true, value: box }
  }

  async deleteBox(sessionId: string, id: string): Promise<BoxOutcome<null>> {
    const session = this.session(sessionId)
    if (!session) return UNAUTHENTICATED
    if (!this.ownedBox(session.login, id)) return NO_SUCH_BOX
    if (this.nest.isNestBox(id)) {
      const outcome = this.nest.destroy(session.login, id)
      if (outcome.ok) await this.rearm()
      return outcome
    }
    const sql = this.ctx.storage.sql
    sql.exec("UPDATE users SET active_box_id = NULL WHERE login = ? AND active_box_id = ?", session.login, id)
    sql.exec("DELETE FROM user_boxes WHERE id = ? AND login = ?", id, session.login)
    return { ok: true, value: null }
  }

  rotateBoxSecret(sessionId: string, id: string): BoxOutcome<CreatedBox> {
    const session = this.session(sessionId)
    if (!session) return UNAUTHENTICATED
    const owned = this.ownedBox(session.login, id)
    if (!owned) return NO_SUCH_BOX
    const secret = newSecret()
    this.ctx.storage.sql.exec("UPDATE user_boxes SET secret = ? WHERE id = ? AND login = ?", secret, id, session.login)
    return { ok: true, value: { box: owned.box, secret } }
  }

  /**
   * A token the owner gives their box: signed with the box's secret, audience is the box id. A user's managed box is
   * minted the same way, with the managed box's secret.
   */
  async mintBoxToken(sessionId: string, id: string): Promise<BoxOutcome<BoxToken>> {
    const session = this.session(sessionId)
    if (!session) return UNAUTHENTICATED
    const owned = this.ownedBox(session.login, id)
    if (owned) return this.signBoxFor(session, id, owned.secret, owned.box.url)
    const managed = managedBoxFor(this.ctx.storage.sql, session.login)
    if (managed === null || managed.id !== id) return NO_SUCH_BOX
    return this.signBoxFor(session, id, managed.secret, managed.url)
  }

  /** A box token for the session's user, signed with `secret` and audienced to `id`; `url` is where the box lives. */
  private async signBoxFor(
    session: SessionRecord,
    id: string,
    secret: string,
    url: string,
  ): Promise<BoxOutcome<BoxToken>> {
    const iat = Math.floor(Date.now() / 1000)
    const exp = iat + BOX_TOKEN_TTL_SECONDS
    const token = await signBoxToken(secret, {
      sub: session.login,
      aud: id,
      iat,
      exp,
      cv: this.credentialsVersion(session.login),
      ...(session.dev ? { dev: true } : {}),
    })
    return { ok: true, value: { token, url, expiresAt: new Date(exp * 1000).toISOString() } }
  }

  setActiveBox(sessionId: string, boxId: string | null): BoxOutcome<BoxList> {
    const session = this.session(sessionId)
    if (!session) return UNAUTHENTICATED
    if (boxId !== null && !this.ownedBox(session.login, boxId)) return NO_SUCH_BOX
    this.ctx.storage.sql.exec("UPDATE users SET active_box_id = ? WHERE login = ?", boxId, session.login)
    return { ok: true, value: this.boxList(session.login) }
  }

  // -------------------------------------------------------------------------
  // Nest boxes: a user's VM on a Nest host. The fleet (`nest-fleet.ts`) owns placement and commands; these map its
  // outcomes onto the box list the apps show.
  // -------------------------------------------------------------------------

  async createNestBox(sessionId: string, body: CreateNestBoxBody): Promise<BoxOutcome<UserBox>> {
    const session = this.session(sessionId)
    if (!session) return UNAUTHENTICATED
    const domain = this.env.KESTREL_NEST_DOMAIN
    if (!domain) return NEST_DISABLED
    const limits = body.limits ?? NEST_STANDARD_LIMITS
    const shape = nestLimitsError(limits)
    if (shape !== null) return { ok: false, status: 400, tag: "BadRequest", message: shape }
    const enroll = await this.nest.mintEnrollToken()
    const target = this.nest.placement(null)
    if (target === null) return NO_NEST_CAPACITY
    const id = crypto.randomUUID()
    const created = this.insertBox(session.login, { name: body.name, url: publicUrlFor(id, target.slug, domain) }, id)
    if (!created.ok) return created
    this.nest.createBox(id, session.login, target, limits, enroll)
    await this.rearm()
    return this.userBoxView(session.login, id)
  }

  async resumeNestBox(sessionId: string, id: string): Promise<BoxOutcome<UserBox>> {
    return this.nestAction(sessionId, id, (login) => this.nest.resume(login, id))
  }

  async suspendNestBox(sessionId: string, id: string): Promise<BoxOutcome<UserBox>> {
    return this.nestAction(sessionId, id, (login) => this.nest.suspend(login, id))
  }

  async parkNestBox(sessionId: string, id: string): Promise<BoxOutcome<UserBox>> {
    return this.nestAction(sessionId, id, (login) => this.nest.park(login, id))
  }

  async attachNestGpu(sessionId: string, id: string): Promise<BoxOutcome<UserBox>> {
    return this.nestAction(sessionId, id, (login) => this.nest.gpu(login, id, true))
  }

  async detachNestGpu(sessionId: string, id: string): Promise<BoxOutcome<UserBox>> {
    return this.nestAction(sessionId, id, (login) => this.nest.gpu(login, id, false))
  }

  async setNestLimits(sessionId: string, id: string, limits: NestLimits): Promise<BoxOutcome<UserBox>> {
    const shape = nestLimitsError(limits)
    if (shape !== null) return { ok: false, status: 400, tag: "BadRequest", message: shape }
    return this.nestAction(sessionId, id, (login) => this.nest.setLimits(login, id, limits))
  }

  nestHostList(): NestHostList {
    return { hosts: this.nest.hostList() }
  }

  nestEnroll(body: NestEnrollBody): Promise<NestEnrollResult | null> {
    return this.nest.enroll(body)
  }

  private async nestAction(
    sessionId: string,
    id: string,
    act: (login: string) => NestOutcome<null> | Promise<NestOutcome<null>>,
  ): Promise<BoxOutcome<UserBox>> {
    const session = this.session(sessionId)
    if (!session) return UNAUTHENTICATED
    const outcome = await act(session.login)
    if (!outcome.ok) return outcome
    await this.rearm()
    return this.userBoxView(session.login, id)
  }

  /** A box the owner holds, with its Nest status when it is a Nest box. */
  private userBoxView(login: string, id: string): BoxOutcome<UserBox> {
    const owned = this.ownedBox(login, id)
    if (!owned) return NO_SUCH_BOX
    const nest = this.nest.statusesOf(login).get(id)
    return { ok: true, value: nest === undefined ? owned.box : { ...owned.box, nest } }
  }

  /** The box's owner and their connection secrets for `ControlPaths.boxSelf`; null unless `secret` is the box's. */
  async boxSelf(boxId: string, secret: string): Promise<BoxSelf | null> {
    const row = this.ctx.storage.sql
      .exec<{ login: string; secret: string }>("SELECT login, secret FROM user_boxes WHERE id = ?", boxId)
      .toArray()[0]
    if (!row || !(await safeEqual(secret, row.secret))) return null
    this.nest.markEnrolled(boxId)
    return {
      owner: row.login,
      credentialsVersion: this.credentialsVersion(row.login),
      ...this.connectionSecrets(row.login),
    }
  }

  /** Whether `secret` is the registered user box's own, without reading its owner's credentials. */
  async boxVerify(boxId: string, secret: string): Promise<boolean> {
    const row = this.ctx.storage.sql
      .exec<{ secret: string }>("SELECT secret FROM user_boxes WHERE id = ?", boxId)
      .toArray()[0]
    return row !== undefined && (await safeEqual(secret, row.secret))
  }

  private boxList(login: string): BoxList {
    const sql = this.ctx.storage.sql
    const boxes = sql
      .exec<UserBoxRow>(
        "SELECT id, name, url, created_at AS createdAt FROM user_boxes WHERE login = ? ORDER BY created_at, rowid",
        login,
      )
      .toArray()
    const user = sql
      .exec<{ activeBoxId: string | null }>("SELECT active_box_id AS activeBoxId FROM users WHERE login = ?", login)
      .toArray()[0]
    const nests = this.nest.statusesOf(login)
    const managed = managedBoxFor(sql, login)
    return {
      boxes: boxes.map((box) => {
        const nest = nests.get(box.id)
        return nest === undefined ? box : { ...box, nest }
      }),
      activeBoxId: user?.activeBoxId ?? null,
      managedBox: managed === null ? null : { id: managed.id, url: managed.url },
    }
  }

  /** The box if `login` owns it, with its secret; null otherwise. */
  private ownedBox(login: string, id: string): { box: UserBox; secret: string } | null {
    const row = this.ctx.storage.sql
      .exec<UserBoxRow & { secret: string }>(
        "SELECT id, name, url, created_at AS createdAt, secret FROM user_boxes WHERE id = ? AND login = ?",
        id,
        login,
      )
      .toArray()[0]
    if (!row) return null
    const { secret, ...box } = row
    return { box, secret }
  }

  // -------------------------------------------------------------------------
  // Managed boxes: Kestrel's fleet. Each user is assigned to one; operators manage the fleet (the Worker checks).
  // -------------------------------------------------------------------------

  /** Whether a managed box's call for `login` is authorized: the box's own secret, and the user assigned to that box. */
  async managedBoxAuthorize(boxId: string, secret: string, login: string): Promise<BoxOutcome<null>> {
    const access = await managedBoxAccess(this.ctx.storage.sql, boxId, secret, login)
    if (access === "unauthenticated") return INVALID_BOX_CREDENTIALS
    if (access === "unassigned" || !isAllowedLogin(this.env, login, !!this.env.DEV_SESSION_LOGIN)) return NOT_ASSIGNED
    return { ok: true, value: null }
  }

  /** `ControlPaths.boxCredentials`: the user's credentials for a managed box, in the same shape as `boxSelf`. */
  async managedBoxCredentials(boxId: string, secret: string, login: string): Promise<BoxOutcome<BoxSelf>> {
    const access = await this.managedBoxAuthorize(boxId, secret, login)
    if (!access.ok) return access
    return {
      ok: true,
      value: { owner: login, credentialsVersion: this.credentialsVersion(login), ...this.connectionSecrets(login) },
    }
  }

  fleetBoxes(): FleetBoxList {
    return { boxes: listFleetBoxes(this.ctx.storage.sql) }
  }

  /** A new box in `pending` state, with its secret returned once. */
  createFleetBox(body: CreateFleetBoxBody): CreatedFleetBox {
    const sql = this.ctx.storage.sql
    const id = crypto.randomUUID()
    const secret = newSecret()
    insertFleetBox(sql, { id, name: body.name, url: body.url, secret, createdAt: new Date().toISOString() })
    const box = fleetBox(sql, id)
    if (box === null) throw new Error("managed box was not stored")
    return { box, secret }
  }

  /** Applies the given fields to a box; null when it does not exist. */
  changeFleetBox(id: string, changes: UpdateFleetBoxBody): FleetBox | null {
    return updateFleetBox(this.ctx.storage.sql, id, changes)
  }

  /** Removes a box, its activity snapshot, and its users' assignments; false when it does not exist. */
  removeFleetBox(id: string): boolean {
    const removed = deleteFleetBox(this.ctx.storage.sql, id)
    if (removed) deleteBoxActivity(this.ctx.storage.sql, id)
    return removed
  }

  /** Replaces a box's secret and returns the new one; null when the box does not exist. */
  rotateFleetSecret(id: string): CreatedFleetBox | null {
    const sql = this.ctx.storage.sql
    const secret = newSecret()
    if (!rotateFleetBoxSecret(sql, id, secret)) return null
    const box = fleetBox(sql, id)
    return box === null ? null : { box, secret }
  }

  /** Whether `secret` is the managed box's own, for calls that act for no user. */
  async managedBoxVerify(boxId: string, secret: string): Promise<boolean> {
    return managedBoxSecretValid(this.ctx.storage.sql, boxId, secret)
  }

  // -------------------------------------------------------------------------
  // Tool failure counts from Kestrel's boxes; no user, thread or box is kept with them.
  // -------------------------------------------------------------------------

  recordToolFailures(report: ToolFailureReport): void {
    recordToolFailures(this.ctx.storage.sql, report.failures, new Date())
  }

  commonToolFailures(days: number): ToolFailureList {
    return { days, failures: commonToolFailures(this.ctx.storage.sql, days, new Date()) }
  }

  // -------------------------------------------------------------------------
  // Active users per managed box: a full snapshot from each box, replaced on every report.
  // -------------------------------------------------------------------------

  recordBoxActivity(boxId: string, report: BoxActivityReport): void {
    recordBoxActivity(this.ctx.storage.sql, boxId, report, new Date())
  }

  fleetActivity(): FleetActivity {
    return fleetActivity(this.ctx.storage.sql, new Date())
  }

  // -------------------------------------------------------------------------
  // Nest usage metering: hosts post records; reconciliation runs when a report is read.
  // -------------------------------------------------------------------------

  meterHosts(): MeterHostList {
    return { hosts: listMeterHosts(this.ctx.storage.sql) }
  }

  /** A new Nest host, with its secret returned once. */
  createMeterHost(body: CreateMeterHostBody): CreatedMeterHost {
    const host = { id: crypto.randomUUID(), name: body.name, createdAt: new Date().toISOString() }
    const secret = newSecret()
    insertMeterHost(this.ctx.storage.sql, { ...host, secret })
    return { host, secret }
  }

  /** Stores a host's batch after checking its secret; a refused batch stores nothing. */
  async ingestMeterRecords(hostId: string, secret: string, batch: MeterBatch): Promise<BoxOutcome<MeterIngestResult>> {
    const sql = this.ctx.storage.sql
    const stored = meterHostSecret(sql, hostId)
    if (stored === undefined || !(await safeEqual(secret, stored))) return INVALID_METER_HOST
    const received = new Date().toISOString()
    return this.ctx.storage.transactionSync(() => {
      const outcome = storeMeterRecords(sql, hostId, batch.records, received)
      purgeExpiredMeterRecords(sql, received)
      return outcome
    })
  }

  /**
   * The reconciled, non-billable report for `[from, through)`. A window starting before the retention cutoff is
   * refused: records it would need may already be purged.
   */
  meterReport(body: MeterReportBody, now: string): BoxOutcome<MeterReport> {
    if (body.from < meterRetentionCutoff(now)) {
      const message = `from is older than the ${METER_RETENTION_DAYS}-day retention window`
      return { ok: false, status: 400, tag: "BadRequest", message }
    }
    const records = meterRecordsInWindow(this.ctx.storage.sql, body.from, body.through)
    const { from, through, rates, currency } = body
    return { ok: true, value: reconcileMeter(records, { from, through, rates, currency }) }
  }

  // -------------------------------------------------------------------------
  // Box pairing: the `kestrel-box` CLI starts a pairing and polls it; a signed-in user approves its code in the app.
  // Each method is synchronous, so it runs as one transaction.
  // -------------------------------------------------------------------------

  /**
   * Starts a pairing with a fresh code and id; `appOrigin` is where the approval page is served. Null when too many
   * pairings are live (the route is anonymous).
   */
  startPairing(body: PairingStartBody, appOrigin: string): PairingStart | null {
    this.purgePairings()
    const sql = this.ctx.storage.sql
    const live = sql.exec<{ n: number }>("SELECT COUNT(*) AS n FROM box_pairings").toArray()[0]?.n ?? 0
    if (live >= MAX_LIVE_PAIRINGS) return null
    let code = newPairingCode()
    while (sql.exec("SELECT 1 FROM box_pairings WHERE code = ?", code).toArray().length > 0) code = newPairingCode()
    const id = newSecret()
    const expiresAt = Date.now() + PAIRING_TTL_SECONDS * 1000
    sql.exec(
      "INSERT INTO box_pairings (id, code, name, url, expires_at) VALUES (?, ?, ?, ?, ?)",
      id,
      code,
      body.name ?? null,
      body.url ?? null,
      expiresAt,
    )
    const shown = `${code.slice(0, 4)}-${code.slice(4)}`
    return {
      pairingId: id,
      code: shown,
      approveUrl: `${appOrigin}${ControlPaths.pairPage}?code=${shown}`,
      expiresAt: new Date(expiresAt).toISOString(),
    }
  }

  /**
   * Pending, or the approved box with its current secret, on every poll until the pairing expires: a CLI that lost the
   * answer polls again. Null when unknown or expired, or when the box was deleted since.
   */
  pollPairing(pairingId: string): PairingPoll | null {
    const row = this.livePairing("id", pairingId)
    if (!row) return null
    if (row.boxId === null) return { status: "pending", expiresAt: new Date(row.expiresAt).toISOString() }
    const found = this.ctx.storage.sql
      .exec<UserBoxRow & { secret: string }>(
        "SELECT id, name, url, created_at AS createdAt, secret FROM user_boxes WHERE id = ?",
        row.boxId,
      )
      .toArray()[0]
    if (!found) return null
    const { secret, ...box } = found
    return { status: "approved", box, secret }
  }

  pendingPairing(sessionId: string, code: string): BoxOutcome<PendingPairing> {
    if (!this.session(sessionId)) return UNAUTHENTICATED
    const row = this.livePairing("code", code)
    if (!row) return NO_SUCH_PAIRING
    return {
      ok: true,
      value: {
        code: `${row.code.slice(0, 4)}-${row.code.slice(4)}`,
        name: row.name,
        url: row.url,
        expiresAt: new Date(row.expiresAt).toISOString(),
      },
    }
  }

  /**
   * Creates the box the pairing asks for (same limit as `createBox`) for the CLI's next polls, which get a fresh TTL to
   * collect it, so a code approved just before it expires still completes.
   */
  approvePairing(sessionId: string, code: string, body: ApprovePairingBody): BoxOutcome<BoxList> {
    const session = this.session(sessionId)
    if (!session) return UNAUTHENTICATED
    const row = this.livePairing("code", code)
    if (!row) return NO_SUCH_PAIRING
    if (row.boxId !== null) return { ok: false, status: 409, tag: "Conflict", message: "pairing code already approved" }
    const created = this.insertBox(session.login, body)
    if (!created.ok) return created
    const sql = this.ctx.storage.sql
    sql.exec(
      "UPDATE box_pairings SET box_id = ?, expires_at = ? WHERE id = ?",
      created.value.box.id,
      Date.now() + PAIRING_TTL_SECONDS * 1000,
      row.id,
    )
    if (body.activate) {
      sql.exec("UPDATE users SET active_box_id = ? WHERE login = ?", created.value.box.id, session.login)
    }
    return { ok: true, value: this.boxList(session.login) }
  }

  private purgePairings(): void {
    this.ctx.storage.sql.exec("DELETE FROM box_pairings WHERE expires_at <= ?", Date.now())
  }

  /** The pairing whose `column` equals `value`, if it has not expired (expired rows are purged first). */
  private livePairing(column: "id" | "code", value: string): PairingRow | null {
    this.purgePairings()
    return (
      this.ctx.storage.sql
        .exec<PairingRow>(`SELECT ${PAIRING_COLUMNS} FROM box_pairings WHERE ${column} = ?`, value)
        .toArray()[0] ?? null
    )
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
  // Box calls: one request to the box with `login`'s credentials
  // -------------------------------------------------------------------------

  boxCall(login: string, method: "GET" | "POST", path: string, payload?: unknown): Promise<BoxResult> {
    if (!isAllowedLogin(this.env, login, !!this.env.DEV_SESSION_LOGIN)) {
      return Promise.resolve({ ok: false, status: 403, body: JSON.stringify({ _tag: "Forbidden", message: "account is not allowed" }) })
    }
    const nestId = this.activeNestBox(login)
    if (nestId !== null) return this.nestBoxCall(login, nestId, method, path, payload)
    const managed = managedBoxFor(this.ctx.storage.sql, login)
    if (managed !== null) return this.directBoxCall(managed, login, method, path, payload)
    const box = this.ctx.getWebSockets(BOX_TAG)[0]
    if (!box) {
      return Promise.resolve({ ok: false, status: 503, body: JSON.stringify({ _tag: "BoxOffline", message: "agent box is not connected" }) })
    }
    // Background work has no browser session; identify the explicitly configured dev login here as well.
    const creds = this.sessionCredentials({ login, dev: this.env.DEV_SESSION_LOGIN === login })
    const headers: Record<string, string> = { [CREDENTIALS_HEADER]: JSON.stringify(creds) }
    const body = payload === undefined ? undefined : new TextEncoder().encode(JSON.stringify(payload))
    if (body !== undefined) headers["content-type"] = "application/json"
    const frame: HttpFrame = {
      t: "http",
      id: this.allocId(),
      method,
      path,
      headers,
      ...(body ? { body: toBase64(body) } : {}),
    }
    return this.request(box, frame).then(async (res) => ({ ok: res.ok, status: res.status, body: await res.text() }))
  }

  /** The user's active box when it is a Nest box they own; automation work for them goes there. */
  private activeNestBox(login: string): string | null {
    const id =
      this.ctx.storage.sql.exec<{ id: string | null }>("SELECT active_box_id AS id FROM users WHERE login = ?", login).toArray()[0]?.id ?? null
    return id !== null && this.nest.isNestBox(id) && this.ownedBox(login, id) !== null ? id : null
  }

  /**
   * A call to a Nest box: the box is resumed and the call waits for it to report `running`. The URL and secret are read
   * after the wake, since a wake can place the box on another host.
   */
  private async nestBoxCall(login: string, id: string, method: "GET" | "POST", path: string, payload?: unknown): Promise<BoxResult> {
    if (!(await this.wakeNestBox(login, id))) {
      return { ok: false, status: 503, body: JSON.stringify({ _tag: "BoxOffline", message: "Nest box did not wake" }) }
    }
    const owned = this.ownedBox(login, id)
    if (!owned) return { ok: false, status: 404, body: JSON.stringify({ message: "no such box" }) }
    return this.directBoxCall({ id, url: owned.box.url, secret: owned.secret }, login, method, path, payload)
  }

  /** Resumes the box and polls until it reports `running`; false when that does not happen within NEST_WAKE_TIMEOUT_MS. */
  private async wakeNestBox(login: string, id: string): Promise<boolean> {
    if (!(await this.nest.resume(login, id)).ok) return false
    await this.rearm()
    const deadline = Date.now() + NEST_WAKE_TIMEOUT_MS
    while (!this.nest.isRunning(login, id)) {
      if (Date.now() >= deadline) return false
      await new Promise((resolve) => setTimeout(resolve, NEST_WAKE_POLL_MS))
    }
    return true
  }

  /**
   * One request straight to a managed box or a Nest box, with a short token for `login`. The box fetches the user's
   * credentials itself (`ControlPaths.boxCredentials`), so the Hub sends none.
   */
  private async directBoxCall(
    box: ManagedBoxRow,
    login: string,
    method: "GET" | "POST",
    path: string,
    payload?: unknown,
  ): Promise<BoxResult> {
    const iat = Math.floor(Date.now() / 1000)
    const token = await signBoxToken(box.secret, {
      sub: login,
      aud: box.id,
      iat,
      exp: iat + MANAGED_CALL_TTL_SECONDS,
      cv: this.credentialsVersion(login),
      ...(this.env.DEV_SESSION_LOGIN === login ? { dev: true } : {}),
    })
    const body = payload === undefined ? undefined : JSON.stringify(payload)
    try {
      const res = await fetch(new URL(path, box.url), {
        method,
        headers: {
          authorization: `Bearer ${token}`,
          ...(body === undefined ? {} : { "content-type": "application/json" }),
        },
        body,
        signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
      })
      return { ok: res.ok, status: res.status, body: await res.text() }
    } catch (err) {
      if (err instanceof DOMException && err.name === "TimeoutError") {
        return { ok: false, status: 504, body: JSON.stringify({ _tag: "BoxOffline", message: "agent box did not respond in time" }) }
      }
      return { ok: false, status: 502, body: JSON.stringify({ _tag: "BoxOffline", message: "agent box is unreachable" }) }
    }
  }

  // -------------------------------------------------------------------------
  // Automations: stored per user; schedules fire from the alarm, GitHub triggers from webhook deliveries
  // -------------------------------------------------------------------------

  automations(login: string): Automation[] {
    return this.ctx.storage.sql
      .exec<AutomationRow>(`SELECT ${AUTOMATION_COLUMNS} FROM automations WHERE login = ? ORDER BY created_at`, login)
      .toArray()
      .map(automationView)
  }

  automation(login: string, id: string): Automation | null {
    const row = this.automationRow(login, id)
    return row === null ? null : automationView(row)
  }

  async createAutomation(login: string, input: Omit<CreateAutomationBody, "repo"> & { repo: string | null }): Promise<Automation> {
    const now = Date.now()
    const enabled = input.enabled ?? true
    const row: AutomationRow = {
      id: crypto.randomUUID(),
      login,
      name: input.name,
      repo: input.repo,
      prompt: input.prompt,
      model: input.model ?? null,
      enabled: enabled ? 1 : 0,
      triggerJson: JSON.stringify(input.trigger),
      nextRunAt: nextRunMs(input.trigger, enabled, now),
      createdAt: new Date(now).toISOString(),
      updatedAt: new Date(now).toISOString(),
    }
    this.ctx.storage.sql.exec(
      `INSERT INTO automations (id, login, name, repo, prompt, model, enabled, trigger_json, next_run_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      row.id,
      row.login,
      row.name,
      row.repo,
      row.prompt,
      row.model,
      row.enabled,
      row.triggerJson,
      row.nextRunAt,
      row.createdAt,
      row.updatedAt,
    )
    await this.rearm()
    return automationView(row)
  }

  async updateAutomation(login: string, id: string, changes: UpdateAutomationBody): Promise<Automation | null> {
    const current = this.automationRow(login, id)
    if (current === null) return null
    const now = Date.now()
    const trigger = changes.trigger ?? decodeTrigger(current.triggerJson)
    const enabled = changes.enabled ?? current.enabled === 1
    const next: AutomationRow = {
      ...current,
      name: changes.name ?? current.name,
      prompt: changes.prompt ?? current.prompt,
      model: changes.model === undefined ? current.model : changes.model,
      enabled: enabled ? 1 : 0,
      triggerJson: JSON.stringify(trigger),
      nextRunAt: nextRunMs(trigger, enabled, now),
      updatedAt: new Date(now).toISOString(),
    }
    this.ctx.storage.sql.exec(
      "UPDATE automations SET name = ?, prompt = ?, model = ?, enabled = ?, trigger_json = ?, next_run_at = ?, updated_at = ? WHERE id = ? AND login = ?",
      next.name,
      next.prompt,
      next.model,
      next.enabled,
      next.triggerJson,
      next.nextRunAt,
      next.updatedAt,
      id,
      login,
    )
    await this.rearm()
    return automationView(next)
  }

  async deleteAutomation(login: string, id: string): Promise<boolean> {
    if (this.automationRow(login, id) === null) return false
    const sql = this.ctx.storage.sql
    sql.exec("DELETE FROM automation_runs WHERE automation_id = ?", id)
    sql.exec("DELETE FROM automations WHERE id = ? AND login = ?", id, login)
    await this.rearm()
    return true
  }

  /** Recent runs, newest first; null when the automation is not `login`'s. */
  automationRuns(login: string, id: string): AutomationRun[] | null {
    if (this.automationRow(login, id) === null) return null
    return this.ctx.storage.sql
      .exec<AutomationRun>(
        `SELECT id, automation_id AS automationId, fired_at AS firedAt, reason, status, task_id AS taskId, error
         FROM automation_runs WHERE automation_id = ? ORDER BY fired_at DESC, rowid DESC LIMIT ?`,
        id,
        RUNS_KEPT,
      )
      .toArray()
  }

  /** Manual "run now" (or any caller-supplied reason); null when the automation is not `login`'s. */
  async fireAutomation(
    login: string,
    id: string,
    reason: string,
    pr: PullRequestInfo | null,
  ): Promise<AutomationRun | null> {
    const row = this.automationRow(login, id)
    return row === null ? null : this.fire(row, reason, pr)
  }

  /**
   * Records one pull request webhook delivery and starts a task for every enabled GitHub automation on the
   * repository whose trigger matches. Runs happen after the response (`waitUntil`), so GitHub gets a fast 202.
   */
  githubDelivery(deliveryId: string, event: PullRequestEvent): { duplicate: boolean; matched: number } {
    const sql = this.ctx.storage.sql
    const now = Date.now()
    if (sql.exec("SELECT 1 FROM webhook_deliveries WHERE delivery_id = ?", deliveryId).toArray().length > 0) {
      return { duplicate: true, matched: 0 }
    }
    sql.exec("INSERT INTO webhook_deliveries (delivery_id, received_at) VALUES (?, ?)", deliveryId, now)
    sql.exec("DELETE FROM webhook_deliveries WHERE received_at < ?", now - DELIVERY_RETENTION_MS)
    const rows = sql
      .exec<AutomationRow>(`SELECT ${AUTOMATION_COLUMNS} FROM automations WHERE enabled = 1 AND repo COLLATE NOCASE = ?`, event.repo)
      .toArray()
    let matched = 0
    for (const row of rows) {
      const trigger = decodeTrigger(row.triggerJson)
      if (trigger._tag !== "github") continue
      const reason = matchGithubTrigger(trigger, event)
      if (reason === null) continue
      matched++
      this.ctx.waitUntil(this.fire(row, reason, event.pr))
    }
    return { duplicate: false, matched }
  }

  /** Watch one pull request of a thread. Watching the same one again is a no-op; others stay watched. */
  watchPullRequest(login: string, taskId: string, repo: string, number: number): void {
    this.ctx.storage.sql.exec(
      "INSERT INTO pr_watches (login, task_id, repo, pr_number) VALUES (?, ?, ?, ?) ON CONFLICT(login, task_id, repo, pr_number) DO UPDATE SET repo = excluded.repo",
      login, taskId, repo, number,
    )
  }

  /** Stops watching one pull request, or every one of the thread when no repository and number are named. Returns the repositories involved. */
  unwatchPullRequests(login: string, taskId: string, repo?: string, number?: number): string[] {
    const sql = this.ctx.storage.sql
    const where = repo === undefined || number === undefined
      ? "login = ? AND task_id = ?"
      : "login = ? AND task_id = ? AND repo = ? COLLATE NOCASE AND pr_number = ?"
    const args = repo === undefined || number === undefined ? [login, taskId] : [login, taskId, repo, number]
    const repos = sql.exec<{ repo: string }>(`SELECT DISTINCT repo FROM pr_watches WHERE ${where}`, ...args).toArray().map((row) => row.repo)
    sql.exec(`DELETE FROM pr_activity_queue WHERE ${where}`, ...args)
    sql.exec(`DELETE FROM pr_watches WHERE ${where}`, ...args)
    return repos
  }

  closePullRequestWatches(repo: string, number: number): Array<{ readonly login: string; readonly taskId: string }> {
    const watches = this.ctx.storage.sql
      .exec<{ login: string; taskId: string }>("SELECT DISTINCT login, task_id AS taskId FROM pr_watches WHERE repo = ? COLLATE NOCASE AND pr_number = ?", repo, number)
      .toArray()
    this.ctx.storage.sql.exec("DELETE FROM pr_activity_queue WHERE repo = ? COLLATE NOCASE AND pr_number = ?", repo, number)
    this.ctx.storage.sql.exec("DELETE FROM pr_watches WHERE repo = ? COLLATE NOCASE AND pr_number = ?", repo, number)
    return watches
  }

  async githubActivity(deliveryId: string, activity: { repo: string; numbers: readonly number[]; kind: string; headSha?: string }): Promise<{ duplicate: boolean; queued: number }> {
    const sql = this.ctx.storage.sql
    if (sql.exec("SELECT 1 FROM webhook_deliveries WHERE delivery_id = ?", deliveryId).toArray().length > 0) return { duplicate: true, queued: 0 }
    const rows = sql.exec<{ login: string; taskId: string; number: number }>(
      "SELECT login, task_id AS taskId, pr_number AS number FROM pr_watches WHERE repo = ? COLLATE NOCASE", activity.repo,
    ).toArray()
    const matching: typeof rows = []
    for (const row of rows) {
      if (activity.numbers.includes(row.number)) { matching.push(row); continue }
      if (activity.kind !== "check" || activity.headSha === undefined) continue
      const token = this.credentials(row.login).github
      if (token === undefined) continue
      const pr = await fetchPullRequest(token, activity.repo, row.number)
      if (pr?.headSha === activity.headSha) matching.push(row)
    }
    const now = Date.now()
    const inserted = this.ctx.storage.transactionSync(() => {
      if (sql.exec("SELECT 1 FROM webhook_deliveries WHERE delivery_id = ?", deliveryId).toArray().length > 0) return false
      sql.exec("INSERT INTO webhook_deliveries (delivery_id, received_at) VALUES (?, ?)", deliveryId, now)
      sql.exec("DELETE FROM webhook_deliveries WHERE received_at < ?", now - DELIVERY_RETENTION_MS)
      for (const row of matching) {
        const stillWatching = sql.exec("SELECT 1 FROM pr_watches WHERE login = ? AND task_id = ? AND repo = ? COLLATE NOCASE AND pr_number = ?", row.login, row.taskId, activity.repo, row.number).toArray().length > 0
        if (!stillWatching) continue
        sql.exec(
        `INSERT INTO pr_activity_queue (login, task_id, repo, pr_number, kind, delivery_id, due_at) VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(login, task_id, repo, pr_number, kind) DO UPDATE SET delivery_id = excluded.delivery_id, due_at = excluded.due_at`,
        row.login, row.taskId, activity.repo, row.number, activity.kind, deliveryId, now + 3000,
        )
      }
      return true
    })
    if (!inserted) return { duplicate: true, queued: 0 }
    await this.rearm()
    return { duplicate: false, queued: matching.length }
  }

  /** The webhook for a repository (key: lowercase "owner/name"), or null when none was created. */
  githubHook(repo: string): { hookId: number; secret: string } | null {
    return (
      this.ctx.storage.sql
        .exec<{ hookId: number; secret: string }>("SELECT hook_id AS hookId, secret FROM github_hooks WHERE repo = ?", repo)
        .toArray()[0] ?? null
    )
  }

  /** Stores a new hook unless the row changed since `expectedHookId` was read (see `claimHookRow`). */
  claimGithubHook(repo: string, expectedHookId: number | null, hookId: number, secret: string): HookRow {
    return claimHookRow(this.ctx.storage.sql, repo, expectedHookId, hookId, secret)
  }

  deleteGithubHook(repo: string): void {
    this.ctx.storage.sql.exec("DELETE FROM github_hooks WHERE repo = ?", repo)
  }

  /** True when an enabled GitHub automation still needs the repository's webhook. */
  githubHookInUse(repo: string): boolean {
    if (this.ctx.storage.sql.exec("SELECT 1 FROM pr_watches WHERE repo = ? COLLATE NOCASE LIMIT 1", repo).toArray().length > 0) return true
    return this.ctx.storage.sql
      .exec<AutomationRow>(`SELECT ${AUTOMATION_COLUMNS} FROM automations WHERE enabled = 1 AND repo COLLATE NOCASE = ?`, repo)
      .toArray()
      .some((row) => decodeTrigger(row.triggerJson)._tag === "github")
  }

  override async alarm(): Promise<void> {
    const now = Date.now()
    await this.nest.expire(now)
    const due = this.ctx.storage.sql
      .exec<AutomationRow>(`SELECT ${AUTOMATION_COLUMNS} FROM automations WHERE enabled = 1 AND next_run_at <= ?`, now)
      .toArray()
    for (const row of due) {
      this.ctx.storage.sql.exec(
        "UPDATE automations SET next_run_at = ? WHERE id = ?",
        nextRunMs(decodeTrigger(row.triggerJson), true, now),
        row.id,
      )
      await this.fire(row, "schedule", null)
    }
    const pending = this.ctx.storage.sql.exec<{ login: string; taskId: string; repo: string; number: number; kind: string; deliveryId: string }>(
      "SELECT login, task_id AS taskId, repo, pr_number AS number, kind, delivery_id AS deliveryId FROM pr_activity_queue WHERE due_at <= ?", now,
    ).toArray()
    for (const row of pending) {
      const result = await this.boxCall(row.login, "POST", `/api/tasks/${encodeURIComponent(row.taskId)}/github-activity`, row)
      // A newer event can replace the row during the box call. Never delete or postpone that event.
      const key = "login = ? AND task_id = ? AND repo = ? COLLATE NOCASE AND pr_number = ? AND kind = ?"
      const keyArgs = [row.login, row.taskId, row.repo, row.number, row.kind]
      if (result.ok) this.ctx.storage.sql.exec(`DELETE FROM pr_activity_queue WHERE ${key} AND delivery_id = ?`, ...keyArgs, row.deliveryId)
      else if (result.status === 404 || result.status === 409) {
        this.ctx.storage.sql.exec("DELETE FROM pr_watches WHERE login = ? AND task_id = ? AND repo = ? COLLATE NOCASE AND pr_number = ?", row.login, row.taskId, row.repo, row.number)
        this.ctx.storage.sql.exec(`DELETE FROM pr_activity_queue WHERE ${key} AND delivery_id = ?`, ...keyArgs, row.deliveryId)
      }
      else this.ctx.storage.sql.exec(`UPDATE pr_activity_queue SET due_at = ? WHERE ${key} AND delivery_id = ?`, Date.now() + 60000, ...keyArgs, row.deliveryId)
    }
    await this.rearm()
  }

  private automationRow(login: string, id: string): AutomationRow | null {
    return (
      this.ctx.storage.sql
        .exec<AutomationRow>(`SELECT ${AUTOMATION_COLUMNS} FROM automations WHERE id = ? AND login = ?`, id, login)
        .toArray()[0] ?? null
    )
  }

  /** Points the alarm at the earliest pending schedule, activity, or Nest deadline; clears it when none is pending. */
  private async rearm(): Promise<void> {
    const row = this.ctx.storage.sql
      .exec<{ at: number | null }>("SELECT MIN(next_run_at) AS at FROM automations WHERE enabled = 1")
      .toArray()[0]
    const activityAt = this.ctx.storage.sql.exec<{ at: number | null }>("SELECT MIN(due_at) AS at FROM pr_activity_queue").toArray()[0]?.at ?? null
    const scheduleAt = row?.at ?? null
    const deadlines = [scheduleAt, activityAt, this.nest.nextDeadline()].filter((at): at is number => at !== null)
    if (deadlines.length === 0) await this.ctx.storage.deleteAlarm()
    else await this.ctx.storage.setAlarm(Math.min(...deadlines))
  }

  private async fire(row: AutomationRow, reason: string, pr: PullRequestInfo | null): Promise<AutomationRun> {
    const now = Date.now()
    const trigger = decodeTrigger(row.triggerJson)
    const timeZone = trigger._tag === "schedule" ? trigger.timezone : "UTC"
    const title = pr === null ? `${row.name} · ${localDate(now, timeZone)}` : `${row.name} · PR #${pr.number}`
    const prompt = composePrompt({ name: row.name, prompt: row.prompt, reason, repo: row.repo, pr })
    // A PR run checks the repository out at the PR head; the base branch stays the diff base. It stays detached: a push
    // to the PR's branch would fire the automation again.
    const checkout =
      row.repo === null
        ? {}
        : { checkout: { repo: row.repo, ...(pr === null ? {} : { baseBranch: pr.baseRef, pullRequest: pr.number, detached: true }) } }
    const outcome = await this.startTask(row.login, { title, ...checkout }, prompt, row.model)
    return this.recordRun(row.id, reason, now, outcome)
  }

  /** Creates the task (with its repository checked out, if any) and sends the prompt to start its run. */
  private async startTask(login: string, body: CreateTaskBody, prompt: string, model: Automation["model"]): Promise<RunOutcome> {
    const created = await this.boxCall(login, "POST", Paths.tasks, body)
    if (!created.ok) return { taskId: null, error: boxError(created) }
    const task = decodeJson(CreatedTask, created.body)
    if (task === null) return { taskId: null, error: "agent box returned an unexpected task" }
    const sent = await this.boxCall(login, "POST", Paths.taskMessages(task.id), {
      text: prompt,
      ...(model === null ? {} : { model }),
    })
    return sent.ok ? { taskId: task.id, error: null } : { taskId: task.id, error: boxError(sent) }
  }

  private recordRun(automationId: string, reason: string, firedAt: number, outcome: RunOutcome): AutomationRun {
    const run: AutomationRun = {
      id: crypto.randomUUID(),
      automationId,
      firedAt: new Date(firedAt).toISOString(),
      reason,
      status: outcome.error === null ? "started" : "failed",
      taskId: outcome.taskId,
      error: outcome.error,
    }
    const sql = this.ctx.storage.sql
    sql.exec(
      "INSERT INTO automation_runs (id, automation_id, fired_at, reason, status, task_id, error) VALUES (?, ?, ?, ?, ?, ?, ?)",
      run.id,
      run.automationId,
      run.firedAt,
      run.reason,
      run.status,
      run.taskId,
      run.error,
    )
    sql.exec(
      `DELETE FROM automation_runs WHERE automation_id = ? AND id NOT IN (
         SELECT id FROM automation_runs WHERE automation_id = ? ORDER BY fired_at DESC, rowid DESC LIMIT ?)`,
      automationId,
      automationId,
      RUNS_KEPT,
    )
    return run
  }

  // -------------------------------------------------------------------------
  // Worker-facing fetch: /box/connect (box upgrade) and /api/* (tunnelled to the box)
  // -------------------------------------------------------------------------

  override async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url)
    if (url.pathname === RELAY_CONNECT_PATH) return this.acceptBox(request)
    if (url.pathname === ControlPaths.nestHostConnect) return this.acceptNestHost(request)
    if (url.pathname.startsWith("/_preview/") || this.previewReferer(request) !== null) {
      return this.previewRelay(request, url)
    }
    if (url.pathname.startsWith("/api/")) return this.signedInApi(request, url)
    return errorResponse(404, "NotFound", `no route for ${url.pathname}`)
  }

  /**
   * A browser API call the Worker forwarded with the caller's session id (`SESSION_HEADER`): resolving the session,
   * attaching its credentials and relaying all happen in this one Durable Object request, instead of one RPC each.
   * `GET /api/box` is answered here, since it needs no box round trip.
   */
  private signedInApi(request: Request, url: URL): Promise<Response> | Response {
    const sessionId = request.headers.get(SESSION_HEADER)
    if (sessionId === null) {
      const fileToken = request.headers.get(FILE_TOKEN_HEADER)
      return fileToken === null
        ? errorResponse(401, "Unauthorized", "sign in required")
        : this.fileApi(request, url, fileToken)
    }
    const session = this.session(sessionId)
    if (!session) return errorResponse(401, "Unauthorized", "sign in required")
    if (url.pathname === ControlPaths.box && request.method === "GET") return Response.json(this.boxStatus())
    const headers = new Headers(request.headers)
    headers.delete(SESSION_HEADER)
    headers.set(CREDENTIALS_HEADER, JSON.stringify(this.sessionCredentials(session)))
    return this.relay(new Request(request, { headers }), url)
  }

  /** What the box is told about a signed-in caller: the user's credentials, and whether it is a dev-login session. */
  private sessionCredentials(session: SessionRecord): RelayCredentials {
    const creds = this.credentials(session.login)
    return session.dev ? { ...creds, dev: true } : creds
  }

  /**
   * A box file loaded with a `FileToken` (`ControlPaths.fileToken`) instead of the session cookie. GET only, and only
   * the three box file paths: the token can do nothing else. It relays as the session that minted it (user and dev
   * flag), and fails once that session has ended. The token and its `?access_token=` query are dropped first. A desktop
   * stream takes a desktop token (`desktop-tokens.ts`) for that task the same way; neither kind works in the other's place.
   */
  private fileApi(request: Request, url: URL, token: string): Promise<Response> | Response {
    if (request.method !== "GET") return errorResponse(401, "Unauthorized", "invalid file token")
    const desktopTask = desktopStreamTask(url.pathname)
    const sql = this.ctx.storage.sql
    const sessionId =
      desktopTask !== null
        ? desktopTokenSession(sql, token, desktopTask)
        : isBoxFilePath(url.pathname)
          ? fileTokenSession(sql, token)
          : null
    const session = sessionId === null ? null : this.session(sessionId)
    if (session === null) return errorResponse(401, "Unauthorized", "invalid file token")
    const target = new URL(url)
    target.searchParams.delete(BOX_TOKEN_QUERY)
    const headers = new Headers(request.headers)
    headers.delete(FILE_TOKEN_HEADER)
    headers.delete("cookie")
    headers.delete("authorization")
    headers.set(CREDENTIALS_HEADER, JSON.stringify(this.sessionCredentials(session)))
    return this.relay(new Request(request, { headers }), target)
  }

  private previewReferer(request: Request): { token: string; taskId: string } | null {
    const referer = request.headers.get("referer")
    if (referer === null) return null
    let pathname: string
    try {
      pathname = new URL(referer).pathname
    } catch {
      return null
    }
    const match = /^\/_preview\/([0-9a-f-]{36})\/([^/]+)(?:\/.*)?$/.exec(pathname)
    return match?.[1] && match[2] ? { token: match[1], taskId: decodeURIComponent(match[2]) } : null
  }

  private async previewRelay(request: Request, url: URL): Promise<Response> {
    const direct = /^\/_preview\/([0-9a-f-]{36})\/([^/]+)(\/.*)?$/.exec(url.pathname)
    const referer = this.previewReferer(request)
    const token = direct?.[1] ?? referer?.token
    const taskId = direct?.[2] ? decodeURIComponent(direct[2]) : referer?.taskId
    if (!token || !taskId) return errorResponse(404, "NotFound", "preview not found")
    const session = this.previewSession(token)
    if (!session || session.taskId !== taskId) return errorResponse(404, "NotFound", "preview not found")
    const suffix = direct ? (direct[3] || "/") : `${url.pathname}${url.search}`
    const target = new URL(`${Paths.taskPreview(taskId)}${suffix}${direct ? url.search : ""}`, request.url)
    const headers = new Headers(request.headers)
    headers.delete("cookie")
    headers.delete("authorization")
    headers.set(CREDENTIALS_HEADER, JSON.stringify(this.credentials(session.login)))
    headers.set("x-kestrel-preview-token", token)
    const protocol = request.headers.get("sec-websocket-protocol")
    if (protocol) headers.set("x-kestrel-preview-protocol", protocol.split(",")[0]!.trim())
    const forwarded = new Request(request, { headers })
    const response = await this.relay(forwarded, target)
    if (response.status === 101) return response
    const outputHeaders = new Headers(response.headers)
    outputHeaders.set("referrer-policy", "strict-origin-when-cross-origin")
    return new Response(response.body, { status: response.status, headers: outputHeaders })
  }

  /**
   * A Nest host's control socket. The host names itself in `NEST_HOST_ID_HEADER` and proves itself with its host
   * secret, the same secret its meter batches use. Its first frame must be `hello`; no command reaches it before.
   */
  private async acceptNestHost(request: Request): Promise<Response> {
    if (request.headers.get("upgrade")?.toLowerCase() !== "websocket") {
      return errorResponse(426, "UpgradeRequired", "expected a WebSocket upgrade")
    }
    const auth = request.headers.get("authorization") ?? ""
    const secret = auth.startsWith("Bearer ") ? auth.slice("Bearer ".length) : ""
    const hostId = request.headers.get(NEST_HOST_ID_HEADER) ?? ""
    const stored = meterHostSecret(this.ctx.storage.sql, hostId)
    if (secret === "" || stored === undefined || !(await safeEqual(secret, stored))) {
      return errorResponse(401, "Unauthorized", "invalid Nest host credentials")
    }
    // Latest connection wins: the previous socket for this host is dropped.
    for (const old of this.ctx.getWebSockets(NEST_HOST_TAG)) {
      const attachment = nestAttachment(old)
      if (attachment === null || attachment.hostId !== hostId) continue
      // A retired socket takes no more frames: its host now talks over the new connection.
      old.serializeAttachment({ ...attachment, retired: true })
      closeQuietly(old, 4000, "replaced")
    }
    const pair = new WebSocketPair()
    const client = pair[0]
    const server = pair[1]
    const attachment: NestAttachment = { hostId, hello: false }
    this.ctx.acceptWebSocket(server, [NEST_HOST_TAG])
    server.serializeAttachment(attachment)
    return new Response(null, { status: 101, webSocket: client })
  }

  private isNestSocket(ws: WebSocket): boolean {
    return this.ctx.getTags(ws).includes(NEST_HOST_TAG)
  }

  /** The host's socket once its `hello` was accepted; null while the host is away. */
  private nestSocket(hostId: string): WebSocket | null {
    for (const ws of this.ctx.getWebSockets(NEST_HOST_TAG)) {
      const attachment = nestAttachment(ws)
      if (attachment?.hostId === hostId && attachment.hello && !attachment.retired) return ws
    }
    return null
  }

  private sendNestFrame(hostId: string, frame: NestControlFrame): boolean {
    const ws = this.nestSocket(hostId)
    if (ws === null) return false
    try {
      ws.send(JSON.stringify(frame))
      return true
    } catch {
      return false
    }
  }

  private nestSocketGone(ws: WebSocket): void {
    const attachment = nestAttachment(ws)
    if (attachment !== null) this.nest.hostDisconnected(attachment.hostId)
  }

  private refuseNestHost(ws: WebSocket, reason: string): void {
    const refusal: NestControlFrame = { _tag: "refused", reason }
    ws.send(JSON.stringify(refusal))
    closeQuietly(ws, 1008, reason)
  }

  /** One frame from a Nest host. A malformed, oversized or out-of-order frame closes the socket. */
  private async onNestFrame(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    const attachment = nestAttachment(ws)
    if (attachment === null) {
      closeQuietly(ws, 1011, "no host")
      return
    }
    if (attachment.retired) {
      closeQuietly(ws, 4000, "replaced")
      return
    }
    if (typeof message !== "string") {
      closeQuietly(ws, 1003, "binary frames are not Nest frames")
      return
    }
    if (new TextEncoder().encode(message).byteLength > MAX_NEST_FRAME_BYTES) {
      closeQuietly(ws, 1009, "frame too large")
      return
    }
    const decoded = decodeNestHostFrame(message)
    if (Either.isLeft(decoded)) {
      this.refuseNestHost(ws, "malformed frame")
      return
    }
    const frame = decoded.right
    if (!attachment.hello) {
      if (frame._tag !== "hello") return this.refuseNestHost(ws, "the first frame must be hello")
      if (frame.protocol !== NEST_HOST_PROTOCOL) return this.refuseNestHost(ws, `unsupported Nest protocol ${frame.protocol}`)
      if (frame.hostId !== attachment.hostId) return this.refuseNestHost(ws, "host id does not match its credentials")
      const attached: NestAttachment = { hostId: attachment.hostId, hello: true }
      ws.serializeAttachment(attached)
      await this.nest.hello(frame)
      await this.rearm()
      return
    }
    switch (frame._tag) {
      case "hello":
        this.refuseNestHost(ws, "hello sent twice")
        return
      case "capacity":
        await this.nest.capacity(attachment.hostId, frame.capacity)
        break
      case "vm":
        this.nest.vm(attachment.hostId, frame.vm)
        break
      case "result":
        this.nest.result(attachment.hostId, frame.commandId, frame.ok, frame.error ?? null, frame.vm)
        break
      case "inventory":
        this.nest.inventory(attachment.hostId, frame.vms, frame.last)
        break
      case "wakeRequest":
        await this.nest.wakeRequest(attachment.hostId, frame.boxId)
        break
    }
    await this.rearm()
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
      return this.openStream(box, path, headers, request.headers.get("sec-websocket-protocol")?.split(",")[0]?.trim())
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
      resolve(errorResponse(504, "BoxOffline", "agent box did not respond in time"))
    }, HTTP_TIMEOUT_MS)
    this.pending.set(frame.id, { resolve, timer })
    try {
      box.send(encodeFrame(frame))
    } catch {
      clearTimeout(timer)
      this.pending.delete(frame.id)
      resolve(errorResponse(502, "BoxOffline", "agent box is unreachable"))
    }
    return promise
  }

  private openStream(box: WebSocket, path: string, headers: Record<string, string>, protocol?: string): Response {
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
      // Complete the closing handshake: without this the browser stays CLOSING and never drops the connection.
      closeQuietly(server, closeCode(event.code), "")
    })

    try {
      box.send(encodeFrame({ t: "ws-open", id, path, headers }))
    } catch {
      this.streams.delete(id)
      closeQuietly(server, 1000, "agent box unreachable")
      return errorResponse(502, "BoxOffline", "agent box is unreachable")
    }
    return new Response(null, {
      status: 101,
      webSocket: client,
      ...(protocol ? { headers: { "sec-websocket-protocol": protocol } } : {}),
    })
  }

  // -------------------------------------------------------------------------
  // Box socket (hibernatable)
  // -------------------------------------------------------------------------

  override webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): void {
    if (this.isNestSocket(ws)) {
      this.onNestFrame(ws, message).catch((error: unknown) => {
        console.error(`nest: host frame failed: ${error instanceof Error ? error.message : String(error)}`)
        closeQuietly(ws, 1011, "internal error")
      })
      return
    }
    if (typeof message === "string") {
      const frame = decodeFrame(message)
      if (frame) this.onFrame(ws, frame)
      return
    }
    // Current boxes send no binary frames. Boxes from before WebRTC-only desktops still send fMP4 here, and installed
    // native apps from then play it; this merge does not update either, so this stays until they are gone.
    const bin = decodeBinary(new Uint8Array(message))
    if (bin) this.streams.get(bin.id)?.send(bin.payload)
  }

  override webSocketClose(ws: WebSocket, code: number): void {
    if (this.isNestSocket(ws)) this.nestSocketGone(ws)
    else this.boxLost(ws)
    closeQuietly(ws, closeCode(code), "")
  }

  override webSocketError(ws: WebSocket): void {
    if (this.isNestSocket(ws)) this.nestSocketGone(ws)
    else this.boxLost(ws)
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
      p.resolve(errorResponse(502, "BoxOffline", "agent box disconnected"))
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
