import { Database } from "bun:sqlite"
import { beforeEach, describe, expect, test } from "bun:test"
import type { FleetSql } from "./fleet-table"
import { commonToolFailures, ensureToolFailuresTable, recordToolFailures } from "./tool-failures-table"

const failure = (signature: string, count = 1, tool = "Bash") => ({ tool, signature, count })
const NOV_2 = new Date("2026-11-02T12:00:00Z")
const NOV_3 = new Date("2026-11-03T12:00:00Z")

let sql: FleetSql

beforeEach(() => {
  const db = new Database(":memory:")
  sql = {
    exec: (query, ...bindings) => {
      const rows = db.query(query).all(...bindings)
      return { toArray: () => rows as never[] }
    },
  }
  ensureToolFailuresTable(sql)
})

describe("tool failure counts", () => {
  test("adds up across reports and days, most common first", () => {
    recordToolFailures(sql, [failure("a", 2), failure("b", 1)], NOV_2)
    recordToolFailures(sql, [failure("b", 4)], NOV_2)
    recordToolFailures(sql, [failure("a", 1), failure("a", 1, "Read")], NOV_3)
    expect(commonToolFailures(sql, 30, NOV_3)).toEqual([
      { tool: "Bash", signature: "b", count: 5, firstSeen: "2026-11-02", lastSeen: "2026-11-02" },
      { tool: "Bash", signature: "a", count: 3, firstSeen: "2026-11-02", lastSeen: "2026-11-03" },
      { tool: "Read", signature: "a", count: 1, firstSeen: "2026-11-03", lastSeen: "2026-11-03" },
    ])
  })

  test("a window of one day holds only today", () => {
    recordToolFailures(sql, [failure("old")], NOV_2)
    recordToolFailures(sql, [failure("new")], NOV_3)
    expect(commonToolFailures(sql, 1, NOV_3).map((f) => f.signature)).toEqual(["new"])
  })

  test("days past the retention are forgotten at the next report", () => {
    recordToolFailures(sql, [failure("old")], NOV_2)
    recordToolFailures(sql, [failure("new")], new Date("2027-02-01T12:00:00Z"))
    expect(commonToolFailures(sql, 90, new Date("2027-02-01T12:00:00Z")).map((f) => f.signature)).toEqual(["new"])
  })

  test("a full day drops new signatures and keeps counting known ones", () => {
    recordToolFailures(sql, Array.from({ length: 5000 }, (_, i) => failure(`s${i}`)), NOV_2)
    recordToolFailures(sql, [failure("s0"), failure("over")], NOV_2)
    const listed = commonToolFailures(sql, 1, NOV_2)
    expect(listed[0]).toMatchObject({ signature: "s0", count: 2 })
    expect(listed.some((f) => f.signature === "over")).toBe(false)
  })
})
