import { Database } from "bun:sqlite"
import { beforeEach, describe, expect, test } from "bun:test"
import type { FleetSql } from "./fleet-table"
import { ensureWaitlistTable, storeWaitlistSignup } from "./waitlist-table"

let sql: FleetSql

beforeEach(() => {
  const db = new Database(":memory:")
  sql = {
    exec: (query, ...bindings) => {
      const rows = db.query(query).all(...bindings)
      return { toArray: () => rows as never[] }
    },
  }
  ensureWaitlistTable(sql)
})

describe("waitlist signups", () => {
  test("stores a normalized email once and keeps the first timestamp", () => {
    const first = new Date("2026-11-08T12:00:00.000Z")
    const second = new Date("2026-11-08T12:05:00.000Z")

    expect(storeWaitlistSignup(sql, "  Person@Example.COM ", first)).toEqual({
      email: "person@example.com",
      createdAt: first.toISOString(),
      created: true,
    })
    expect(storeWaitlistSignup(sql, "person@example.com", second)).toEqual({
      email: "person@example.com",
      createdAt: first.toISOString(),
      created: false,
    })
  })
})
