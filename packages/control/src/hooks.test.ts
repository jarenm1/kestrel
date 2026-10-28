import { Database } from "bun:sqlite"
import { beforeEach, describe, expect, test } from "bun:test"
import { claimHookRow, type HookSql } from "./hooks"

const REPO = "acme/app"

let db: Database
let sql: HookSql

beforeEach(() => {
  db = new Database(":memory:")
  db.run(`CREATE TABLE github_hooks (repo TEXT PRIMARY KEY, hook_id INTEGER NOT NULL, secret TEXT NOT NULL)`)
  sql = {
    exec: (query, ...bindings) => {
      const rows = db.query(query).all(...bindings)
      return { toArray: () => rows as never }
    },
  }
})

describe("claimHookRow", () => {
  test("stores the hook when none exists", () => {
    expect(claimHookRow(sql, REPO, null, 1, "s1")).toEqual({ hookId: 1, secret: "s1" })
  })

  test("a second creator with no expectation loses to the stored hook", () => {
    claimHookRow(sql, REPO, null, 1, "s1")
    expect(claimHookRow(sql, REPO, null, 2, "s2")).toEqual({ hookId: 1, secret: "s1" })
  })

  test("replaces a stale hook only while it is still the expected one", () => {
    claimHookRow(sql, REPO, null, 1, "s1")
    expect(claimHookRow(sql, REPO, 1, 3, "s3")).toEqual({ hookId: 3, secret: "s3" })
    expect(claimHookRow(sql, REPO, 1, 4, "s4")).toEqual({ hookId: 3, secret: "s3" })
  })
})
