import { expect, test } from "bun:test"
import { harnessForModel } from "../agent-clis"
import { loginsForModel } from "./harness"

const logins = [{ provider: "claude-cli" as const }, { provider: "codex-cli" as const }]

test("a routed model never mounts a subscription login", () => {
  // The route's API key is the broker's; a Claude/ChatGPT subscription must not stand in for it. Native vendor runs
  // keep their logins exactly as before.
  expect(loginsForModel("claude-opus-5-5@opencode", "anthropic", logins)).toEqual([])
  expect(loginsForModel("deepseek-flash[1m]@codex", "deepseek", logins)).toEqual([])
  expect(loginsForModel("opencode-go/kimi-k3.1-pro@claude", "opencode-go", logins)).toEqual([])
  expect(loginsForModel("claude-opus-5-5", "anthropic", logins)).toHaveLength(2)
})

test("a route starts the harness that id names, while native OpenCode keeps its own login", () => {
  const codex = harnessForModel("deepseek-flash[1m]@codex")
  expect(codex.conversation).toBe("codex")
  expect(codex.broker).toBe(true)
  const opencode = harnessForModel("deepseek-flash[1m]@opencode")
  expect(opencode.conversation).toBe("acp")
  expect(opencode.broker).toBe(true)
  expect(opencode.minVersion).toEqual([2, 1])
  const native = harnessForModel("opencode-go/kimi-k3.1-pro")
  expect(native.broker).toBe(false)
})
