/**
 * The `automation_fires` table in the Hub: one durable intent per external automation start.
 *
 * A row is written before the box is called, so a crash either retries the intent or can see that it may have run.
 * `(automation_id, fire_key)` is the idempotency key: a schedule uses the scheduled instant, a webhook uses its
 * delivery id, and a manual run uses a fresh id. Kept apart from the Hub class so the schema can be exercised against
 * a plain SQLite database.
 */

/** The slice of `SqlStorage` the automation fires table needs. */
export interface AutomationFiresSql {
  exec<T extends Record<string, string | number | null>>(
    query: string,
    ...bindings: (string | number | null)[]
  ): { toArray(): T[] }
}

const COLUMNS = `
  id TEXT PRIMARY KEY,
  automation_id TEXT NOT NULL,
  fire_key TEXT NOT NULL,
  reason TEXT NOT NULL,
  pr_json TEXT,
  claimed_at INTEGER NOT NULL,
  started_at INTEGER,
  attempts INTEGER NOT NULL DEFAULT 0,
  outcome TEXT,
  task_id TEXT,
  error TEXT,
  UNIQUE (automation_id, fire_key)`

/** A fire intent; `outcome` is null until the box call settled. */
export type AutomationFireRow = {
  readonly id: string
  readonly automationId: string
  readonly fireKey: string
  readonly reason: string
  readonly prJson: string | null
  readonly claimedAt: number
  readonly startedAt: number | null
  readonly attempts: number
  readonly outcome: "started" | "failed" | null
  readonly taskId: string | null
  readonly error: string | null
}

export const AUTOMATION_FIRE_COLUMNS =
  "id, automation_id AS automationId, fire_key AS fireKey, reason, pr_json AS prJson, " +
  "claimed_at AS claimedAt, started_at AS startedAt, attempts, outcome, task_id AS taskId, error"

export const ensureAutomationFiresTable = (sql: AutomationFiresSql): void => {
  sql.exec(`CREATE TABLE IF NOT EXISTS automation_fires (${COLUMNS})`)
}
