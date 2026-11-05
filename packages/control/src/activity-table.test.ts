import { Database } from "bun:sqlite"
import { beforeEach, describe, expect, test } from "bun:test"
import {
  ACTIVITY_STALE_AFTER_SECONDS,
  ACTIVITY_WINDOW_SECONDS,
  MAX_ACTIVITY_CLOCK_SKEW_SECONDS,
  type FleetActivity,
} from "@cloudagents/protocol"
import { deleteBoxActivity, ensureBoxActivityTable, fleetActivity, recordBoxActivity } from "./activity-table"
import { deleteFleetBox, ensureFleetTable, insertFleetBox, updateFleetBox, type FleetSql } from "./fleet-table"

const NOW = new Date("2026-11-04T12:00:00.000Z")
const at = (seconds: number): string => new Date(NOW.getTime() + seconds * 1000).toISOString()

let db: Database
let sql: FleetSql

const addBox = (id: string, createdAt: string, state: "active" | "draining" | "pending" = "active") => {
  insertFleetBox(sql, { id, name: id, url: `https://${id}.example.com`, secret: `${id}-secret`, createdAt })
  if (state !== "pending") updateFleetBox(sql, id, { state })
}

const addUser = (login: string, boxId: string | null) => {
  db.run("INSERT INTO users (login, name, avatar_url) VALUES (?, ?, '')", login, login)
  db.run("UPDATE users SET managed_box_id = ? WHERE login = ?", boxId, login)
}

const report = (...users: { login: string; lastActiveAt: string }[]) => ({ users })

const activityOf = (result: FleetActivity, boxId: string) => {
  const box = result.boxes.find((entry) => entry.boxId === boxId)
  if (box === undefined) throw new Error(`box ${boxId} missing from ${JSON.stringify(result)}`)
  return box
}

beforeEach(() => {
  db = new Database(":memory:")
  db.run("CREATE TABLE users (login TEXT PRIMARY KEY, name TEXT, avatar_url TEXT NOT NULL)")
  sql = {
    exec: (query, ...bindings) => {
      const rows = db.query(query).all(...bindings)
      return { toArray: () => rows as never[] }
    },
  }
  ensureFleetTable(sql)
  ensureBoxActivityTable(sql)
})

describe("box activity snapshots", () => {
  test("stores distinct assigned users with their latest sighting, newest first", () => {
    addBox("a", "2026-01-01T00:00:00Z")
    addUser("alice", "a")
    addUser("bob", "a")

    recordBoxActivity(sql, "a", report({ login: "alice", lastActiveAt: at(-60) }, { login: "bob", lastActiveAt: at(-120) }), NOW)
    recordBoxActivity(sql, "a", report({ login: "alice", lastActiveAt: at(-30) }, { login: "bob", lastActiveAt: at(-120) }), NOW)

    const activity = fleetActivity(sql, NOW)
    expect(activity.windowSeconds).toBe(ACTIVITY_WINDOW_SECONDS)
    expect(activity.staleAfterSeconds).toBe(ACTIVITY_STALE_AFTER_SECONDS)
    expect(activityOf(activity, "a")).toEqual({
      boxId: "a",
      receivedAt: NOW.toISOString(),
      users: [
        { login: "alice", lastActiveAt: at(-30) },
        { login: "bob", lastActiveAt: at(-120) },
      ],
    })
  })

  test("drops users at or outside the activity window", () => {
    addBox("a", "2026-01-01T00:00:00Z")
    addUser("edge", "a")
    addUser("old", "a")
    addUser("recent", "a")

    recordBoxActivity(
      sql,
      "a",
      report(
        { login: "edge", lastActiveAt: at(-ACTIVITY_WINDOW_SECONDS) },
        { login: "old", lastActiveAt: at(-ACTIVITY_WINDOW_SECONDS - 1) },
        { login: "recent", lastActiveAt: at(-1) },
      ),
      NOW,
    )

    expect(activityOf(fleetActivity(sql, NOW), "a").users.map((user) => user.login)).toEqual(["recent"])
  })

  test("an empty snapshot replaces every user of the previous one", () => {
    addBox("a", "2026-01-01T00:00:00Z")
    addUser("alice", "a")
    recordBoxActivity(sql, "a", report({ login: "alice", lastActiveAt: at(-10) }), NOW)
    expect(activityOf(fleetActivity(sql, NOW), "a").users).toHaveLength(1)

    recordBoxActivity(sql, "a", report(), new Date(NOW.getTime() + 30_000))
    expect(activityOf(fleetActivity(sql, new Date(NOW.getTime() + 30_000)), "a")).toEqual({
      boxId: "a",
      receivedAt: new Date(NOW.getTime() + 30_000).toISOString(),
      users: [],
    })
  })

  test("a stale snapshot keeps its timestamp but reports no users", () => {
    addBox("a", "2026-01-01T00:00:00Z")
    addUser("alice", "a")
    recordBoxActivity(sql, "a", report({ login: "alice", lastActiveAt: at(-10) }), NOW)

    const fresh = new Date(NOW.getTime() + ACTIVITY_STALE_AFTER_SECONDS * 1000 - 1)
    expect(activityOf(fleetActivity(sql, fresh), "a").users.map((user) => user.login)).toEqual(["alice"])

    const stale = new Date(NOW.getTime() + ACTIVITY_STALE_AFTER_SECONDS * 1000)
    expect(activityOf(fleetActivity(sql, stale), "a")).toEqual({
      boxId: "a",
      receivedAt: NOW.toISOString(),
      users: [],
    })
  })

  test("only users assigned to the reporting box can appear, and boxes are isolated", () => {
    addBox("a", "2026-01-01T00:00:00Z")
    addBox("b", "2026-01-02T00:00:00Z")
    addUser("alice", "a")
    addUser("bob", "b")
    addUser("unassigned", null)

    recordBoxActivity(
      sql,
      "a",
      report(
        { login: "alice", lastActiveAt: at(-10) },
        { login: "bob", lastActiveAt: at(-10) },
        { login: "unassigned", lastActiveAt: at(-10) },
        { login: "stranger", lastActiveAt: at(-10) },
      ),
      NOW,
    )
    recordBoxActivity(
      sql,
      "b",
      report({ login: "alice", lastActiveAt: at(-10) }, { login: "bob", lastActiveAt: at(-20) }),
      NOW,
    )

    const activity = fleetActivity(sql, NOW)
    expect(activityOf(activity, "a").users).toEqual([{ login: "alice", lastActiveAt: at(-10) }])
    expect(activityOf(activity, "b").users).toEqual([{ login: "bob", lastActiveAt: at(-20) }])
  })

  test("a user who moved boxes stops appearing on the old box before its next report", () => {
    addBox("a", "2026-01-01T00:00:00Z")
    addBox("b", "2026-01-02T00:00:00Z")
    addUser("alice", "a")
    recordBoxActivity(sql, "a", report({ login: "alice", lastActiveAt: at(-10) }), NOW)

    db.run("UPDATE users SET managed_box_id = 'b' WHERE login = 'alice'")
    expect(activityOf(fleetActivity(sql, NOW), "a").users).toEqual([])
    expect(activityOf(fleetActivity(sql, NOW), "b").users).toEqual([])
  })

  test("future timestamps are clamped within the skew allowance and dropped beyond it", () => {
    addBox("a", "2026-01-01T00:00:00Z")
    addUser("slightly-ahead", "a")
    addUser("far-ahead", "a")

    recordBoxActivity(
      sql,
      "a",
      report(
        { login: "slightly-ahead", lastActiveAt: at(MAX_ACTIVITY_CLOCK_SKEW_SECONDS) },
        { login: "far-ahead", lastActiveAt: at(MAX_ACTIVITY_CLOCK_SKEW_SECONDS + 1) },
      ),
      NOW,
    )

    expect(activityOf(fleetActivity(sql, NOW), "a").users).toEqual([
      { login: "slightly-ahead", lastActiveAt: NOW.toISOString() },
    ])
  })

  test("every registered box is listed, including one that never reported", () => {
    addBox("later", "2026-02-01T00:00:00Z", "draining")
    addBox("earlier", "2026-01-01T00:00:00Z", "pending")
    addUser("alice", "earlier")
    recordBoxActivity(sql, "earlier", report({ login: "alice", lastActiveAt: at(-10) }), NOW)

    expect(fleetActivity(sql, NOW).boxes).toEqual([
      { boxId: "earlier", receivedAt: NOW.toISOString(), users: [{ login: "alice", lastActiveAt: at(-10) }] },
      { boxId: "later", receivedAt: null, users: [] },
    ])
  })

  test("deleting a box's snapshot forgets it", () => {
    addBox("a", "2026-01-01T00:00:00Z")
    addUser("alice", "a")
    recordBoxActivity(sql, "a", report({ login: "alice", lastActiveAt: at(-10) }), NOW)
    deleteBoxActivity(sql, "a")
    expect(activityOf(fleetActivity(sql, NOW), "a")).toEqual({ boxId: "a", receivedAt: null, users: [] })
  })

  test("a deleted box is absent from the read even before its snapshot is cleared", () => {
    addBox("a", "2026-01-01T00:00:00Z")
    addUser("alice", "a")
    recordBoxActivity(sql, "a", report({ login: "alice", lastActiveAt: at(-10) }), NOW)
    expect(deleteFleetBox(sql, "a")).toBe(true)
    expect(fleetActivity(sql, NOW).boxes).toEqual([])
  })
})
