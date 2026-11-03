/**
 * File tokens: opaque, short-lived stand-ins for the session cookie so a WebView or DOM `<img>` can load box files
 * (`Paths.taskAttachment`, `Paths.taskRunImage`, `Paths.taskCheckoutIcon`), which cannot send a Cookie header. Stored in
 * the Hub like preview sessions. A token names the session that minted it, so it is only as good as that session: it
 * carries the session's user and dev flag, and it stops working when the session ends (sign-out or expiry). It is
 * valid for GET on those paths only. Kept apart from the Hub class so the rules can be exercised against plain SQLite.
 */
import type { FileToken } from "@cloudagents/protocol"

/** File tokens live for an hour; clients refresh a minute before `expiresAt`. */
export const FILE_TOKEN_TTL_MS = 60 * 60 * 1000

/** The slice of `SqlStorage` the file token table needs. */
export interface FileTokenSql {
  exec<T extends Record<string, string | number | null>>(
    query: string,
    ...bindings: (string | number | null)[]
  ): { toArray(): T[] }
}

/**
 * The box file paths a file token may load, matched against `url.pathname`: one task's attachment, run image, or
 * checkout icon. Anything else (including every other method) is refused.
 */
const BOX_FILE_PATH =
  /^\/api\/tasks\/[^/]+\/(?:attachments\/[^/]+|runs\/[^/]+\/images\/[^/]+|checkouts\/[^/]+\/icon\/[^/]+)$/

export const isBoxFilePath = (path: string): boolean => BOX_FILE_PATH.test(path)

export const ensureFileTokensTable = (sql: FileTokenSql): void => {
  sql.exec(`CREATE TABLE IF NOT EXISTS session_file_tokens (
    token TEXT PRIMARY KEY,
    session_id TEXT NOT NULL,
    expires_at INTEGER NOT NULL
  )`)
}

/** Mints a token for the session `sessionId`, dropping expired ones first. `now` is epoch ms. */
export const createFileToken = (sql: FileTokenSql, sessionId: string, now = Date.now()): FileToken => {
  const token = crypto.randomUUID()
  const expiresAt = now + FILE_TOKEN_TTL_MS
  sql.exec("DELETE FROM session_file_tokens WHERE expires_at <= ?", now)
  sql.exec(
    "INSERT INTO session_file_tokens (token, session_id, expires_at) VALUES (?, ?, ?)",
    token,
    sessionId,
    expiresAt,
  )
  return { token, expiresAt: new Date(expiresAt).toISOString() }
}

/** The session that minted a live `token`, or null when it is unknown or expired at `now` (epoch ms). */
export const fileTokenSession = (sql: FileTokenSql, token: string, now = Date.now()): string | null => {
  sql.exec("DELETE FROM session_file_tokens WHERE expires_at <= ?", now)
  return (
    sql
      .exec<{ sessionId: string }>(
        "SELECT session_id AS sessionId FROM session_file_tokens WHERE token = ? AND expires_at > ?",
        token,
        now,
      )
      .toArray()[0]?.sessionId ?? null
  )
}

/** Revokes every file token a session minted; called when the session ends. */
export const deleteSessionFileTokens = (sql: FileTokenSql, sessionId: string): void => {
  sql.exec("DELETE FROM session_file_tokens WHERE session_id = ?", sessionId)
}
