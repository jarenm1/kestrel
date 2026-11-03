import { Database } from "bun:sqlite"
import { beforeEach, describe, expect, mock, test } from "bun:test"
import { BOX_TOKEN_QUERY, CREDENTIALS_HEADER, ControlPaths, Paths } from "@cloudagents/protocol"
import { FILE_TOKEN_HEADER, type Env } from "./env"
import type { Hub as HubClass } from "./hub"

// The Worker and Hub import `cloudflare:workers`, so the mock must be registered before either module loads.
mock.module("cloudflare:workers", () => ({ DurableObject: class {} }))
const { Hub } = await import("./hub")
const worker = (await import("./index")).default

/** `Hub#relay` is private; tests replace it to see what would reach the box. */
type Relay = (request: Request, url: URL) => Promise<Response>

/** A Hub over in-memory SQLite, plus the database so a test can expire a token. */
const newHub = () => {
  const db = new Database(":memory:")
  const sql = {
    exec: (query: string, ...bindings: (string | number | null)[]) => {
      const rows = db.query(query).all(...bindings)
      return { toArray: () => rows as never[] }
    },
  }
  const ctx = {
    // The constructor's schema work is synchronous, so it finishes before the constructor returns.
    blockConcurrencyWhile: (work: () => Promise<void>) => work(),
    storage: { sql, transactionSync: <T>(work: () => T) => work() },
    getWebSockets: () => [],
  }
  const hub: HubClass = new Hub(ctx as unknown as DurableObjectState, {} as Env)
  // The mocked `DurableObject` base class does not keep its constructor arguments; the real one sets these.
  Object.assign(hub, { ctx, env: {} })
  return { hub, db }
}

const relayed: { path: string; headers: Headers }[] = []

const intercept = (hub: HubClass): HubClass => {
  const target = hub as unknown as { relay: Relay } // private member: swap it in tests
  target.relay = async (request, url) => {
    relayed.push({ path: url.pathname + url.search, headers: request.headers })
    return new Response("bytes")
  }
  return hub
}

const withToken = (path: string, token: string) => `https://hub${path}?${BOX_TOKEN_QUERY}=${token}`

beforeEach(() => {
  relayed.length = 0
})

describe("file token storage", () => {
  test("mints a token for a login that is valid for an hour", () => {
    const { hub } = newHub()
    const minted = hub.createFileToken("octocat")
    expect(minted.token).not.toBe("")
    const lifetime = Date.parse(minted.expiresAt) - Date.now()
    expect(lifetime).toBeGreaterThan(59 * 60 * 1000)
    expect(lifetime).toBeLessThanOrEqual(60 * 60 * 1000)
  })
})

describe("box files with a file token", () => {
  test("relays the three file paths with the token user's credentials, without the token or its query", async () => {
    const { hub } = newHub()
    intercept(hub)
    const { token } = hub.createFileToken("octocat")
    const paths = [
      Paths.taskAttachment("task-1", "attachment-1"),
      Paths.taskRunImage("task-1", "run-1", "image-1"),
      Paths.taskCheckoutIcon("task-1", "checkout-1", "blob-1"),
    ]
    for (const path of paths) {
      const response = await hub.fetch(
        new Request(withToken(path, token), { headers: { [FILE_TOKEN_HEADER]: token } }),
      )
      expect(response.status).toBe(200)
    }
    expect(relayed.map((call) => call.path)).toEqual(paths)
    for (const call of relayed) {
      expect(call.headers.get(FILE_TOKEN_HEADER)).toBeNull()
      expect(call.headers.get("cookie")).toBeNull()
      expect(JSON.parse(call.headers.get(CREDENTIALS_HEADER) ?? "{}")).toEqual({ user: "octocat" })
    }
  })

  test("refuses other paths, other methods, and unknown or expired tokens", async () => {
    const { hub, db } = newHub()
    intercept(hub)
    const send = (path: string, init: RequestInit = {}, credential = hub.createFileToken("octocat").token) =>
      hub.fetch(new Request(withToken(path, credential), { ...init, headers: { [FILE_TOKEN_HEADER]: credential } }))

    expect((await send(Paths.taskMessages("task-1"))).status).toBe(401)
    expect((await send(ControlPaths.fileToken)).status).toBe(401)
    expect((await send(Paths.taskAttachment("task-1", "attachment-1"), { method: "POST" })).status).toBe(401)
    expect((await send(Paths.taskAttachment("task-1", "attachment-1"), {}, "not-a-token")).status).toBe(401)
    expect(relayed).toHaveLength(0)

    // A token lapses an hour after it was minted.
    const short = hub.createFileToken("octocat")
    db.run("UPDATE file_tokens SET expires_at = ? WHERE token = ?", Date.now() - 1, short.token)
    expect((await send(Paths.taskAttachment("task-1", "attachment-1"), {}, short.token)).status).toBe(401)
    expect(relayed).toHaveLength(0)
  })
})

describe("POST /api/file-token", () => {
  const minted: string[] = []
  const forwarded: { path: string; headers: Headers }[] = []
  const stub = {
    // Durable Object RPC: every call resolves asynchronously, as on Cloudflare.
    session: async (id: string) => (id === "session-user" ? { login: "octocat", dev: false } : null),
    createFileToken: async (login: string) => {
      minted.push(login)
      return { token: "file-token", expiresAt: "2026-11-03T01:00:00.000Z" }
    },
    fetch: async (request: Request) => {
      const url = new URL(request.url)
      forwarded.push({ path: url.pathname + url.search, headers: request.headers })
      return new Response("bytes")
    },
  }
  const env = { HUB: { idFromName: () => "main", get: () => stub } } as unknown as Env
  const request = (path: string, init?: RequestInit) => worker.fetch(new Request(`https://app.example${path}`, init), env)

  test("mints for the signed-in user only", async () => {
    minted.length = 0
    expect((await request(ControlPaths.fileToken, { method: "POST" })).status).toBe(401)
    expect(minted).toHaveLength(0)
    const response = await request(ControlPaths.fileToken, {
      method: "POST",
      headers: { cookie: "session=session-user" },
    })
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ token: "file-token", expiresAt: "2026-11-03T01:00:00.000Z" })
    expect(minted).toEqual(["octocat"])
  })

  test("accepts the token only on GET box files, and strips it before relaying", async () => {
    forwarded.length = 0
    const file = Paths.taskAttachment("task-1", "attachment-1")
    const response = await request(`${file}?${BOX_TOKEN_QUERY}=file-token`)
    expect(response.status).toBe(200)
    expect(forwarded).toHaveLength(1)
    expect(forwarded[0]?.path).toBe(file)
    expect(forwarded[0]?.headers.get(FILE_TOKEN_HEADER)).toBe("file-token")
    expect(forwarded[0]?.headers.get("cookie")).toBeNull()

    // Nothing else the relay serves takes a file token in place of the session.
    expect((await request(`${Paths.taskMessages("task-1")}?${BOX_TOKEN_QUERY}=file-token`)).status).toBe(401)
    expect(
      (await request(`${Paths.taskRunImage("task-1", "run-1", "image-1")}?${BOX_TOKEN_QUERY}=file-token`, { method: "POST" }))
        .status,
    ).toBe(401)
    expect(forwarded).toHaveLength(1)
  })
})
