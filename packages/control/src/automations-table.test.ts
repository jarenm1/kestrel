import { Database } from "bun:sqlite"
import { beforeEach, describe, expect, test } from "bun:test"
import { ensureAutomationsTable, type AutomationsSql } from "./automations-table"

let db: Database
let sql: AutomationsSql

const columns = (): string[] =>
  (db.query("SELECT name FROM pragma_table_info('automations')").all() as { name: string }[]).map((c) => c.name)

const tables = (): string[] =>
  (db.query("SELECT name FROM sqlite_master WHERE type = 'table'").all() as { name: string }[]).map((t) => t.name)

beforeEach(() => {
  db = new Database(":memory:")
  sql = {
    exec: (query, ...bindings) => {
      const rows = db.query(query).all(...bindings)
      return { toArray: () => rows as never }
    },
  }
})

describe("ensureAutomationsTable", () => {
  test("creates the table on a fresh database and accepts repository-less rows", () => {
    ensureAutomationsTable(sql)
    expect(columns()).not.toContain("repo_id")
    db.run(
      `INSERT INTO automations (id, login, name, repo, prompt, enabled, trigger_json, next_run_at, created_at, updated_at)
       VALUES ('a1', 'octo', 'Daily', NULL, 'Do it', 1, '{}', NULL, 'now', 'now')`,
    )
    expect(db.query("SELECT repo FROM automations WHERE id = 'a1'").get()).toEqual({ repo: null })
  })

  test("rebuilds a legacy table without repo_id, keeping every row", () => {
    db.run(`CREATE TABLE automations (
      id TEXT PRIMARY KEY, login TEXT NOT NULL, name TEXT NOT NULL, repo_id TEXT NOT NULL, repo TEXT,
      prompt TEXT NOT NULL, enabled INTEGER NOT NULL, trigger_json TEXT NOT NULL, next_run_at INTEGER,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL)`)
    db.run(`INSERT INTO automations VALUES
      ('a1', 'octo', 'Reviews', '123', 'acme/app', 'Review', 1, '{"_tag":"github"}', NULL, 'c1', 'u1'),
      ('a2', 'octo', 'Daily', '456', NULL, 'Summarize', 0, '{"_tag":"schedule"}', 1700000000000, 'c2', 'u2')`)

    ensureAutomationsTable(sql)

    expect(columns()).not.toContain("repo_id")
    expect(tables()).not.toContain("automations_legacy")
    expect(db.query("SELECT id, repo, next_run_at AS nextRunAt FROM automations ORDER BY id").all()).toEqual([
      { id: "a1", repo: "acme/app", nextRunAt: null },
      { id: "a2", repo: null, nextRunAt: 1700000000000 },
    ])
  })

  test("is a no-op once the table is current", () => {
    ensureAutomationsTable(sql)
    db.run(
      `INSERT INTO automations (id, login, name, repo, prompt, enabled, trigger_json, next_run_at, created_at, updated_at)
       VALUES ('a1', 'octo', 'Daily', NULL, 'Do it', 1, '{}', NULL, 'now', 'now')`,
    )
    ensureAutomationsTable(sql)
    expect(db.query("SELECT COUNT(*) AS n FROM automations").get()).toEqual({ n: 1 })
  })
})
