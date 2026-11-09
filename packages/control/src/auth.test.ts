import { describe, expect, test } from "bun:test"
import { currentSession, handleAuth, scriptString } from "./auth"
import type { Env } from "./env"

const envFor = (stub: object, vars: Partial<Env> = {}): Env => ({
  ...vars,
  HUB: { idFromName: () => "main", get: () => stub },
} as unknown as Env)

describe("GitHub access", () => {
  test("rejects an existing session when its login is removed, including native callbacks", async () => {
    const env = envFor({ session: () => ({ login: "removed", dev: false }) }, { ALLOWED_GITHUB_LOGINS: "jarenm1" })
    const request = new Request("https://example.com/auth/desktop-callback", { headers: { cookie: "session=old" } })
    expect(await currentSession(request, env)).toBeNull()
    expect((await handleAuth(request, env, new URL(request.url))).status).toBe(401)
  })

  test("refuses unapproved OAuth accounts before creating a user, connection or session", async () => {
    const originalFetch = globalThis.fetch
    const writes: string[] = []
    const consumed: Array<[string, string]> = []
    const stub = {
      readOAuthState: () => ({ kind: "login", provider: "github", returnTo: "/", revision: "r1" }),
      consumeOAuthState: (state: string, revision: string) => {
        consumed.push([state, revision])
        return { kind: "login", provider: "github", returnTo: "/", revision: "r1" }
      },
      upsertUser: () => writes.push("user"),
      putConnection: () => writes.push("connection"),
      createSession: () => writes.push("session"),
    }
    const env = envFor(stub, { ALLOWED_GITHUB_LOGINS: "jarenm1", GITHUB_CLIENT_ID: "id", GITHUB_CLIENT_SECRET: "secret" })
    let login = "other"
    globalThis.fetch = (async (input: string | URL | Request) => String(input).includes("access_token")
      ? Response.json({ access_token: "token" })
      : Response.json({ login, avatar_url: "" })) as typeof fetch
    try {
      const url = new URL("https://example.com/auth/github/callback?code=code&state=state")
      expect((await handleAuth(new Request(url), env, url)).status).toBe(403)
      expect(writes).toEqual([])
      login = "JarenM1"
      const response = await handleAuth(new Request(url), env, url)
      expect(response.status).toBe(302)
      expect(response.headers.get("set-cookie")).toContain("session=")
      expect(writes).toEqual(["user", "connection", "session"])
      // The validated issuance, not just the state string: this locks the ABA revision into the callback.
      expect(consumed).toEqual([["state", "r1"]])
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  test("answers 409 when a caller-supplied state collides with a live one instead of failing inside SQLite", async () => {
    const stub = { createOAuthState: () => false }
    const env = envFor(stub, { GITHUB_CLIENT_ID: "id", GITHUB_CLIENT_SECRET: "secret" })
    const url = new URL("https://example.com/auth/github/login?state=already-live")
    const response = await handleAuth(new Request(url), env, url)
    expect(response.status).toBe(409)
    expect(await response.json()).toMatchObject({ _tag: "Conflict" })
  })

  test("validates expiry and provider before consuming a state", async () => {
    const writes: string[] = []
    let state: { kind: "login"; provider: string; returnTo: string; revision: string } | null = {
      kind: "login",
      provider: "google",
      returnTo: "/",
      revision: "r1",
    }
    const stub = {
      readOAuthState: () => state,
      consumeOAuthState: () => {
        writes.push("consume")
        return state
      },
      upsertUser: () => writes.push("user"),
    }
    const env = envFor(stub, { ALLOWED_GITHUB_LOGINS: "jarenm1", GITHUB_CLIENT_ID: "id", GITHUB_CLIENT_SECRET: "secret" })
    const originalFetch = globalThis.fetch
    globalThis.fetch = (async (input: string | URL | Request) => String(input).includes("access_token")
      ? Response.json({ access_token: "token" })
      : Response.json({ login: "jarenm1", avatar_url: "" })) as typeof fetch
    try {
      const url = new URL("https://example.com/auth/github/callback?code=code&state=state")
      // Issued for another provider: rejected without burning it.
      expect((await handleAuth(new Request(url), env, url)).status).toBe(400)
      expect(writes).toEqual([])
      // Missing (expired or already consumed): rejected, and nothing is consumed again.
      state = null
      expect((await handleAuth(new Request(url), env, url)).status).toBe(400)
      expect(writes).toEqual([])
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  test("a callback that loses the consume race creates no session", async () => {
    const writes: string[] = []
    const stub = {
      readOAuthState: () => ({ kind: "login", provider: "github", returnTo: "/", revision: "r1" }),
      consumeOAuthState: () => null,
      upsertUser: () => writes.push("user"),
      putConnection: () => writes.push("connection"),
      createSession: () => writes.push("session"),
    }
    const env = envFor(stub, { ALLOWED_GITHUB_LOGINS: "jarenm1", GITHUB_CLIENT_ID: "id", GITHUB_CLIENT_SECRET: "secret" })
    const originalFetch = globalThis.fetch
    globalThis.fetch = (async (input: string | URL | Request) => String(input).includes("access_token")
      ? Response.json({ access_token: "token" })
      : Response.json({ login: "jarenm1", avatar_url: "" })) as typeof fetch
    try {
      const url = new URL("https://example.com/auth/github/callback?code=code&state=state")
      expect((await handleAuth(new Request(url), env, url)).status).toBe(400)
      expect(writes).toEqual([])
    } finally {
      globalThis.fetch = originalFetch
    }
  })
})

describe("scriptString", () => {
  test("escapes a script-close tag so it cannot break out of the inline script", () => {
    const out = scriptString("</script><script>alert(1)</script>")
    expect(out).not.toContain("</script>")
    expect(out).toContain("\\u003c")
  })

  test("escapes quotes and backslashes as a JS string literal", () => {
    const out = scriptString('a"b\\c')
    expect(out).toContain('\\"')
    expect(out).toContain("\\\\")
  })
})
