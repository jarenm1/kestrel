import { Database } from "bun:sqlite"
import { afterEach, describe, expect, mock, setSystemTime, test } from "bun:test"
import { BOX_ID_HEADER, BOX_TURN_PATH } from "@cloudagents/protocol"
import type { Env } from "./env"
import { insertFleetBox, type FleetSql } from "./fleet-table"
import type { Hub as HubClass } from "./hub"

// The Worker and Hub import `cloudflare:workers`, so the mock must be registered before either module loads. A static
// import cannot be ordered after `mock.module`, which is why the adapter is loaded dynamically.
mock.module("cloudflare:workers", () => ({ DurableObject: class {} }))
const { Hub } = await import("./hub")
const worker = (await import("./index")).default

const ICE_SERVERS = [
  {
    urls: ["turns:turn.cloudflare.com:443?transport=tcp"],
    username: "turn-user",
    credential: "turn-credential",
  },
]

const newHub = () => {
  const db = new Database(":memory:")
  const sql: FleetSql = {
    exec: (query, ...bindings) => {
      const rows = db.query(query).all(...bindings)
      return { toArray: () => rows as never }
    },
  }
  const ctx = {
    blockConcurrencyWhile: (work: () => Promise<void>) => work(),
    storage: {
      sql,
      transactionSync: <T>(work: () => T) => work(),
      setAlarm: async () => {},
      deleteAlarm: async () => {},
    },
    getWebSockets: () => [],
    waitUntil: () => {},
  }
  const vars = {
    ALLOWED_GITHUB_LOGINS: "octocat",
    KESTREL_TURN_KEY_ID: "turn-key",
    KESTREL_TURN_API_TOKEN: "provider-token",
  } as unknown as Env
  const hub: HubClass = new Hub(ctx as unknown as DurableObjectState, vars)
  const env = { ...vars, HUB: { idFromName: () => "main", get: () => hub } } as unknown as Env
  Object.assign(hub, { ctx, env })
  return { hub, env, sql }
}

const calls: string[] = []
const realFetch = globalThis.fetch

afterEach(() => {
  globalThis.fetch = realFetch
  calls.length = 0
  setSystemTime()
})

const send = (id: string, secret: string, env: Env): Promise<Response> =>
  worker.fetch(
    new Request(`https://app.example${BOX_TURN_PATH}`, {
      method: "POST",
      headers: { authorization: `Bearer ${secret}`, [BOX_ID_HEADER]: id },
    }),
    env,
  )

const credentials = (): Promise<Response> =>
  Promise.resolve(
    Response.json({
      iceServers: ICE_SERVERS.map((server) => ({ ...server, urls: [...server.urls] })),
    }),
  )

describe("TURN cache invalidation for the managed fleet", () => {
  test("rotating a fleet secret and deleting the box both evict the cached identity", async () => {
    setSystemTime(new Date("2026-04-01T00:00:00.000Z"))
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      calls.push(String(input))
      return credentials()
    }) as typeof fetch
    const { hub, env, sql } = newHub()
    const created = hub.createFleetBox({ name: "box", url: "https://box.example" })

    expect((await send(created.box.id, created.secret, env)).status).toBe(200)
    expect(calls).toHaveLength(1)
    // Warmed: no second provider call while the identity is unchanged.
    expect((await send(created.box.id, created.secret, env)).status).toBe(200)
    expect(calls).toHaveLength(1)

    const rotated = hub.rotateFleetSecret(created.box.id)
    expect(rotated).not.toBeNull()
    // The old secret no longer authenticates, and the new identity asks the provider again.
    expect((await send(created.box.id, created.secret, env)).status).toBe(401)
    expect((await send(created.box.id, rotated!.secret, env)).status).toBe(200)
    expect(calls).toHaveLength(2)

    expect((await send(created.box.id, rotated!.secret, env)).status).toBe(200)
    expect(calls).toHaveLength(2)
    expect(hub.removeFleetBox(created.box.id)).toBe(true)

    // Reusing the id with the same secret must not read credentials cached for the deleted identity.
    insertFleetBox(sql, {
      id: created.box.id,
      name: "box",
      url: "https://box.example",
      secret: rotated!.secret,
      createdAt: new Date().toISOString(),
    })
    expect((await send(created.box.id, rotated!.secret, env)).status).toBe(200)
    expect(calls).toHaveLength(3)
  })

  test("rotating or deleting a user's own box also misses the Worker cache", async () => {
    setSystemTime(new Date("2026-04-02T00:00:00.000Z"))
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      calls.push(String(input))
      return credentials()
    }) as typeof fetch
    const { hub, env, sql } = newHub()
    const session = "session-own"
    hub.createSession(session, "octocat", Date.now() + 60 * 60 * 1000, false)
    const created = hub.createBox(session, { name: "own", url: "https://own.example" })
    if (!created.ok) throw new Error("box was not created")

    expect((await send(created.value.box.id, created.value.secret, env)).status).toBe(200)
    expect((await send(created.value.box.id, created.value.secret, env)).status).toBe(200)
    expect(calls).toHaveLength(1)

    const rotated = hub.rotateBoxSecret(session, created.value.box.id)
    if (!rotated.ok) throw new Error("secret was not rotated")
    expect((await send(created.value.box.id, created.value.secret, env)).status).toBe(401)
    expect((await send(created.value.box.id, rotated.value.secret, env)).status).toBe(200)
    expect(calls).toHaveLength(2)

    expect((await send(created.value.box.id, rotated.value.secret, env)).status).toBe(200)
    expect(calls).toHaveLength(2)
    expect((await hub.deleteBox(session, created.value.box.id)).ok).toBe(true)

    // Reusing the id and secret must not read credentials cached for the deleted identity.
    sql.exec(
      "INSERT INTO user_boxes (id, login, name, url, secret, created_at) VALUES (?, ?, ?, ?, ?, ?)",
      created.value.box.id,
      "octocat",
      "own",
      "https://own.example",
      rotated.value.secret,
      new Date().toISOString(),
    )
    expect((await send(created.value.box.id, rotated.value.secret, env)).status).toBe(200)
    expect(calls).toHaveLength(3)
  })
})
