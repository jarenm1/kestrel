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
  model TEXT,
  enabled INTEGER NOT NULL,
  trigger_json TEXT NOT NULL,
  next_run_at INTEGER,
  created_at TEXT NOT NULL,
  webhook_token TEXT,
  updated_at TEXT NOT NULL`

const COPIED_COLUMNS =
  "id, login, name, repo, prompt, enabled, trigger_json, next_run_at, created_at, updated_at"

/** A new webhook credential: 32 random bytes as 64 hex characters. */
export const newWebhookToken = (): string =>
  Array.from(crypto.getRandomValues(new Uint8Array(32)), (byte) => byte.toString(16).padStart(2, "0")).join("")

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
  const modelColumn = sql
    .exec<{ name: string }>("SELECT name FROM pragma_table_info('automations') WHERE name = 'model'")
    .toArray()
  if (modelColumn.length === 0) sql.exec("ALTER TABLE automations ADD COLUMN model TEXT")
  const tokenColumn = sql
    .exec<{ name: string }>("SELECT name FROM pragma_table_info('automations') WHERE name = 'webhook_token'")
    .toArray()
  if (tokenColumn.length === 0) sql.exec("ALTER TABLE automations ADD COLUMN webhook_token TEXT")
  // Rows saved before webhooks existed get a token; SQLite's unique index allows any number of NULLs meanwhile.
  sql.exec("CREATE UNIQUE INDEX IF NOT EXISTS automations_webhook_token ON automations (webhook_token)")
  for (const row of sql.exec<{ id: string }>("SELECT id FROM automations WHERE webhook_token IS NULL").toArray()) {
    sql.exec("UPDATE automations SET webhook_token = ? WHERE id = ?", newWebhookToken(), row.id)
  }
}
