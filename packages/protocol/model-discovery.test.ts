import { expect, test } from "bun:test"
import { Schema } from "effect"
import { AgentModel, ModelCatalog, discoveredModel, mergeModelCatalog, modelHarness, modelInfo, modelUpstreamId, parseAgentModel, shownModels } from "./src/models"
import { SendMessageBody } from "./src/index"

test("new provider models survive wire validation and stateless routing", () => {
  const model = discoveredModel("openai", "gpt-future-codex")!
  expect(model.id).toBe("live/openai/gpt-future-codex")
  expect(Schema.is(AgentModel)(model.id)).toBe(true)
  expect(modelInfo(model.id)).toEqual(model)
  expect(modelHarness(model.id)).toBe("codex")
  expect(modelUpstreamId(model.id)).toBe("gpt-future-codex")
  expect(Schema.is(SendMessageBody)({ text: "hello", model: model.id })).toBe(true)
  expect(Schema.is(SendMessageBody)({ text: "hello", model: model.id, effort: "high" })).toBe(false)
})

test("provider identities do not collide and native OpenCode prefixes reach the CLI", () => {
  const direct = discoveredModel("deepseek", "future-model")!
  const gateway = discoveredModel("openrouter", "future-model")!
  expect(direct.id).not.toBe(gateway.id)
  const free = discoveredModel("opencode", "opencode/future-free")!
  expect(modelUpstreamId(free.id)).toBe("opencode/future-free")
  expect(modelHarness(free.id)).toBe("opencode")
  expect(discoveredModel("opencode", "anthropic/paid-model")).toBeUndefined()
})

test("discovery preserves curated identity, context hints, efforts and custom visibility", () => {
  const known = discoveredModel("deepseek", "deepseek-flash")!
  expect(known.id).toBe("deepseek-flash[1m]")
  expect(known.efforts).not.toEqual([])
  const fresh = discoveredModel("deepseek", "deepseek-future")!
  const catalog = mergeModelCatalog([known, fresh, fresh])
  expect(catalog.filter((m) => m.id === fresh.id)).toEqual([fresh])
  expect(shownModels("deepseek", null, catalog).map((m) => m.id)).toContain(fresh.id)
  expect(shownModels("deepseek", [known.id], catalog).map((m) => m.id)).not.toContain(fresh.id)
  expect(shownModels("deepseek", [fresh.id], catalog)).toEqual([fresh])
})

test("runtime ids reject shell syntax, unsupported routes, oversized ids and unknown providers", () => {
  for (const id of ["live/unknown/model", "live/openai/-flag", "live/openai/a;exit", "live/openai/a\nmodel", "live/openai/a@opencode", `live/openai/${"a".repeat(201)}`, "live/opencode/other/model"]) {
    expect(parseAgentModel(id)).toBeUndefined()
  }
  expect(discoveredModel("anthropic", "model$(echo bad)")).toBeUndefined()
})

test("catalog boundaries reject live metadata that changes provider or native routing", () => {
  const model = discoveredModel("openai", "future-model")!
  expect(Schema.is(ModelCatalog)({ models: [model], sources: [] })).toBe(true)
  for (const patch of [{ provider: "anthropic" }, { harness: "claude" }, { upstreamModel: "different-model" }, { efforts: ["high"] }]) {
    expect(Schema.is(ModelCatalog)({ models: [{ ...model, ...patch }], sources: [] })).toBe(false)
  }
})
