import { expect, test } from "bun:test"
import { Schema } from "effect"
import { AGENT_MODELS, AgentModel, modelHarness, modelInfo, modelUpstreamId, parseAgentModel } from "./src/models"

const accepts = Schema.is(AgentModel)

test("the catalog and the AgentModel type promise the same ids", () => {
  for (const model of AGENT_MODELS) {
    expect(accepts(model.id)).toBe(true)
    expect(parseAgentModel(model.id)).toBe(model.id)
  }
  expect(parseAgentModel("claude-opus-5-5@anything")).toBeUndefined()
  // @ts-expect-error Anthropic models never route to Codex.
  const wrongHarness: AgentModel = "claude-opus-5-5@codex"
  // @ts-expect-error Free OpenCode models stay on their own harness.
  const nativeOnly: AgentModel = "opencode/big-pickle@claude"
  expect([wrongHarness, nativeOnly].every((id) => !accepts(id))).toBe(true)
})

test("route ids are the catalog's supported harnesses only", () => {
  expect(accepts("claude-opus-5-5")).toBe(true)
  expect(accepts("claude-opus-5-5@opencode")).toBe(true)
  expect(accepts("deepseek-flash[1m]@codex")).toBe(true)
  expect(accepts("kimi-k3.1-pro@codex")).toBe(true)
  // The base id already runs this provider's current harness; no duplicate route id is generated.
  expect(accepts("claude-opus-5-5@claude")).toBe(false)
  // Free OpenCode and Google stay native, and Kimi's old code model has no Responses endpoint.
  expect(accepts("opencode/big-pickle@claude")).toBe(false)
  expect(accepts("gemini-3.8-flash@codex")).toBe(false)
  expect(accepts("kimi-k2.7-code@codex")).toBe(false)
  expect(accepts("claude-opus-5-5@anything")).toBe(false)
})

test("a route keeps its provider and reports the native upstream model id", () => {
  expect(modelInfo("deepseek-flash[1m]@opencode").provider).toBe("deepseek")
  expect(modelHarness("deepseek-flash[1m]@opencode")).toBe("opencode")
  expect(modelUpstreamId("deepseek-flash[1m]@opencode")).toBe("deepseek-flash")
  expect(modelUpstreamId("deepseek-flash[1m]@codex")).toBe("deepseek-flash")
  // Claude Code needs its 1m decoration; the base DeepSeek id keeps its provider's current harness.
  expect(modelUpstreamId("deepseek-flash[1m]")).toBe("deepseek-flash[1m]")
  expect(modelHarness("deepseek-flash[1m]")).toBe("claude")
  // OpenCode's own catalog prefix is only for its native route; a brokered Go route sends the bare model id.
  expect(modelUpstreamId("opencode-go/kimi-k3.1-pro")).toBe("opencode-go/kimi-k3.1-pro")
  expect(modelUpstreamId("opencode-go/kimi-k3.1-pro@claude")).toBe("kimi-k3.1-pro")
  expect(modelUpstreamId("anthropic/claude-opus-5.5@codex")).toBe("anthropic/claude-opus-5.5")
})

test("thinking levels follow the route, not the base Claude guide", () => {
  expect(modelInfo("deepseek-flash[1m]@codex").efforts).toEqual(["low", "high", "max"])
  expect(modelInfo("deepseek-v4-pro@codex").efforts).toEqual(["low", "high", "max"])
  // OpenCode's compatibility package does not forward the ACP level upstream, so its routes expose no thinking.
  expect(modelInfo("deepseek-flash[1m]@opencode").efforts).toEqual([])
  expect(modelInfo("claude-opus-5-5@opencode").efforts).toEqual([])
})
