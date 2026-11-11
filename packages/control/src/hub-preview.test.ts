import { Database } from "bun:sqlite"
import { describe, expect, mock, spyOn, test } from "bun:test"
import { MAX_USER_BOXES } from "@cloudagents/protocol"
import type { Env } from "./env"
import type { Hub as HubClass } from "./hub"

// The Worker and Hub import `cloudflare:workers`, so the mock must be registered before either module loads.
mock.module("cloudflare:workers", () => ({ DurableObject: class {} }))
const { Hub } = await import("./hub")

/** A Hub over in-memory SQLite, its database, and the env used by Nest preview checks. */
const newHub = (vars: Partial<Env> = {}) => {
  const db = new Database(":memory:")
  const sql = {
    exec: (query: string, ...bindings: (string | number | null)[]) => {
      const rows = db.query(query).all(...bindings)
      return { toArray: () => rows as never[] }
    },
  }
  const ctx = {
    blockConcurrencyWhile: (work: () => Promise<void>) => work(),
    storage: { sql, transactionSync: <T>(work: () => T) => work() },
    getWebSockets: () => [],
  }
  const env = { KESTREL_NEST_DOMAIN: "nest.example.com", ALLOWED_GITHUB_LOGINS: "octocat", ...vars } as unknown as Env
  const hub: HubClass = new Hub(ctx as unknown as DurableObjectState, env)
  Object.assign(hub, { ctx, env })
  return { hub, db }
}

const signIn = (hub: HubClass, login = "octocat"): string => {
  const id = `session-${login}`
  hub.createSession(id, login, Date.now() + 60 * 60 * 1000, false)
  return id
}

const boxCount = (db: Database, login?: string): { n: number } =>
  (login === undefined
    ? db.query("SELECT COUNT(*) AS n FROM user_boxes").get()
    : db.query("SELECT COUNT(*) AS n FROM user_boxes WHERE login = ?").get(login)) as { n: number }

describe("previewNestBox", () => {
  test("a box-limit preview reports the limit without inserting a row", () => {
    const { hub, db } = newHub()
    const session = signIn(hub)
    const insert = db.query(
      "INSERT INTO user_boxes (id, login, name, url, secret, created_at) VALUES (?, ?, ?, ?, ?, ?)",
    )
    for (let i = 0; i < MAX_USER_BOXES; i += 1) {
      insert.run(`box-${i}`, "octocat", `box-${i}`, `https://box-${i}.nest.example.com`, "secret", new Date().toISOString())
    }
    const before = boxCount(db, "octocat")
    const result = hub.previewNestBox(session, { name: "preview" })
    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error("preview failed")
    expect(result.value.available).toBe(false)
    expect(result.value.reason).toContain(`at most ${MAX_USER_BOXES} boxes per user`)
    expect(boxCount(db, "octocat")).toEqual(before)
  })

  test("a no-capacity preview inserts nothing and reserves no host", () => {
    const { hub, db } = newHub()
    const session = signIn(hub)
    /** `Hub#nest` is private; this test-only view names the exact method it spies on. */
    const nestAccess = hub as unknown as { readonly nest: { readonly createBox: (...args: unknown[]) => void } }
    const createBox = spyOn(nestAccess.nest, "createBox")
    const before = boxCount(db)
    const result = hub.previewNestBox(session, { name: "preview" })
    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error("preview failed")
    expect(result.value.available).toBe(false)
    expect(result.value.reason).toContain("no Nest host has room for a new box")
    expect(createBox).not.toHaveBeenCalled()
    expect(boxCount(db)).toEqual(before)
  })
})
