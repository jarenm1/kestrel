/**
 * File tokens: opaque, short-lived stand-ins for the session cookie so a WebView or DOM `<img>` can load box files
 * (`Paths.taskAttachment`, `Paths.taskRunImage`, `Paths.taskCheckoutIcon`), which cannot send a Cookie header. Stored in
 * the Hub like preview sessions; a token names the user who minted it and is valid for GET on those paths only.
 * Kept apart from the Hub class so the rules can be exercised against a plain SQLite database.
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
  sql.exec(`CREATE TABLE IF NOT EXISTS file_tokens (
    token TEXT PRIMARY KEY,
    login TEXT NOT NULL,
    expires_at INTEGER NOT NULL
  )`)
}

/** Mints a token for `login`, dropping expired ones first. `now` is epoch ms. */
export const createFileToken = (sql: FileTokenSql, login: string, now = Date.now()): FileToken => {
  const token = crypto.randomUUID()
  const expiresAt = now + FILE_TOKEN_TTL_MS
  sql.exec("DELETE FROM file_tokens WHERE expires_at <= ?", now)
  sql.exec("INSERT INTO file_tokens (token, login, expires_at) VALUES (?, ?, ?)", token, login, expiresAt)
  return { token, expiresAt: new Date(expiresAt).toISOString() }
}

/** The login that minted a live `token`, or null when it is unknown or expired at `now` (epoch ms). */
export const fileTokenLogin = (sql: FileTokenSql, token: string, now = Date.now()): string | null => {
  sql.exec("DELETE FROM file_tokens WHERE expires_at <= ?", now)
  return (
    sql
      .exec<{ login: string }>("SELECT login FROM file_tokens WHERE token = ? AND expires_at > ?", token, now)
      .toArray()[0]?.login ?? null
  )
}
