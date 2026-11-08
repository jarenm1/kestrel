import { describe, expect, spyOn, test } from "bun:test"
import { Database } from "bun:sqlite"
import { mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Effect } from "effect"
import { AGENT_CLIS, MODEL_HARNESS } from "./agent-clis"

const jwt = (claims: Record<string, unknown>): string =>
  `${Buffer.from(JSON.stringify({ alg: "none" })).toString("base64url")}.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.not-a-real-signature`

const codexStatus = (text: string) => {
  const status = AGENT_CLIS["codex-cli"].status
  if (status.kind !== "command") throw new Error("codex status is not a command")
  return Effect.runSync(status.parse({ stdout: "", stderr: text }))
}

/** A login directory with nothing in it; Antigravity remembers looked-up emails there. */
const emptyLoginDir = join(tmpdir(), "kestrel-no-such-login")

const identityParser = (provider: "codex-cli" | "antigravity-cli") => {
  const identity = AGENT_CLIS[provider].identity
  if (identity === null || !("parse" in identity)) throw new Error(`${provider} has no stored identity parser`)
  return (text: string, dir = emptyLoginDir) => identity.parse(text, dir)
}

describe("codex login status", () => {
  test("keeps the login boolean and never labels it with the sign-in method", () => {
    expect(codexStatus("Logged in using ChatGPT\n")).toEqual({ provider: "codex-cli", loggedIn: true, account: null })
    expect(codexStatus("Not logged in\n")).toEqual({ provider: "codex-cli", loggedIn: false, account: null })
  })

  test("recognises a key-backed Codex login without returning the key", () => {
    const status = codexStatus("API key configured - sk-proj-secret\n" + "This key is stored in auth.json.\n")
    expect(status).toEqual({ provider: "codex-cli", loggedIn: true, account: null })
    expect(JSON.stringify(status)).not.toContain("sk-proj-secret")
  })

  test("still recognises the older key-backed status line", () => {
    expect(codexStatus("Logged in using an API key - sk-proj-old\n")).toEqual({
      provider: "codex-cli",
      loggedIn: true,
      account: null,
    })
  })
})

const openCodeStatus = (provider: "opencode" | "opencode-go", text: string) => {
  const status = AGENT_CLIS[provider].status
  if (status.kind !== "command") throw new Error(`${provider} status is not a command`)
  return Effect.runSync(status.parse({ stdout: text, stderr: "" }))
}

const openCodeLink = (text: string) => {
  const signIn = AGENT_CLIS.opencode.signIn
  if (signIn.kind !== "page") throw new Error("opencode does not sign in on a page")
  return signIn.parseLoginLink(text)
}

describe("OpenCode Console login", () => {
  test("reads each OpenCode integration's own connection", () => {
    const goOnly = JSON.stringify([{ id: "opencode-go", connections: [{ id: "cred" }] }])
    expect(openCodeStatus("opencode", goOnly)).toEqual({ provider: "opencode", loggedIn: false, account: null })
    expect(openCodeStatus("opencode-go", goOnly)).toEqual({ provider: "opencode-go", loggedIn: true, account: null })
    const both = JSON.stringify([
      { id: "opencode", connections: [{ id: "device" }] },
      { id: "opencode-go", connections: [] },
    ])
    expect(openCodeStatus("opencode", both)).toEqual({ provider: "opencode", loggedIn: true, account: null })
    expect(openCodeStatus("opencode-go", both)).toEqual({ provider: "opencode-go", loggedIn: false, account: null })
  })

  test("Console reads only its active account's email from its own database, never labels or tokens", () => {
    const identity = AGENT_CLIS.opencode.identity
    if (identity === null || !("read" in identity)) throw new Error("Console has no database identity reader")
    const root = mkdtempSync(join(tmpdir(), "kestrel-opencode-identity-"))
    const file = join(root, "opencode.db")
    const db = new Database(file)
    try {
      db.exec("CREATE TABLE credential (id TEXT PRIMARY KEY, integration_id TEXT, label TEXT, value TEXT, active INTEGER, time_created INTEGER)")
      const insert = db.query("INSERT INTO credential VALUES (?, ?, ?, ?, ?, ?)")
      insert.run("old", "opencode", "old-org", JSON.stringify({ metadata: { email: "old@example.com" } }), 0, 1)
      insert.run("go", "opencode-go", "go-org", JSON.stringify({ metadata: { email: "go@example.com" } }), 1, 3)
      insert.run("current", "opencode", "org", JSON.stringify({ access: "secret", metadata: { email: "console@example.com" } }), 1, 2)
      expect(identity.read(file)).toBe("console@example.com")
      db.exec("UPDATE credential SET active = CASE WHEN id = 'old' THEN 1 ELSE 0 END WHERE integration_id = 'opencode'")
      expect(identity.read(file)).toBe("old@example.com")
      db.query("UPDATE credential SET label = ?, value = ? WHERE id = 'old'")
        .run("not-the-identity@example.com", JSON.stringify({ access: "secret", metadata: { email: "invalid\nemail@example.com" } }))
      expect(identity.read(file)).toBeNull()
      db.exec("DELETE FROM credential WHERE integration_id = 'opencode'")
      expect(identity.read(file)).toBeNull()
    } finally {
      db.close()
      rmSync(root, { recursive: true, force: true })
    }
  })

  test("takes clack's decorated complete code and link lines", () => {
    // The CLI prints a bare gutter, then each decorated line (2.0.7 observed).
    const text = "|\n•  Enter code: KTNV-ZPLM\n|\n•  https://opencode.ai/console/device?user_code=KTNV-ZPLM&client_id=opencode-cli\n"
    expect(openCodeLink(text)).toEqual({
      url: "https://opencode.ai/console/device?user_code=KTNV-ZPLM&client_id=opencode-cli",
      userCode: "KTNV-ZPLM",
    })
  })

  test("does not take a half-written code or link, or one without the other", () => {
    const url = "https://opencode.ai/console/device?user_code=KTNV-ZPLM&client_id=opencode-cli"
    expect(openCodeLink(`•  Enter code: KTNV-ZPLM\n|\n•  ${url.slice(0, 32)}`)).toBeNull()
    expect(openCodeLink(`•  Enter code: KTNV-ZPLM\n`)).toBeNull()
    expect(openCodeLink(`|\n•  ${url}\n`)).toBeNull()
    expect(openCodeLink(`•  Enter code: KTNV-ZPLM\n|\n•  http://opencode.ai/console/device\n`)).toBeNull()
  })
})

describe("stored identities", () => {
  test("Codex reads the ChatGPT email from the stored ID token and no token material", () => {
    const account = identityParser("codex-cli")(
      JSON.stringify({
        auth_mode: "chatgpt",
        OPENAI_API_KEY: null,
        tokens: {
          id_token: jwt({ email: "codex-user@example.com" }),
          access_token: "secret-access-token",
          refresh_token: "secret-refresh-token",
        },
      }),
    )
    expect(account).toBe("codex-user@example.com")
    expect(account).not.toContain("secret")
  })

  test("Codex falls back to the profile email claim", () => {
    expect(
      identityParser("codex-cli")(
        JSON.stringify({
          auth_mode: "chatgptAuthTokens",
          tokens: { id_token: jwt({ "https://api.openai.com/profile": { email: "profile@example.com" } }) },
        }),
      ),
    ).toBe("profile@example.com")
  })

  test("Codex uses a registered agent identity's email", () => {
    expect(
      identityParser("codex-cli")(JSON.stringify({ auth_mode: "agentIdentity", agent_identity: { email: "agent@example.com" } })),
    ).toBe("agent@example.com")
  })

  test("Codex returns null when no stored identity names the signed-in user", () => {
    const parse = identityParser("codex-cli")
    expect(parse("not json")).toBeNull()
    expect(parse(JSON.stringify({ OPENAI_API_KEY: "sk-secret" }))).toBeNull()
    expect(parse(JSON.stringify({ auth_mode: "apiKey", OPENAI_API_KEY: "sk-secret", tokens: { id_token: jwt({ email: "stale@example.com" }) } }))).toBeNull()
    expect(parse(JSON.stringify({ tokens: {} }))).toBeNull()
    expect(parse(JSON.stringify({ tokens: { id_token: "not.a.jwt" } }))).toBeNull()
    expect(parse(JSON.stringify({ tokens: { id_token: jwt({ email: "not-an-email" }) } }))).toBeNull()
    expect(parse(JSON.stringify({ tokens: { id_token: jwt({ email: "user@example.com\nleak" }) } }))).toBeNull()
  })

  test("Antigravity reads the signed-in Google email from its ID token", async () => {
    const account = await identityParser("antigravity-cli")(
      JSON.stringify({
        token: {
          access_token: "secret-access-token",
          token_type: "Bearer",
          refresh_token: "secret-refresh-token",
          expiry: "2030-01-01T00:00:00Z",
        },
        auth_method: "consumer",
        id_token: jwt({ email: "google-user@example.com", sub: "1234567890" }),
      }),
    )
    expect(account).toBe("google-user@example.com")
    expect(account).not.toContain("secret")
  })

  test("Antigravity stays signed in without identity when the token is old, malformed or names no user", async () => {
    const parse = identityParser("antigravity-cli")
    expect(await parse(JSON.stringify({ token: {}, auth_method: "consumer" }))).toBeNull()
    expect(await parse("not json")).toBeNull()
    expect(await parse(JSON.stringify({ token: {}, id_token: "not.a.jwt" }))).toBeNull()
    expect(await parse(JSON.stringify({ id_token: jwt({ email: "not-an-email" }) }))).toBeNull()
  })

  test("Antigravity resolves older access-token-only logins through Google without exposing credentials", async () => {
    const request = spyOn(globalThis, "fetch").mockResolvedValue(Response.json({ email: "legacy@example.com" }))
    try {
      expect(await identityParser("antigravity-cli")(JSON.stringify({ token: { access_token: "secret" } }))).toBe("legacy@example.com")
      expect(request.mock.calls[0]?.[0]).toBe("https://www.googleapis.com/oauth2/v2/userinfo")
      expect(request.mock.calls[0]?.[1]?.headers).toEqual({ Authorization: "Bearer secret" })
    } finally {
      request.mockRestore()
    }
  })

  test("Antigravity identity failures do not expose response data or reject the login probe", async () => {
    const request = spyOn(globalThis, "fetch").mockResolvedValue(Response.json({ email: "secret-token" }))
    const credentials = JSON.stringify({ token: { access_token: "secret" } })
    try {
      const parse = identityParser("antigravity-cli")
      expect(await parse(credentials)).toBeNull()
      request.mockResolvedValue(new Response("secret", { status: 401 }))
      expect(await parse(credentials)).toBeNull()
      request.mockRejectedValue(new Error("network unavailable"))
      expect(await parse(credentials)).toBeNull()
    } finally {
      request.mockRestore()
    }
  })

  test("Antigravity keeps the looked-up email after the access token expires, only for the same login", async () => {
    const dir = mkdtempSync(join(tmpdir(), "kestrel-antigravity-identity-"))
    const login = (access: string, refresh: string) => JSON.stringify({ token: { access_token: access, refresh_token: refresh } })
    const request = spyOn(globalThis, "fetch").mockResolvedValue(Response.json({ email: "fresh@example.com" }))
    try {
      const parse = identityParser("antigravity-cli")
      expect(await parse(login("fresh-access", "refresh-one"), dir)).toBe("fresh@example.com")
      expect(readFileSync(join(dir, ".kestrel-account.json"), "utf8")).not.toContain("refresh-one")
      request.mockResolvedValue(new Response("expired", { status: 401 }))
      expect(await parse(login("expired-access", "refresh-one"), dir)).toBe("fresh@example.com")
      expect(await parse(login("expired-access", "refresh-two"), dir)).toBeNull()
    } finally {
      request.mockRestore()
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

const devinLink = (text: string) => {
  const signIn = AGENT_CLIS["devin-cli"].signIn
  if (signIn.kind !== "page") throw new Error("devin does not sign in on a page")
  return signIn.parseLoginLink(text)
}

describe("Devin CLI login", () => {
  test("recognises status output and rejects unreadable credentials without exposing it", () => {
    const status = AGENT_CLIS["devin-cli"].status
    if (status.kind !== "command") throw new Error("devin status is not a command")
    const parse = (stdout: string) => Effect.runSync(status.parse({ stdout, stderr: "" }))
    expect(parse("Not logged in.\n  Credentials path: /tmp/credentials.toml\n")).toEqual({ provider: "devin-cli", loggedIn: false, account: null })
    expect(parse("Logged in (via browser)\n")).toEqual({ provider: "devin-cli", loggedIn: true, account: null })
    expect(() => parse("Failed to load credentials: secret-token\n")).toThrow("devin auth status: unexpected output")
    expect(() => parse("unrecognised output\n")).toThrow("devin auth status: unexpected output")
  })

  test("reads the server-reported Devin email, not credential paths or API keys", () => {
    const status = AGENT_CLIS["devin-cli"].status
    if (status.kind !== "command") throw new Error("devin status is not a command")
    const parse = (stdout: string) => Effect.runSync(status.parse({ stdout, stderr: "" }))
    expect(parse("Logged in (via browser).\nCredentials:\n  File: /tmp/other@example.com\nUser:\n  Email: devin@example.com\n"))
      .toEqual({ provider: "devin-cli", loggedIn: true, account: "devin@example.com" })
    expect(parse("Logged in (via API key).\n  Email: secret-token\n").account).toBeNull()
    expect(parse("Not logged in.\n  Email: stale@example.com\n").account).toBeNull()
  })
  const url =
    "https://app.devin.ai/auth/cli/continue?state=3be28d3b&prompt=select_account&code_challenge=RAH2Lr&code_challenge_method=S256&cli_pkce_marker=1"

  test("reads the manual flow's link once its sentence is complete", () => {
    expect(devinLink(`Visit ${url} to sign in, then copy the code and paste it below.\n`)).toEqual({ url, userCode: null })
    expect(devinLink(`Visit ${url.slice(0, 60)}`)).toBeNull()
    expect(devinLink(`Visit ${url}`)).toBeNull()
  })

  test("reads the link through the terminal's OSC 8 hyperlink", () => {
    const printed = `\x1b7\r\nVisit \x1b]8;;${url}\x1b\\${url}\x1b]8;;\x1b\\ to sign in, then copy the code and paste it below.\r\n`
    expect(devinLink(printed)).toEqual({ url, userCode: null })
  })

  test("signs in through a terminal and never resumes a session it cannot resume", () => {
    const signIn = AGENT_CLIS["devin-cli"].signIn
    expect(signIn.kind === "page" && signIn.needsCode && signIn.terminal).toBe(true)
    expect(MODEL_HARNESS.devin).toMatchObject({ conversation: "acp", cli: "devin-cli", bin: "devin", broker: false, resume: false })
  })
})
