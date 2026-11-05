import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { AGENT_CLIS } from "./agent-clis"

const jwt = (claims: Record<string, unknown>): string =>
  `${Buffer.from(JSON.stringify({ alg: "none" })).toString("base64url")}.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.not-a-real-signature`

const codexStatus = (text: string) => {
  const status = AGENT_CLIS["codex-cli"].status
  if (status.kind !== "command") throw new Error("codex status is not a command")
  return Effect.runSync(status.parse({ stdout: "", stderr: text }))
}

const identityParser = (provider: "codex-cli" | "antigravity-cli") => {
  const identity = AGENT_CLIS[provider].identity
  if (identity === null) throw new Error(`${provider} has no stored identity`)
  return identity.parse
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

  test("Antigravity reads the signed-in Google email from its ID token", () => {
    const account = identityParser("antigravity-cli")(
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

  test("Antigravity stays signed in without identity when the token is old, malformed or names no user", () => {
    const parse = identityParser("antigravity-cli")
    expect(parse(JSON.stringify({ token: { access_token: "secret" }, auth_method: "consumer" }))).toBeNull()
    expect(parse("not json")).toBeNull()
    expect(parse(JSON.stringify({ token: { access_token: "secret" }, id_token: "not.a.jwt" }))).toBeNull()
    expect(parse(JSON.stringify({ id_token: jwt({ email: "not-an-email" }) }))).toBeNull()
  })
})
