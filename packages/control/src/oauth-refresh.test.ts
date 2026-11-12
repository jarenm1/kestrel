import { Database } from "bun:sqlite"
import { afterEach, describe, expect, mock, setSystemTime, spyOn, test } from "bun:test"
import type { Env } from "./env"
import type { Hub as HubClass } from "./hub"
import { REFRESH_MARGIN_MS, REFRESH_RETRY_MS, exchangeCode } from "./oauth-tokens"
import { PROVIDERS, type OAuthProvider } from "./providers"

// The Hub imports `cloudflare:workers`, so the mock must be registered before it loads; a static import would load first.
mock.module("cloudflare:workers", () => ({ DurableObject: class {} }))
const { Hub } = await import("./hub")

const START = Date.parse("2026-01-01T00:00:00.000Z")
const HOUR = 60 * 60 * 1000
const EIGHT_HOURS = 8 * HOUR
const SIX_MONTHS = 15_897_600 * 1000
const github = PROVIDERS.find((p): p is OAuthProvider => p.id === "github")!
const client = { clientId: "id", clientSecret: "secret" }

const newHub = () => {
  const db = new Database(":memory:")
  const alarms: number[] = []
  const sql = {
    exec: (query: string, ...bindings: (string | number | null)[]) => {
      const rows = db.query(query).all(...bindings)
      return { toArray: () => rows as never[] }
    },
  }
  const ctx = {
    blockConcurrencyWhile: (work: () => Promise<void>) => work(),
    storage: {
      sql,
      transactionSync: <T>(work: () => T) => work(),
      setAlarm: async (at: number) => {
        alarms.push(at)
      },
      deleteAlarm: async () => {},
    },
    getWebSockets: () => [],
    waitUntil: () => {},
  }
  const env = { ALLOWED_GITHUB_LOGINS: "octocat", GITHUB_CLIENT_ID: "id", GITHUB_CLIENT_SECRET: "secret" } as unknown as Env
  const hub: HubClass = new Hub(ctx as unknown as DurableObjectState, env)
  Object.assign(hub, { ctx, env })
  return { hub, db, alarms }
}

/** GitHub's token endpoint answer for an expiring GitHub App user token. */
const granted = (access: string, refresh: string) =>
  Response.json({
    access_token: access,
    expires_in: EIGHT_HOURS / 1000,
    refresh_token: refresh,
    refresh_token_expires_in: SIX_MONTHS / 1000,
    token_type: "bearer",
  })

/** Records each refresh token sent to the token endpoint and answers with `answer`. */
const tokenEndpoint = (answer: (refreshToken: string) => Response | Promise<Response>) => {
  const spent: string[] = []
  spyOn(globalThis, "fetch").mockImplementation((async (_input: string | URL | Request, init?: RequestInit) => {
    const params = new URLSearchParams(String(init?.body))
    expect(params.get("grant_type")).toBe("refresh_token")
    const token = params.get("refresh_token")!
    spent.push(token)
    return answer(token)
  }) as typeof fetch)
  return spent
}

/** Connects GitHub as the OAuth callback does, from a code exchange answered with an expiring token. */
const connect = async (hub: HubClass, access: string, refresh: string) => {
  const exchange = spyOn(globalThis, "fetch").mockImplementation((async () => granted(access, refresh)) as typeof fetch)
  const grant = await exchangeCode(github, client, "code", "https://app.example/auth/github/callback")
  exchange.mockRestore()
  await hub.putConnection("octocat", "github", grant.accessToken, "octocat", grant.refresh)
}

const refreshColumns = (db: Database) =>
  db.query("SELECT refresh_secret AS secret, refresh_at AS at FROM connections WHERE login = 'octocat'").get() as {
    secret: string | null
    at: number | null
  }

afterEach(() => {
  setSystemTime()
  mock.restore()
})

describe("expiring GitHub tokens", () => {
  test("are refreshed before they expire, rotating the refresh token, and keep refreshing", async () => {
    setSystemTime(new Date(START))
    const { hub, alarms } = newHub()
    await connect(hub, "ghu_first", "ghr_first")
    const due = START + EIGHT_HOURS - REFRESH_MARGIN_MS
    expect(alarms.at(-1)).toBe(due)

    let n = 0
    const spent = tokenEndpoint(() => {
      n += 1
      return granted(`ghu_${n + 1}`, `ghr_${n + 1}`)
    })
    // An alarm before the refresh is due leaves the token alone.
    setSystemTime(new Date(due - 1))
    await hub.alarm()
    expect(spent).toEqual([])

    setSystemTime(new Date(due))
    await hub.alarm()
    expect(hub.credentials("octocat").github).toBe("ghu_2")
    const next = due + EIGHT_HOURS - REFRESH_MARGIN_MS
    expect(alarms.at(-1)).toBe(next)

    // The next refresh spends the rotated refresh token, not the first one.
    setSystemTime(new Date(next))
    await hub.alarm()
    expect(spent).toEqual(["ghr_first", "ghr_2"])
    expect(hub.credentials("octocat").github).toBe("ghu_3")
  })

  test("a refused refresh token stops refreshing and leaves the token for the reconnect check", async () => {
    setSystemTime(new Date(START))
    const { hub, db } = newHub()
    await connect(hub, "ghu_first", "ghr_first")
    const spent = tokenEndpoint(() => Response.json({ error: "bad_refresh_token" }))
    setSystemTime(new Date(START + EIGHT_HOURS))
    await hub.alarm()
    expect(refreshColumns(db)).toEqual({ secret: null, at: null })
    expect(hub.credentials("octocat").github).toBe("ghu_first")
    await hub.alarm()
    expect(spent).toEqual(["ghr_first"])
  })

  test("an outage is retried with the same refresh token, not before the retry delay", async () => {
    setSystemTime(new Date(START))
    const { hub, alarms } = newHub()
    await connect(hub, "ghu_first", "ghr_first")
    let down = true
    const spent = tokenEndpoint(() => (down ? new Response("unavailable", { status: 503 }) : granted("ghu_2", "ghr_2")))
    const due = START + EIGHT_HOURS - REFRESH_MARGIN_MS
    setSystemTime(new Date(due))
    await hub.alarm()
    expect(alarms.at(-1)).toBe(due + REFRESH_RETRY_MS)
    await hub.alarm()
    expect(spent).toEqual(["ghr_first"])

    down = false
    setSystemTime(new Date(due + REFRESH_RETRY_MS))
    await hub.alarm()
    expect(spent).toEqual(["ghr_first", "ghr_first"])
    expect(hub.credentials("octocat").github).toBe("ghu_2")
  })

  test("a reconnect while a refresh is in flight is kept", async () => {
    setSystemTime(new Date(START))
    const { hub, db } = newHub()
    await connect(hub, "ghu_first", "ghr_first")
    const answer = Promise.withResolvers<Response>()
    const requested = Promise.withResolvers<void>()
    tokenEndpoint(() => {
      requested.resolve()
      return answer.promise
    })
    setSystemTime(new Date(START + EIGHT_HOURS))
    const refreshing = hub.alarm()
    await requested.promise
    await hub.putConnection("octocat", "github", "ghu_reconnected", "octocat", {
      token: "ghr_reconnected",
      accessExpiresAt: Date.now() + EIGHT_HOURS,
      expiresAt: Date.now() + SIX_MONTHS,
    })
    answer.resolve(granted("ghu_late", "ghr_late"))
    await refreshing
    expect(hub.credentials("octocat").github).toBe("ghu_reconnected")
    expect(refreshColumns(db).secret).toBe("ghr_reconnected")
  })

  test("a token that does not expire schedules no refresh", async () => {
    setSystemTime(new Date(START))
    const { hub, db, alarms } = newHub()
    spyOn(globalThis, "fetch").mockImplementation((async () => Response.json({ access_token: "gho_classic" })) as typeof fetch)
    const grant = await exchangeCode(github, client, "code", "https://app.example/auth/github/callback")
    expect(grant.refresh).toBeNull()
    await hub.putConnection("octocat", "github", grant.accessToken, "octocat", grant.refresh)
    expect(refreshColumns(db)).toEqual({ secret: null, at: null })
    expect(alarms).toEqual([])
  })
})
