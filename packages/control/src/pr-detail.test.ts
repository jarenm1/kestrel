import { afterEach, describe, expect, mock, test } from "bun:test"
import type { Env } from "./env"

mock.module("cloudflare:workers", () => ({ DurableObject: class {} }))
const worker = (await import("./index")).default
const originalFetch = globalThis.fetch
afterEach(() => { globalThis.fetch = originalFetch })
const credentials: string[] = []
const stub = {
  session: async (id: string) => id === "valid" ? { login: "alice" } : null,
  credentials: async (login: string) => { credentials.push(login); return { github: "user-token" } },
}
const env = { HUB: { idFromName: () => "main", get: () => stub } } as unknown as Env
const path = "/api/github/repos/acme/app/pulls/12"
const request = (url = path, cookie = "session=valid") => worker.fetch(new Request(`https://app.example${url}`, { headers: { cookie } }), env)
const actor = { login: "alice", avatar_url: "https://avatars.githubusercontent.com/u/1" }
const sha = "a".repeat(40)

describe("pull request detail route", () => {
  test("requires a session and validates repository and number before reading credentials", async () => {
    credentials.length = 0
    expect((await request(path, "")).status).toBe(401)
    expect((await request("/api/github/repos/acme/app/pulls/0")).status).toBe(400)
    expect((await request("/api/github/repos/acme%2Fother/app/pulls/12")).status).toBe(400)
    expect(credentials).toEqual([])
  })

  test("uses the caller's credential and paginates comments", async () => {
    const calls: string[] = []
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input); calls.push(url)
      expect(new Headers(init?.headers).get("authorization")).toBe("Bearer user-token")
      expect(url.startsWith("https://api.github.com/repos/acme/app/")).toBe(true)
      let body: unknown
      if (url.endsWith("/pulls/12")) body = { number: 12, title: "Title", body: null, state: "closed", draft: false, merged: true, user: actor, head: { ref: "feature", sha }, base: { ref: "main" }, requested_reviewers: [actor], requested_teams: [] }
      else if (url.includes("/comments?")) body = new URL(url).searchParams.get("page") === "1" ? Array.from({ length: 100 }, (_, id) => ({ id, body: "hi", user: actor, created_at: "now", updated_at: "now" })) : []
      else if (url.includes("/reviews?")) body = [{ id: 1, body: null, user: actor, state: "APPROVED", submitted_at: "now" }]
      else if (url.includes("/commits?")) body = [{ author: actor }, { author: actor }]
      else if (url.includes("/check-runs?")) body = { total_count: 1, check_runs: [{ name: "test", status: "completed", conclusion: "success", html_url: null }] }
      else body = { state: "success", statuses: [] }
      return Response.json(body)
    }) as typeof fetch
    const res = await request()
    expect(res.status).toBe(200)
    const detail = await res.json() as { state: string; comments: unknown[]; contributors: unknown[]; checks: { status: string }; truncated: { comments: boolean } }
    expect(detail.state).toBe("merged")
    expect(detail.comments).toHaveLength(100)
    expect(detail.contributors).toHaveLength(1)
    expect(detail.checks.status).toBe("success")
    expect(detail.truncated.comments).toBe(false)
    expect(calls.some((url) => url.includes("comments?per_page=100&page=2"))).toBe(true)
    expect(credentials.at(-1)).toBe("alice")
  })

  test("maps an inaccessible pull request to 404 and malformed upstream data to 502", async () => {
    globalThis.fetch = (async () => new Response(null, { status: 404 })) as typeof fetch
    expect((await request()).status).toBe(404)
    globalThis.fetch = (async () => Response.json({ title: "incomplete" })) as typeof fetch
    expect((await request()).status).toBe(502)
  })
})
