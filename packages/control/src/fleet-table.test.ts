import { Database } from "bun:sqlite"
import { beforeEach, describe, expect, test } from "bun:test"
import {
  deleteFleetBox,
  ensureFleetTable,
  insertFleetBox,
  listFleetBoxes,
  managedBoxAccess,
  managedBoxFor,
  rotateFleetBoxSecret,
  updateFleetBox,
  type FleetSql,
} from "./fleet-table"

let db: Database
let sql: FleetSql

const addBox = (id: string, createdAt: string, state: "active" | "draining" | "pending" = "active", secret = `${id}-secret`) => {
  insertFleetBox(sql, { id, name: id, url: `https://${id}.example.com`, secret, createdAt })
  if (state !== "pending") updateFleetBox(sql, id, { state })
}

const addUser = (login: string) => {
  db.run("INSERT INTO users (login, name, avatar_url) VALUES (?, ?, '')", login, login)
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
})

describe("managed box assignment", () => {
  test("assigns a new user to the active box with the fewest users", () => {
    addBox("a", "2026-01-01T00:00:00Z")
    addBox("b", "2026-01-02T00:00:00Z")
    addUser("u1")
    expect(managedBoxFor(sql, "u1")?.id).toBe("a")
    addUser("u2")
    expect(managedBoxFor(sql, "u2")?.id).toBe("b")
  })

  test("breaks ties by oldest created_at", () => {
    addBox("newer", "2026-02-01T00:00:00Z")
    addBox("older", "2026-01-01T00:00:00Z")
    addUser("u1")
    expect(managedBoxFor(sql, "u1")?.id).toBe("older")
  })

  test("keeps the current assignment while its box is active, even when another box has fewer users", () => {
    addBox("a", "2026-01-01T00:00:00Z")
    addUser("u1")
    expect(managedBoxFor(sql, "u1")?.id).toBe("a")
    addBox("b", "2026-01-02T00:00:00Z")
    expect(managedBoxFor(sql, "u1")?.id).toBe("a")
  })

  test("pending boxes never receive users", () => {
    addBox("pending", "2026-01-01T00:00:00Z", "pending")
    addUser("u1")
    expect(managedBoxFor(sql, "u1")).toBeNull()
    expect(listFleetBoxes(sql)[0]?.users).toBe(0)
  })

  test("draining boxes keep their users but receive no new ones", () => {
    addBox("a", "2026-01-01T00:00:00Z")
    addUser("u1")
    expect(managedBoxFor(sql, "u1")?.id).toBe("a")
    updateFleetBox(sql, "a", { state: "draining" })
    addBox("b", "2026-01-02T00:00:00Z")
    addUser("u2")
    expect(managedBoxFor(sql, "u1")?.id).toBe("a")
    expect(managedBoxFor(sql, "u2")?.id).toBe("b")
  })

  test("a user with no active box is unassigned", () => {
    addUser("u1")
    expect(managedBoxFor(sql, "u1")).toBeNull()
  })

  test("deleting a box unassigns its users, who move to another active box on next lookup", () => {
    addBox("a", "2026-01-01T00:00:00Z")
    addBox("b", "2026-01-02T00:00:00Z")
    addUser("u1")
    expect(managedBoxFor(sql, "u1")?.id).toBe("a")
    expect(deleteFleetBox(sql, "a")).toBe(true)
    expect(managedBoxFor(sql, "u1")?.id).toBe("b")
    expect(deleteFleetBox(sql, "missing")).toBe(false)
  })
})

describe("managed box access", () => {
  test("requires the box's secret and an assignment to that box", async () => {
    addBox("a", "2026-01-01T00:00:00Z", "active", "secret-a")
    addBox("b", "2026-01-02T00:00:00Z", "active", "secret-b")
    addUser("u1")
    managedBoxFor(sql, "u1")

    expect(await managedBoxAccess(sql, "a", "secret-a", "u1")).toBe("granted")
    expect(await managedBoxAccess(sql, "a", "wrong", "u1")).toBe("unauthenticated")
    expect(await managedBoxAccess(sql, "a", "secret-b", "u1")).toBe("unauthenticated")
    expect(await managedBoxAccess(sql, "missing", "secret-a", "u1")).toBe("unauthenticated")
    expect(await managedBoxAccess(sql, "b", "secret-b", "u1")).toBe("unassigned")
    expect(await managedBoxAccess(sql, "a", "secret-a", "nobody")).toBe("unassigned")
  })

  test("a rotated secret stops authenticating the old one", async () => {
    addBox("a", "2026-01-01T00:00:00Z", "active", "old")
    addUser("u1")
    managedBoxFor(sql, "u1")
    expect(rotateFleetBoxSecret(sql, "a", "new")).toBe(true)
    expect(await managedBoxAccess(sql, "a", "old", "u1")).toBe("unauthenticated")
    expect(await managedBoxAccess(sql, "a", "new", "u1")).toBe("granted")
  })
})
