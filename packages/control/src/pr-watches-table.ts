/**
 * The `pr_watches` and `pr_activity_queue` tables in the Hub. A thread watches as many pull requests as it needs, so a
 * watch is keyed by thread, repository and number. Kept apart from the Hub class so the schema and its one-time rebuild
 * can be exercised against a plain SQLite database.
 */

/** The slice of `SqlStorage` these tables need. */
export interface PrWatchesSql {
  exec<T extends Record<string, string | number | null>>(
    query: string,
    ...bindings: (string | number | null)[]
  ): { toArray(): T[] }
}

const WATCHES = `
  login TEXT NOT NULL,
  task_id TEXT NOT NULL,
  repo TEXT NOT NULL COLLATE NOCASE,
  pr_number INTEGER NOT NULL,
  PRIMARY KEY (login, task_id, repo, pr_number)`

const QUEUE = `
  login TEXT NOT NULL,
  task_id TEXT NOT NULL,
  repo TEXT NOT NULL COLLATE NOCASE,
  pr_number INTEGER NOT NULL,
  kind TEXT NOT NULL,
  delivery_id TEXT NOT NULL,
  due_at INTEGER NOT NULL,
  PRIMARY KEY (login, task_id, repo, pr_number, kind)`

/** The table's stored `CREATE TABLE` statement, or null when it does not exist yet. */
const tableSql = (sql: PrWatchesSql, name: string): string | null =>
  sql.exec<{ sql: string }>("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?", name).toArray()[0]?.sql ?? null

const isCurrent = (statement: string | null, key: string): boolean =>
  statement !== null && statement.replace(/\s+/g, " ").includes(key)

/**
 * Creates both tables, or rebuilds one that predates a thread owning several pull requests: the old watch key had one
 * row per thread. Existing watches are kept as they are; a queued activity for a thread is kept too, and the next
 * activity after a watch was added is queued normally.
 */
export const ensurePrWatchTables = (sql: PrWatchesSql): void => {
  const watches = tableSql(sql, "pr_watches")
  if (watches !== null && !isCurrent(watches, "PRIMARY KEY (login, task_id, repo, pr_number)")) {
    sql.exec("ALTER TABLE pr_watches RENAME TO pr_watches_legacy")
    sql.exec(`CREATE TABLE pr_watches (${WATCHES})`)
    sql.exec("INSERT OR IGNORE INTO pr_watches (login, task_id, repo, pr_number) SELECT login, task_id, repo, pr_number FROM pr_watches_legacy")
    sql.exec("DROP TABLE pr_watches_legacy")
  }
  sql.exec(`CREATE TABLE IF NOT EXISTS pr_watches (${WATCHES})`)

  const queue = tableSql(sql, "pr_activity_queue")
  if (queue !== null && !isCurrent(queue, "PRIMARY KEY (login, task_id, repo, pr_number, kind)")) {
    sql.exec("ALTER TABLE pr_activity_queue RENAME TO pr_activity_queue_legacy")
    sql.exec(`CREATE TABLE pr_activity_queue (${QUEUE})`)
    sql.exec(
      "INSERT OR IGNORE INTO pr_activity_queue (login, task_id, repo, pr_number, kind, delivery_id, due_at) " +
        "SELECT login, task_id, repo, pr_number, kind, delivery_id, due_at FROM pr_activity_queue_legacy",
    )
    sql.exec("DROP TABLE pr_activity_queue_legacy")
  }
  sql.exec(`CREATE TABLE IF NOT EXISTS pr_activity_queue (${QUEUE})`)
}
