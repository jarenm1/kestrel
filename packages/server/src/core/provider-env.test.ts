import { describe, expect, test } from "bun:test"
import type { CliProvider, RelayCredentials } from "@cloudagents/protocol"
import { brokerEnv, credentialFor } from "../broker"
import { claudeTierEnv, loginsForProvider } from "./harness"

interface Login {
  readonly provider: CliProvider
  readonly dir: string
}

const logins: readonly Login[] = [
  { provider: "claude-cli", dir: "/data/claude" },
  { provider: "codex-cli", dir: "/data/codex" },
]

describe("per-provider run environment", () => {
  test("Anthropic and OpenAI runs keep both vendor logins", () => {
    expect(loginsForProvider("anthropic", logins)).toEqual(logins)
    expect(loginsForProvider("openai", logins)).toEqual(logins)
  })

  test("third-party gateway runs do not mount either vendor login", () => {
    for (const provider of ["openrouter", "zai", "deepseek", "minimax", "moonshot"] as const) {
      expect(loginsForProvider(provider, logins)).toEqual([])
    }
  })

  test("Anthropic and OpenAI get both broker env sets", () => {
    for (const provider of ["anthropic", "openai"] as const) {
      expect(brokerEnv(provider, "http://box/broker/t", "t")).toEqual({
        ANTHROPIC_BASE_URL: "http://box/broker/t/anthropic",
        ANTHROPIC_API_KEY: "t",
        OPENAI_BASE_URL: "http://box/broker/t/openai/v1",
        OPENAI_API_KEY: "t",
      })
    }
  })

  test("a gateway key uses the auth token, never the Anthropic API key", () => {
    expect(brokerEnv("openrouter", "http://box/broker/t", "t")).toEqual({
      ANTHROPIC_BASE_URL: "http://box/broker/t/openrouter",
      ANTHROPIC_AUTH_TOKEN: "t",
      ANTHROPIC_API_KEY: "",
    })
  })

  test("tier pins carry the gateway's auto-compact window", () => {
    expect(claudeTierEnv("glm-5.3[1m]").CLAUDE_CODE_AUTO_COMPACT_WINDOW).toBe("1000000")
    expect(claudeTierEnv("deepseek-flash[1m]").CLAUDE_CODE_AUTO_COMPACT_WINDOW).toBe("786432")
    expect(claudeTierEnv("MiniMax-M3.1-Flash[1m]").CLAUDE_CODE_AUTO_COMPACT_WINDOW).toBe("524288")
    expect(claudeTierEnv("kimi-k3[1m]").CLAUDE_CODE_AUTO_COMPACT_WINDOW).toBe("1000000")
  })

  test("a provider-map key wins over the legacy slot", () => {
    const creds: RelayCredentials = {
      user: "alice",
      providers: { anthropic: "provider-key", openai: "openai-provider" },
      anthropic: "legacy-key",
      openai: "legacy-openai",
    }
    expect(credentialFor(creds, "anthropic")).toBe("provider-key")
    expect(credentialFor(creds, "openai")).toBe("openai-provider")
    expect(credentialFor(creds, "openrouter")).toBeNull()
  })
})
