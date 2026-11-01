/**
 * Kestrel's managed boxes in the Hub: the fleet registry, each user's assignment to one of them, and the managed box
 * authorization rules. Kept apart from the Hub class so the rules can be exercised against a plain SQLite database.
 */
import type { FleetBox, UpdateFleetBoxBody } from "@cloudagents/protocol"
import { safeEqual } from "./http"

/** The slice of `SqlStorage` the fleet tables need. */
export interface FleetSql {
  exec<T extends Record<string, string | number | null>>(
    query: string,
    ...bindings: (string | number | null)[]
  ): { toArray(): T[] }
}

/** A managed box with the secret the Hub signs its tokens with. */
export type ManagedBoxRow = {
  readonly id: string
  readonly url: string
  readonly secret: string
}

/** Whether `login` may use the managed box `boxId`, given the secret the box presented. */
export type ManagedBoxAccess = "granted" | "unauthenticated" | "unassigned"

/**
 * Creates `managed_boxes` and adds `users.managed_box_id` (the user's assignment) when it is missing. The `users`
 * table must already exist.
 */
export const ensureFleetTable = (sql: FleetSql): void => {
  sql.exec(`CREATE TABLE IF NOT EXISTS managed_boxes (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    url TEXT NOT NULL,
    secret TEXT NOT NULL,
    state TEXT NOT NULL,
    created_at TEXT NOT NULL
  )`)
  const userColumns = sql.exec<{ name: string }>("PRAGMA table_info(users)").toArray()
  if (!userColumns.some((c) => c.name === "managed_box_id")) {
    sql.exec("ALTER TABLE users ADD COLUMN managed_box_id TEXT")
  }
}

/** The view of a box for the operator, with how many users are assigned to it. */
const FLEET_BOX_COLUMNS = `mb.id, mb.name, mb.url, mb.state, mb.created_at AS createdAt,
  (SELECT COUNT(*) FROM users u WHERE u.managed_box_id = mb.id) AS users`

export const listFleetBoxes = (sql: FleetSql): FleetBox[] =>
  sql.exec<FleetBox>(`SELECT ${FLEET_BOX_COLUMNS} FROM managed_boxes mb ORDER BY mb.created_at, mb.rowid`).toArray()

export const fleetBox = (sql: FleetSql, id: string): FleetBox | null =>
  sql.exec<FleetBox>(`SELECT ${FLEET_BOX_COLUMNS} FROM managed_boxes mb WHERE mb.id = ?`, id).toArray()[0] ?? null

/** A new box starts `pending`: it gets no users until an operator activates it. */
export const insertFleetBox = (
  sql: FleetSql,
  box: { id: string; name: string; url: string; secret: string; createdAt: string },
): void => {
  sql.exec(
    "INSERT INTO managed_boxes (id, name, url, secret, state, created_at) VALUES (?, ?, ?, ?, 'pending', ?)",
    box.id,
    box.name,
    box.url,
    box.secret,
    box.createdAt,
  )
}

/** Applies the given fields; null when the box does not exist. */
export const updateFleetBox = (sql: FleetSql, id: string, changes: UpdateFleetBoxBody): FleetBox | null => {
  sql.exec(
    "UPDATE managed_boxes SET name = COALESCE(?, name), url = COALESCE(?, url), state = COALESCE(?, state) WHERE id = ?",
    changes.name ?? null,
    changes.url ?? null,
    changes.state ?? null,
    id,
  )
  return fleetBox(sql, id)
}

/** Replaces the box's secret, so tokens signed with the old one stop verifying. False when the box does not exist. */
export const rotateFleetBoxSecret = (sql: FleetSql, id: string, secret: string): boolean => {
  sql.exec("UPDATE managed_boxes SET secret = ? WHERE id = ?", secret, id)
  return fleetBox(sql, id) !== null
}

/**
 * Removes the box and unassigns its users; they are placed on another managed box at their next lookup. False when
 * the box does not exist.
 */
export const deleteFleetBox = (sql: FleetSql, id: string): boolean => {
  if (fleetBox(sql, id) === null) return false
  sql.exec("UPDATE users SET managed_box_id = NULL WHERE managed_box_id = ?", id)
  sql.exec("DELETE FROM managed_boxes WHERE id = ?", id)
  return true
}

/**
 * The managed box `login` is assigned to, assigning one first when needed. The current assignment is kept while its
 * box is `active` or `draining`. Otherwise the user moves to the `active` box with the fewest assigned users (ties:
 * oldest `created_at`, then insertion order); with no active box the user is left unassigned and this returns null.
 * Pending boxes never receive users.
 */
export const managedBoxFor = (sql: FleetSql, login: string): ManagedBoxRow | null => {
  const current = sql
    .exec<ManagedBoxRow>(
      `SELECT mb.id, mb.url, mb.secret FROM users u JOIN managed_boxes mb ON mb.id = u.managed_box_id
       WHERE u.login = ? AND mb.state IN ('active', 'draining')`,
      login,
    )
    .toArray()[0]
  if (current !== undefined) return current
  const next =
    sql
      .exec<ManagedBoxRow>(
        `SELECT mb.id, mb.url, mb.secret FROM managed_boxes mb
         WHERE mb.state = 'active'
         ORDER BY (SELECT COUNT(*) FROM users u WHERE u.managed_box_id = mb.id), mb.created_at, mb.rowid
         LIMIT 1`,
      )
      .toArray()[0] ?? null
  if (next === null) {
    // Only clears a stale assignment; a user who never had one costs no row write on every box list.
    sql.exec("UPDATE users SET managed_box_id = NULL WHERE login = ? AND managed_box_id IS NOT NULL", login)
    return null
  }
  sql.exec("UPDATE users SET managed_box_id = ? WHERE login = ?", next.id, login)
  return next
}

/**
 * Authorizes a managed box's call on behalf of `login`: the secret must be the box's (unknown ids are unauthenticated),
 * and the user must be assigned to that box.
 */
export const managedBoxAccess = async (
  sql: FleetSql,
  boxId: string,
  secret: string,
  login: string,
): Promise<ManagedBoxAccess> => {
  const stored = sql.exec<{ secret: string }>("SELECT secret FROM managed_boxes WHERE id = ?", boxId).toArray()[0]
  if (stored === undefined || !(await safeEqual(secret, stored.secret))) return "unauthenticated"
  const assigned = sql
    .exec<{ found: number }>("SELECT 1 AS found FROM users WHERE login = ? AND managed_box_id = ?", login, boxId)
    .toArray()
  return assigned.length > 0 ? "granted" : "unassigned"
}
