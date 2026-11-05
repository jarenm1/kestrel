/**
 * Active users per managed box in the Hub: one bounded snapshot per box, replaced whole on every report. A snapshot
 * names which users had an authenticated request to that box in the activity window; no prompt, thread or content is
 * kept. Kept apart from the Hub class so the rules can be exercised against a plain SQLite database.
 */
import {
  ACTIVITY_STALE_AFTER_SECONDS,
  ACTIVITY_WINDOW_SECONDS,
  MAX_ACTIVITY_CLOCK_SKEW_SECONDS,
  MAX_BOX_ACTIVITY_USERS,
  type BoxActivityReport,
  type BoxActivityUser,
  type FleetActivity,
  type FleetActivityBox,
} from "@cloudagents/protocol"
import type { FleetSql } from "./fleet-table"

const WINDOW_MS = ACTIVITY_WINDOW_SECONDS * 1000
const STALE_AFTER_MS = ACTIVITY_STALE_AFTER_SECONDS * 1000
const CLOCK_SKEW_MS = MAX_ACTIVITY_CLOCK_SKEW_SECONDS * 1000

/** A snapshot row: the receiver's clock, plus the users as the JSON array the box last reported. */
type ActivityRow = { boxId: string; receivedAt: number | null; users: string | null }

export const ensureBoxActivityTable = (sql: FleetSql): void => {
  sql.exec(`CREATE TABLE IF NOT EXISTS box_activity (
    box_id TEXT PRIMARY KEY,
    received_at INTEGER NOT NULL,
    users_json TEXT NOT NULL
  )`)
}

/**
 * Replaces `boxId`'s snapshot with `report`. Only users currently assigned to that box are kept, so a box cannot make
 * an arbitrary identity appear in the fleet view. Users older than the activity window are dropped, and a timestamp up
 * to the clock-skew allowance in the future is clamped to the receiver's clock; anything later is ignored. The report
 * is authoritative and full: an empty `users` clears the box's previous snapshot.
 */
export const recordBoxActivity = (sql: FleetSql, boxId: string, report: BoxActivityReport, now: Date): void => {
  const nowMs = now.getTime()
  const cutoff = nowMs - WINDOW_MS
  const assigned = new Set(
    sql.exec<{ login: string }>("SELECT login FROM users WHERE managed_box_id = ?", boxId).toArray().map((row) => row.login),
  )
  // Keep the latest sighting per login, so a duplicated login cannot make the stored count differ from the API's.
  const latest = new Map<string, string>()
  for (const user of report.users.slice(0, MAX_BOX_ACTIVITY_USERS)) {
    if (!assigned.has(user.login)) continue
    const at = Date.parse(user.lastActiveAt)
    if (!Number.isFinite(at) || at <= cutoff || at > nowMs + CLOCK_SKEW_MS) continue
    const lastActiveAt = new Date(Math.min(at, nowMs)).toISOString()
    const previous = latest.get(user.login)
    if (previous === undefined || previous < lastActiveAt) latest.set(user.login, lastActiveAt)
  }
  const users: BoxActivityUser[] = [...latest]
    .map(([login, lastActiveAt]) => ({ login, lastActiveAt }))
    .sort((a, b) => (a.lastActiveAt === b.lastActiveAt ? a.login.localeCompare(b.login) : b.lastActiveAt.localeCompare(a.lastActiveAt)))
  sql.exec(
    `INSERT INTO box_activity (box_id, received_at, users_json) VALUES (?, ?, ?)
     ON CONFLICT(box_id) DO UPDATE SET received_at = excluded.received_at, users_json = excluded.users_json`,
    boxId,
    nowMs,
    JSON.stringify(users),
  )
}

/** Forgets a deleted box's snapshot. */
export const deleteBoxActivity = (sql: FleetSql, boxId: string): void => {
  sql.exec("DELETE FROM box_activity WHERE box_id = ?", boxId)
}

/** The stored snapshot's users, with malformed or tampered rows treated as empty. */
const storedUsers = (row: ActivityRow): BoxActivityUser[] => {
  if (row.users === null) return []
  try {
    const value: unknown = JSON.parse(row.users)
    if (!Array.isArray(value)) return []
    return value.flatMap((entry): BoxActivityUser[] => {
      if (typeof entry !== "object" || entry === null) return []
      const { login, lastActiveAt } = entry as { login?: unknown; lastActiveAt?: unknown }
      return typeof login === "string" && typeof lastActiveAt === "string" ? [{ login, lastActiveAt }] : []
    })
  } catch {
    return []
  }
}

/**
 * `ControlPaths.fleetActivity`: every registered managed box, in fleet order including boxes that never reported
 * (`receivedAt` null). Users are filtered again here against the current assignment and window, so a snapshot cannot
 * outlive the user's assignment. A stale snapshot keeps its `receivedAt` but reports no users, never a stale count.
 */
export const fleetActivity = (sql: FleetSql, now: Date): FleetActivity => {
  const nowMs = now.getTime()
  const cutoff = nowMs - WINDOW_MS
  const assigned = new Map(
    sql
      .exec<{ login: string; boxId: string }>(
        "SELECT login, managed_box_id AS boxId FROM users WHERE managed_box_id IS NOT NULL",
      )
      .toArray()
      .map((row) => [row.login, row.boxId] as const),
  )
  const boxes: FleetActivityBox[] = sql
    .exec<ActivityRow>(
      `SELECT mb.id AS boxId, ba.received_at AS receivedAt, ba.users_json AS users
       FROM managed_boxes mb LEFT JOIN box_activity ba ON ba.box_id = mb.id
       ORDER BY mb.created_at, mb.rowid`,
    )
    .toArray()
    .map((row) => {
      if (row.receivedAt === null || nowMs - row.receivedAt >= STALE_AFTER_MS) {
        return { boxId: row.boxId, receivedAt: row.receivedAt === null ? null : new Date(row.receivedAt).toISOString(), users: [] }
      }
      const latest = new Map<string, string>()
      for (const user of storedUsers(row)) {
        if (assigned.get(user.login) !== row.boxId) continue
        const at = Date.parse(user.lastActiveAt)
        if (!Number.isFinite(at) || at <= cutoff || at > nowMs) continue
        const lastActiveAt = new Date(at).toISOString()
        const previous = latest.get(user.login)
        if (previous === undefined || previous < lastActiveAt) latest.set(user.login, lastActiveAt)
      }
      const users = [...latest]
        .map(([login, lastActiveAt]) => ({ login, lastActiveAt }))
        .sort((a, b) => (a.lastActiveAt === b.lastActiveAt ? a.login.localeCompare(b.login) : b.lastActiveAt.localeCompare(a.lastActiveAt)))
      return { boxId: row.boxId, receivedAt: new Date(row.receivedAt).toISOString(), users }
    })
  return { windowSeconds: ACTIVITY_WINDOW_SECONDS, staleAfterSeconds: ACTIVITY_STALE_AFTER_SECONDS, boxes }
}
