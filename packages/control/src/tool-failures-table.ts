/**
 * Tool failure counts in the Hub, one row per UTC day, tool and signature. No user, thread or box is kept with them.
 * Kept apart from the Hub class so the rules can be exercised against a plain SQLite database.
 */
import type { ToolFailureCount, ToolFailureSummary } from "@cloudagents/protocol"
import type { FleetSql } from "./fleet-table"

export const DEFAULT_TOOL_FAILURE_DAYS = 30
export const TOOL_FAILURE_RETENTION_DAYS = 90
const MAX_LISTED = 200
/** Past this many rows in a day, new signatures are dropped; ones already seen keep counting. */
const MAX_ROWS_PER_DAY = 5000
const DAY_MS = 24 * 60 * 60 * 1000

const dayOf = (at: Date, daysAgo = 0): string => new Date(at.getTime() - daysAgo * DAY_MS).toISOString().slice(0, 10)

export const ensureToolFailuresTable = (sql: FleetSql): void => {
  sql.exec(`CREATE TABLE IF NOT EXISTS tool_failures (
    day TEXT NOT NULL,
    tool TEXT NOT NULL,
    signature TEXT NOT NULL,
    count INTEGER NOT NULL,
    PRIMARY KEY (day, tool, signature)
  )`)
}

/** Adds a report to today's counts, and forgets days past the retention. */
export const recordToolFailures = (sql: FleetSql, failures: ReadonlyArray<ToolFailureCount>, now: Date): void => {
  const day = dayOf(now)
  sql.exec("DELETE FROM tool_failures WHERE day < ?", dayOf(now, TOOL_FAILURE_RETENTION_DAYS))
  let rows = sql.exec<{ n: number }>("SELECT COUNT(*) AS n FROM tool_failures WHERE day = ?", day).toArray()[0]?.n ?? 0
  for (const { tool, signature, count } of failures) {
    const seen = sql
      .exec("SELECT 1 AS found FROM tool_failures WHERE day = ? AND tool = ? AND signature = ?", day, tool, signature)
      .toArray()
    if (seen.length > 0) {
      sql.exec("UPDATE tool_failures SET count = count + ? WHERE day = ? AND tool = ? AND signature = ?", count, day, tool, signature)
    } else if (rows < MAX_ROWS_PER_DAY) {
      sql.exec("INSERT INTO tool_failures (day, tool, signature, count) VALUES (?, ?, ?, ?)", day, tool, signature, count)
      rows++
    }
  }
}

/** The most common failures of the last `days` days, today included. */
export const commonToolFailures = (sql: FleetSql, days: number, now: Date): ToolFailureSummary[] =>
  sql
    .exec<ToolFailureSummary>(
      `SELECT tool, signature, SUM(count) AS count, MIN(day) AS firstSeen, MAX(day) AS lastSeen
       FROM tool_failures WHERE day > ?
       GROUP BY tool, signature
       ORDER BY SUM(count) DESC, tool, signature
       LIMIT ?`,
      dayOf(now, days),
      MAX_LISTED,
    )
    .toArray()
