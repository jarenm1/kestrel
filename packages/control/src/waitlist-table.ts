/**
 * Public waitlist signups in the Hub. Kept apart from the Hub class so the storage rules can be exercised against a
 * plain SQLite database.
 */
import type { WaitlistSignup } from "@cloudagents/protocol"
import type { FleetSql } from "./fleet-table"

export const ensureWaitlistTable = (sql: FleetSql): void => {
  sql.exec(`CREATE TABLE IF NOT EXISTS waitlist_signups (
    email TEXT PRIMARY KEY,
    created_at TEXT NOT NULL
  )`)
}

/** Stores `email` once, case-insensitively; an existing entry keeps its original timestamp. */
export const storeWaitlistSignup = (sql: FleetSql, email: string, now: Date): WaitlistSignup => {
  const normalized = email.trim().toLowerCase()
  const existing = sql
    .exec<{ email: string; createdAt: string }>(
      "SELECT email, created_at AS createdAt FROM waitlist_signups WHERE email = ?",
      normalized,
    )
    .toArray()[0]
  if (existing !== undefined) return { ...existing, created: false }

  const createdAt = now.toISOString()
  sql.exec("INSERT INTO waitlist_signups (email, created_at) VALUES (?, ?)", normalized, createdAt)
  return { email: normalized, createdAt, created: true }
}
