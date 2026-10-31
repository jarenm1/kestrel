import { DurableObject } from "cloudflare:workers"
import { Option, Schema } from "effect"
import {
  ControlPaths,
  Paths,
  AutomationTrigger,
  BOX_TOKEN_TTL_SECONDS,
  MANAGED_BOX_ID,
  MANAGED_BOX_TOKEN_TTL_SECONDS,
  MAX_USER_BOXES,
  PAIRING_TTL_SECONDS,
  signBoxToken,
  signManagedBoxToken,
  type ApprovePairingBody,
  type Automation,
  type AutomationRun,
  type BoxList,
  type BoxSelf,
  type BoxToken,
  type CreateAutomationBody,
  type CreateBoxBody,
  type CreateTaskBody,
  type CreatedBox,
  type PairingPoll,
  type PairingStart,
  type PairingStartBody,
  type PendingPairing,
  type UpdateAutomationBody,
  type UpdateBoxBody,
  type UserBox,
} from "@cloudagents/protocol"
import { safeEqual } from "./http"
import { matchGithubTrigger, type PullRequestEvent, type PullRequestInfo } from "./github"
import { localDate, nextFireTime } from "./cron"
import { claimHookRow, type HookRow } from "./hooks"
import { ensureAutomationsTable } from "./automations-table"
import { composePrompt } from "./prompt"
import type { Env } from "./env"
import { managedBoxUrl, managedSigningKey } from "./managed"

/** A failed box call: the HTTP status and error body the Worker answers with. */
export type BoxFailure = { ok: false; status: number; tag: string; message: string }
export type BoxOutcome<T> = { ok: true; value: T } | BoxFailure

const UNAUTHENTICATED: BoxFailure = { ok: false, status: 401, tag: "Unauthorized", message: "sign in required" }
const NO_SUCH_BOX: BoxFailure = { ok: false, status: 404, tag: "NotFound", message: "no such box" }
const NO_SUCH_PAIRING: BoxFailure = { ok: false, status: 404, tag: "NotFound", message: "no such pairing or it expired" }
const MANAGED_UNAVAILABLE: BoxFailure = {
  ok: false,
  status: 503,
  tag: "Unavailable",
  message: "managed box is not configured",
}

/** 32 random bytes, base64url: a box secret, or the id a pairing is polled with. */
const newSecret = (): string =>
  btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32))))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "")

/** Pairing codes: 8 characters from 32 symbols with no 0, O, 1 or I. 32 divides 256, so each byte is unbiased. */
const PAIRING_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"
const newPairingCode = (): string =>
  Array.from(crypto.getRandomValues(new Uint8Array(8)), (byte) => PAIRING_ALPHABET.charAt(byte & 31)).join("")

/**
 * Singleton Durable Object (`idFromName("main")`) holding all control-plane state. Box traffic never passes through it:
 * browsers and boxes talk to the box directly, and the managed box is reached with a short-lived grant.
 *
 * - SQLite tables: users, sessions, connections, user_boxes, oauth_states, automations, automation_runs, github_hooks,
 *   webhook_deliveries, box_pairings.
 *
 * Methods are RPC-callable from the Worker.
 */

const HTTP_TIMEOUT_MS = 30_000

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

export type OAuthKind = "login" | "connect"

export type UserRecord = { login: string; name: string | null; avatarUrl: string }

/** `dev`: the session came from `/auth/dev-login`. */
export type SessionRecord = { login: string; dev: boolean }

export type OAuthStateRecord = { kind: OAuthKind; provider: string; returnTo: string }

export class Hub extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env)
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
      sql.exec("DROP TABLE IF EXISTS preview_sessions")
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
    return row ? { login: row.login, dev: row.dev === 1 } : null
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

  /** The user's connection secrets, by provider. */
  connectionSecrets(login: string): { github?: string; anthropic?: string; openai?: string } {
    const out: { github?: string; anthropic?: string; openai?: string } = {}
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

  async listBoxes(sessionId: string): Promise<BoxOutcome<BoxList>> {
    const session = this.session(sessionId)
    return session ? { ok: true, value: await this.boxList(session.login) } : UNAUTHENTICATED
  }

  createBox(sessionId: string, body: CreateBoxBody): BoxOutcome<CreatedBox> {
    const session = this.session(sessionId)
    if (!session) return UNAUTHENTICATED
    return this.insertBox(session.login, body)
  }

  /** The one insertion path for a new box: `createBox` and pairing approval share it (same limit, new secret). */
  private insertBox(login: string, body: CreateBoxBody): BoxOutcome<CreatedBox> {
    const sql = this.ctx.storage.sql
    const count =
      sql.exec<{ count: number }>("SELECT COUNT(*) AS count FROM user_boxes WHERE login = ?", login).toArray()[0]
        ?.count ?? 0
    if (count >= MAX_USER_BOXES) {
      return { ok: false, status: 409, tag: "Conflict", message: `at most ${MAX_USER_BOXES} boxes per user` }
    }
    const box: UserBox = { id: crypto.randomUUID(), name: body.name, url: body.url, createdAt: new Date().toISOString() }
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

  deleteBox(sessionId: string, id: string): BoxOutcome<null> {
    const session = this.session(sessionId)
    if (!session) return UNAUTHENTICATED
    if (!this.ownedBox(session.login, id)) return NO_SUCH_BOX
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

  /** A token the owner gives their box: signed with the box's secret, audience is the box id. */
  async mintBoxToken(sessionId: string, id: string): Promise<BoxOutcome<BoxToken>> {
    const session = this.session(sessionId)
    if (!session) return UNAUTHENTICATED
    const owned = this.ownedBox(session.login, id)
    if (!owned) return NO_SUCH_BOX
    const iat = Math.floor(Date.now() / 1000)
    const exp = iat + BOX_TOKEN_TTL_SECONDS
    const token = await signBoxToken(owned.secret, {
      sub: session.login,
      aud: id,
      iat,
      exp,
      cv: this.credentialsVersion(session.login),
      ...(session.dev ? { dev: true } : {}),
    })
    return { ok: true, value: { token, url: owned.box.url, expiresAt: new Date(exp * 1000).toISOString() } }
  }

  async setActiveBox(sessionId: string, boxId: string | null): Promise<BoxOutcome<BoxList>> {
    const session = this.session(sessionId)
    if (!session) return UNAUTHENTICATED
    if (boxId !== null && !this.ownedBox(session.login, boxId)) return NO_SUCH_BOX
    this.ctx.storage.sql.exec("UPDATE users SET active_box_id = ? WHERE login = ?", boxId, session.login)
    return { ok: true, value: await this.boxList(session.login) }
  }

  /** The box's owner and their connection secrets for `ControlPaths.boxSelf`; null unless `secret` is the box's. */
  async boxSelf(boxId: string, secret: string): Promise<BoxSelf | null> {
    const row = this.ctx.storage.sql
      .exec<{ login: string; secret: string }>("SELECT login, secret FROM user_boxes WHERE id = ?", boxId)
      .toArray()[0]
    if (!row || !(await safeEqual(secret, row.secret))) return null
    return {
      owner: row.login,
      credentialsVersion: this.credentialsVersion(row.login),
      ...this.connectionSecrets(row.login),
    }
  }

  /** A fresh managed grant for the signed-in user; the browser calls the managed box directly with it. */
  async mintManagedBoxToken(sessionId: string): Promise<BoxOutcome<BoxToken>> {
    const session = this.session(sessionId)
    if (!session) return UNAUTHENTICATED
    return this.managedGrant(session.login, session.dev)
  }

  /** The trusted managed-box service's read of a user's connection secrets; null for a user the control plane does not know. */
  managedBoxCredentials(login: string): BoxSelf | null {
    const known = this.ctx.storage.sql.exec("SELECT login FROM users WHERE login = ?", login).toArray()[0]
    if (!known) return null
    return { owner: login, credentialsVersion: this.credentialsVersion(login), ...this.connectionSecrets(login) }
  }

  /**
   * A short-lived managed grant for `login`, signed with the managed signing key. The managed box verifies it offline
   * and fetches the user's credentials from `/box/credentials` on first use or when `cv` changes.
   */
  private async managedGrant(login: string, dev: boolean): Promise<BoxOutcome<BoxToken>> {
    const url = managedBoxUrl(this.env)
    const key = await managedSigningKey(this.env)
    if (url === null || key === null) return MANAGED_UNAVAILABLE
    const iat = Math.floor(Date.now() / 1000)
    const exp = iat + MANAGED_BOX_TOKEN_TTL_SECONDS
    let token: string
    try {
      token = await signManagedBoxToken(key, {
        sub: login,
        aud: MANAGED_BOX_ID,
        iat,
        exp,
        cv: this.credentialsVersion(login),
        ...(dev ? { dev: true } : {}),
      })
    } catch {
      // The key imports but cannot sign. The error may describe key material, so it is logged generically, not echoed.
      console.error("managed box grant could not be signed")
      return MANAGED_UNAVAILABLE
    }
    return { ok: true, value: { token, url, expiresAt: new Date(exp * 1000).toISOString() } }
  }

  private async boxList(login: string): Promise<BoxList> {
    const sql = this.ctx.storage.sql
    const boxes = sql
      .exec<UserBox>(
        "SELECT id, name, url, created_at AS createdAt FROM user_boxes WHERE login = ? ORDER BY created_at, rowid",
        login,
      )
      .toArray()
    const user = sql
      .exec<{ activeBoxId: string | null }>("SELECT active_box_id AS activeBoxId FROM users WHERE login = ?", login)
      .toArray()[0]
    const managedUrl = managedBoxUrl(this.env)
    const managedBox = managedUrl === null || (await managedSigningKey(this.env)) === null ? null : { url: managedUrl }
    return { boxes, activeBoxId: user?.activeBoxId ?? null, managedBox }
  }

  /** The box if `login` owns it, with its secret; null otherwise. */
  private ownedBox(login: string, id: string): { box: UserBox; secret: string } | null {
    const row = this.ctx.storage.sql
      .exec<UserBox & { secret: string }>(
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
      .exec<UserBox & { secret: string }>(
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
  async approvePairing(sessionId: string, code: string, body: ApprovePairingBody): Promise<BoxOutcome<BoxList>> {
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
    return { ok: true, value: await this.boxList(session.login) }
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
  // Managed box calls: one direct request to the managed box for `login`, with a fresh grant
  // -------------------------------------------------------------------------

  /**
   * One request from the control plane straight to the managed box, as `login`. Provider credentials never travel as
   * headers; the box fetches them itself from `/box/credentials`.
   */
  async boxCall(login: string, method: "GET" | "POST", path: string, payload?: unknown): Promise<BoxResult> {
    const grant = await this.managedGrant(login, false)
    if (!grant.ok) return { ok: false, status: grant.status, body: JSON.stringify({ message: grant.message }) }
    const body = payload === undefined ? undefined : JSON.stringify(payload)
    try {
      const res = await fetch(new URL(path, grant.value.url), {
        method,
        headers: {
          authorization: `Bearer ${grant.value.token}`,
          ...(body === undefined ? {} : { "content-type": "application/json" }),
        },
        body,
        signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
      })
      return { ok: res.ok, status: res.status, body: await res.text() }
    } catch {
      return { ok: false, status: 502, body: JSON.stringify({ message: "agent box is unreachable" }) }
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
    return this.ctx.storage.sql
      .exec<AutomationRow>(`SELECT ${AUTOMATION_COLUMNS} FROM automations WHERE enabled = 1 AND repo COLLATE NOCASE = ?`, repo)
      .toArray()
      .some((row) => decodeTrigger(row.triggerJson)._tag === "github")
  }

  override async alarm(): Promise<void> {
    const now = Date.now()
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
    await this.rearm()
  }

  private automationRow(login: string, id: string): AutomationRow | null {
    return (
      this.ctx.storage.sql
        .exec<AutomationRow>(`SELECT ${AUTOMATION_COLUMNS} FROM automations WHERE id = ? AND login = ?`, id, login)
        .toArray()[0] ?? null
    )
  }

  /** Points the alarm at the earliest pending schedule, or clears it when none is pending. */
  private async rearm(): Promise<void> {
    const row = this.ctx.storage.sql
      .exec<{ at: number | null }>("SELECT MIN(next_run_at) AS at FROM automations WHERE enabled = 1")
      .toArray()[0]
    const at = row?.at ?? null
    if (at === null) await this.ctx.storage.deleteAlarm()
    else await this.ctx.storage.setAlarm(at)
  }

  private async fire(row: AutomationRow, reason: string, pr: PullRequestInfo | null): Promise<AutomationRun> {
    const now = Date.now()
    const trigger = decodeTrigger(row.triggerJson)
    const timeZone = trigger._tag === "schedule" ? trigger.timezone : "UTC"
    const title = pr === null ? `${row.name} · ${localDate(now, timeZone)}` : `${row.name} · PR #${pr.number}`
    const prompt = composePrompt({ name: row.name, prompt: row.prompt, reason, repo: row.repo, pr })
    // A PR run checks the repository out at the PR head; the base branch stays the diff base.
    const checkout =
      row.repo === null
        ? {}
        : { checkout: { repo: row.repo, ...(pr === null ? {} : { baseBranch: pr.baseRef, pullRequest: pr.number }) } }
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
}
