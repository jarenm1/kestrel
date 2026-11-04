import { describe, expect, test } from "bun:test"
import { ModelProvider, type CliProvider, type RelayCredentials } from "@cloudagents/protocol"
import { MODEL_HARNESS } from "../agent-clis"
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
    for (const provider of ["openrouter", "zai", "deepseek", "minimax", "moonshot", "deepinfra"] as const) {
      expect(loginsForProvider(provider, logins)).toEqual([])
    }
  })

  test("a Go login is mounted only by Go, while vendor runs retain only their two CLI logins", () => {
    const go: Login = { provider: "opencode-go", dir: "/data/opencode-go" }
    const google: Login = { provider: "antigravity-cli", dir: "/data/antigravity" }
    const connected = [...logins, go, google]
    expect(loginsForProvider("opencode-go", connected)).toEqual([go])
    expect(loginsForProvider("google", connected)).toEqual([google])
    expect(loginsForProvider("anthropic", connected)).toEqual(logins)
    expect(loginsForProvider("openai", connected)).toEqual(logins)
    for (const provider of ModelProvider.literals.filter((id) => id !== "opencode-go")) {
      expect(loginsForProvider(provider, connected)).not.toContain(go)
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
    expect(claudeTierEnv("deepseek-ai/DeepSeek-V4.1-Flash-1017[1m]").CLAUDE_CODE_AUTO_COMPACT_WINDOW).toBe("1000000")
    expect(claudeTierEnv("inclusionAI/Ling-3.0-flash").CLAUDE_CODE_AUTO_COMPACT_WINDOW).toBe("131072")
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

  test("DeepInfra runs Claude Code through the broker's DeepInfra route", () => {
    // Its Anthropic-compatible endpoint speaks the Messages API, so the claude harness carries it like the gateways.
    expect(MODEL_HARNESS.deepinfra).toEqual({
      conversation: "claude",
      cli: "claude-cli",
      bin: "claude",
      minVersion: null,
      broker: true,
    })
    expect(credentialFor({ user: "alice", providers: { deepinfra: "deepinfra-key" } }, "deepinfra")).toBe("deepinfra-key")
  })
})
