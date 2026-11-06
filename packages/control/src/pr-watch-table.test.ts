import { Database } from "bun:sqlite"
import { beforeEach, expect, test } from "bun:test"
import type { HookSql } from "./hooks"
import { closeWatches, discardFailedActivity } from "./pr-watch-table"

let db: Database
let sql: HookSql
beforeEach(() => {
  db = new Database(":memory:")
  db.run("CREATE TABLE pr_watches (login TEXT, task_id TEXT, repo TEXT, pr_number INTEGER, PRIMARY KEY (login, task_id))")
  db.run("CREATE TABLE pr_activity_queue (login TEXT, task_id TEXT, repo TEXT, pr_number INTEGER, delivery_id TEXT, PRIMARY KEY (login, task_id))")
  db.run("CREATE TABLE pr_close_deliveries (delivery_id TEXT PRIMARY KEY, received_at INTEGER)")
  sql = { exec: (query, ...bindings) => {
    const rows = db.query(query).all(...bindings)
    return { toArray: () => rows as never }
  } }
})

test("close replay does not erase a later watch for the same PR", () => {
  db.run("INSERT INTO pr_watches VALUES ('alice', 'task', 'Owner/Repo', 12)")
  db.run("INSERT INTO pr_activity_queue VALUES ('alice', 'task', 'Owner/Repo', 12, 'activity')")
  expect(closeWatches(sql, "close", "owner/repo", 12, 100, 50)).toEqual(["alice"])
  expect(db.query("SELECT * FROM pr_activity_queue").all()).toEqual([])
  db.run("INSERT INTO pr_watches VALUES ('alice', 'task', 'Owner/Repo', 12)")
  expect(closeWatches(sql, "close", "owner/repo", 12, 101, 50)).toEqual([])
  expect(db.query("SELECT * FROM pr_watches").all()).toHaveLength(1)
})

test("an old failed activity preserves a replacement watch and event, including for the same PR", () => {
  const row = { login: "alice", taskId: "task", repo: "owner/repo", number: 12, deliveryId: "old" }
  db.run("INSERT INTO pr_watches VALUES ('alice', 'task', 'Owner/Repo', 12)")
  discardFailedActivity(sql, row)
  expect(db.query("SELECT * FROM pr_watches").all()).toHaveLength(1)
  db.run("INSERT INTO pr_activity_queue VALUES ('alice', 'task', 'Owner/Repo', 12, 'new')")
  discardFailedActivity(sql, row)
  expect(db.query("SELECT * FROM pr_watches").all()).toHaveLength(1)
  expect(db.query("SELECT * FROM pr_activity_queue").all()).toHaveLength(1)
  discardFailedActivity(sql, { ...row, deliveryId: "new" })
  expect(db.query("SELECT * FROM pr_watches").all()).toEqual([])
  expect(db.query("SELECT * FROM pr_activity_queue").all()).toEqual([])
})
