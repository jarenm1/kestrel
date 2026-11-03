/**
 * Desktop tokens: opaque, short-lived stand-ins for the session cookie on one task's desktop stream, for a WebView that
 * cannot send a Cookie header on its WebSocket. The page never holds the session, only this. A token carries the user
 * and dev flag of the session that minted it, and stops working when that session ends. It is kept apart from file
 * tokens because it can drive a desktop, while those end up in the URLs of images. An expired one fails the handshake,
 * and the viewer asks its host for a new URL.
 */
import type { FileToken } from "@cloudagents/protocol"
import type { FileTokenSql } from "./file-tokens"

export const DESKTOP_TOKEN_TTL_MS = 5 * 60 * 1000

const DESKTOP_STREAM_PATH = /^\/api\/tasks\/([^/]+)\/desktop\/stream$/

/** The task whose desktop stream `path` is, or null for any other path. */
export const desktopStreamTask = (path: string): string | null => {
  const task = DESKTOP_STREAM_PATH.exec(path)?.[1]
  if (task === undefined) return null
  try {
    return decodeURIComponent(task)
  } catch {
    return null
  }
}

export const ensureDesktopTokensTable = (sql: FileTokenSql): void => {
  sql.exec(`CREATE TABLE IF NOT EXISTS session_desktop_tokens (
    token TEXT PRIMARY KEY,
    session_id TEXT NOT NULL,
    task_id TEXT NOT NULL,
    expires_at INTEGER NOT NULL
  )`)
}

/** Mints a token for `taskId`'s stream, as the session `sessionId`, dropping expired ones first. `now` is epoch ms. */
export const createDesktopToken = (sql: FileTokenSql, sessionId: string, taskId: string, now = Date.now()): FileToken => {
  const token = crypto.randomUUID()
  const expiresAt = now + DESKTOP_TOKEN_TTL_MS
  sql.exec("DELETE FROM session_desktop_tokens WHERE expires_at <= ?", now)
  sql.exec(
    "INSERT INTO session_desktop_tokens (token, session_id, task_id, expires_at) VALUES (?, ?, ?, ?)",
    token,
    sessionId,
    taskId,
    expiresAt,
  )
  return { token, expiresAt: new Date(expiresAt).toISOString() }
}

/** The session behind a live `token` for `taskId`'s stream, or null. `now` is epoch ms. */
export const desktopTokenSession = (sql: FileTokenSql, token: string, taskId: string, now = Date.now()): string | null =>
  sql
    .exec<{ sessionId: string }>(
      "SELECT session_id AS sessionId FROM session_desktop_tokens WHERE token = ? AND task_id = ? AND expires_at > ?",
      token,
      taskId,
      now,
    )
    .toArray()[0]?.sessionId ?? null

/** Revokes every desktop token a session minted; called when the session ends. */
export const deleteSessionDesktopTokens = (sql: FileTokenSql, sessionId: string): void => {
  sql.exec("DELETE FROM session_desktop_tokens WHERE session_id = ?", sessionId)
}
