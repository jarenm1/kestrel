import { Database } from "bun:sqlite"
import { beforeEach, describe, expect, test } from "bun:test"
import { ensurePrWatchTables, type PrWatchesSql } from "./pr-watches-table"

let db: Database
let sql: PrWatchesSql

beforeEach(() => {
  db = new Database(":memory:")
  sql = {
    exec: (query, ...bindings) => {
      const rows = db.query(query).all(...bindings)
      return { toArray: () => rows as never }
    },
  }
})

const tables = (): string[] =>
  (db.query("SELECT name FROM sqlite_master WHERE type = 'table'").all() as { name: string }[]).map((t) => t.name)

describe("ensurePrWatchTables", () => {
  test("accepts several watches per thread and several queued activities per pull request", () => {
    ensurePrWatchTables(sql)
    db.run("INSERT INTO pr_watches (login, task_id, repo, pr_number) VALUES ('octo', 't1', 'acme/app', 12)")
    db.run("INSERT INTO pr_watches (login, task_id, repo, pr_number) VALUES ('octo', 't1', 'acme/other', 3)")
    db.run("INSERT INTO pr_activity_queue (login, task_id, repo, pr_number, kind, delivery_id, due_at) VALUES ('octo', 't1', 'acme/app', 12, 'review', 'd1', 1)")
    db.run("INSERT INTO pr_activity_queue (login, task_id, repo, pr_number, kind, delivery_id, due_at) VALUES ('octo', 't1', 'acme/app', 12, 'check', 'd2', 2)")
    expect(db.query("SELECT repo, pr_number AS number FROM pr_watches ORDER BY pr_number").all()).toEqual([
      { repo: "acme/other", number: 3 },
      { repo: "acme/app", number: 12 },
    ])
    expect(db.query("SELECT count(*) AS n FROM pr_activity_queue").get()).toEqual({ n: 2 })
  })

  test("rebuilds the one-watch-per-thread tables, keeping the watches and queued activity", () => {
    db.run(`CREATE TABLE pr_watches (
      login TEXT NOT NULL, task_id TEXT NOT NULL, repo TEXT NOT NULL COLLATE NOCASE, pr_number INTEGER NOT NULL,
      PRIMARY KEY (login, task_id))`)
    db.run(`CREATE TABLE pr_activity_queue (
      login TEXT NOT NULL, task_id TEXT NOT NULL, repo TEXT NOT NULL, pr_number INTEGER NOT NULL,
      kind TEXT NOT NULL, delivery_id TEXT NOT NULL, due_at INTEGER NOT NULL,
      PRIMARY KEY (login, task_id))`)
    db.run("INSERT INTO pr_watches VALUES ('octo', 't1', 'acme/app', 12)")
    db.run("INSERT INTO pr_activity_queue VALUES ('octo', 't1', 'acme/app', 12, 'review', 'd1', 7)")

    ensurePrWatchTables(sql)

    expect(tables()).not.toContain("pr_watches_legacy")
    expect(tables()).not.toContain("pr_activity_queue_legacy")
    expect(db.query("SELECT login, task_id AS taskId, repo, pr_number AS number FROM pr_watches").all()).toEqual([
      { login: "octo", taskId: "t1", repo: "acme/app", number: 12 },
    ])
    expect(db.query("SELECT login, task_id AS taskId, repo, pr_number AS number, kind, delivery_id AS deliveryId, due_at AS dueAt FROM pr_activity_queue").all()).toEqual([
      { login: "octo", taskId: "t1", repo: "acme/app", number: 12, kind: "review", deliveryId: "d1", dueAt: 7 },
    ])
    // After the rebuild, a second watch of the same thread is accepted.
    db.run("INSERT INTO pr_watches (login, task_id, repo, pr_number) VALUES ('octo', 't1', 'acme/other', 3)")
    expect(db.query("SELECT count(*) AS n FROM pr_watches").get()).toEqual({ n: 2 })
  })

  test("adds the retry counter to an existing queue without resetting it", () => {
    db.run(`CREATE TABLE pr_activity_queue (
      login TEXT NOT NULL, task_id TEXT NOT NULL, repo TEXT NOT NULL, pr_number INTEGER NOT NULL,
      kind TEXT NOT NULL, delivery_id TEXT NOT NULL, due_at INTEGER NOT NULL,
      PRIMARY KEY (login, task_id, repo, pr_number, kind))`)
    db.run("INSERT INTO pr_activity_queue VALUES ('octo', 't1', 'acme/app', 12, 'review', 'd1', 7)")
    ensurePrWatchTables(sql)
    expect(db.query("SELECT attempts FROM pr_activity_queue").get()).toEqual({ attempts: 0 })
    db.run("UPDATE pr_activity_queue SET attempts = 3")
    ensurePrWatchTables(sql)
    expect(db.query("SELECT attempts FROM pr_activity_queue").get()).toEqual({ attempts: 3 })
  })

  test("leaves the rebuilt tables alone on a later start", () => {
    ensurePrWatchTables(sql)
    db.run("INSERT INTO pr_watches (login, task_id, repo, pr_number) VALUES ('octo', 't1', 'acme/app', 12)")
    db.run("INSERT INTO pr_watches (login, task_id, repo, pr_number) VALUES ('octo', 't1', 'acme/other', 3)")
    ensurePrWatchTables(sql)
    expect(db.query("SELECT count(*) AS n FROM pr_watches").get()).toEqual({ n: 2 })
    expect(tables()).not.toContain("pr_watches_legacy")
  })
})
