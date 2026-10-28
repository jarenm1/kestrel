/**
 * The `automations` table in the Hub. Kept apart from the Hub class so the schema and its one-time rebuild can be
 * exercised against a plain SQLite database.
 */

/** The slice of `SqlStorage` the automations table needs. */
export interface AutomationsSql {
  exec<T extends Record<string, string | number | null>>(
    query: string,
    ...bindings: (string | number | null)[]
  ): { toArray(): T[] }
}

const COLUMNS = `
  id TEXT PRIMARY KEY,
  login TEXT NOT NULL,
  name TEXT NOT NULL,
  repo TEXT,
  prompt TEXT NOT NULL,
  enabled INTEGER NOT NULL,
  trigger_json TEXT NOT NULL,
  next_run_at INTEGER,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL`

const COPIED_COLUMNS =
  "id, login, name, repo, prompt, enabled, trigger_json, next_run_at, created_at, updated_at"

/**
 * Creates the table, or rebuilds it when it still has the legacy `repo_id` column (NOT NULL, the box's repository
 * id). Every row is kept; `repo` is the only repository link now, so rows without one stay repository-less
 * schedules. Run inside a transaction so an interrupted rebuild never leaves the rows stranded.
 */
export const ensureAutomationsTable = (sql: AutomationsSql): void => {
  const legacy = sql
    .exec<{ name: string }>("SELECT name FROM pragma_table_info('automations') WHERE name = 'repo_id'")
    .toArray()
  if (legacy.length > 0) {
    sql.exec("ALTER TABLE automations RENAME TO automations_legacy")
    sql.exec(`CREATE TABLE automations (${COLUMNS})`)
    sql.exec(`INSERT INTO automations (${COPIED_COLUMNS}) SELECT ${COPIED_COLUMNS} FROM automations_legacy`)
    sql.exec("DROP TABLE automations_legacy")
  }
  sql.exec(`CREATE TABLE IF NOT EXISTS automations (${COLUMNS})`)
}
