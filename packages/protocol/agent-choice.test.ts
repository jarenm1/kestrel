import { describe, expect, test } from "bun:test"
import { AGENT_MODELS, MODEL_PROVIDERS, resolveAgentChoice, type AgentEffort, type AgentModel } from "./src/models"

const anthropic = AGENT_MODELS.filter((m) => m.provider === "anthropic" && m.efforts.length > 0)
const [first, second, hidden] = anthropic.map((m) => m.id) as [AgentModel, AgentModel, AgentModel]
const level = anthropic[1]!.efforts[0] as AgentEffort
const offered = anthropic.slice(0, 2)
const connected = MODEL_PROVIDERS.filter((p) => p.id === "anthropic")
const base = { offered, connected, pickedModel: undefined, pickedEffort: undefined, lastRun: undefined, defaultModel: undefined, defaultEffort: undefined }

describe("resolveAgentChoice", () => {
  test("a thread shows what its last run used, not the device default", () => {
    const { model, effort } = resolveAgentChoice({ ...base, lastRun: { model: second, effort: level }, defaultModel: first, defaultEffort: "default" })
    expect(model?.id).toBe(second)
    expect(effort).toBe(level)
  })

  test("an unsent pick wins over the last run", () => {
    const { model } = resolveAgentChoice({ ...base, pickedModel: first, lastRun: { model: second } })
    expect(model?.id).toBe(first)
  })

  test("an explicit default level overrides the last run's level", () => {
    const { effort } = resolveAgentChoice({ ...base, pickedEffort: "default", lastRun: { model: second, effort: level } })
    expect(effort).toBeUndefined()
  })

  test("a run on the default level does not inherit the device's level", () => {
    const { effort } = resolveAgentChoice({ ...base, lastRun: { model: second, effort: null }, defaultEffort: level })
    expect(effort).toBeUndefined()
  })

  test("older runs without a recorded level retain the device default", () => {
    const { effort } = resolveAgentChoice({ ...base, lastRun: { model: second }, defaultEffort: level })
    expect(effort).toBe(level)
  })

  test("a last run on the box default falls to the device's model and keeps its own level", () => {
    const run = resolveAgentChoice({ ...base, lastRun: { effort: null }, defaultModel: second, defaultEffort: level })
    expect(run.model?.id).toBe(second)
    expect(run.effort).toBeUndefined()
  })

  test("the last run's model stays while hidden from the picker, and falls away once its provider is disconnected", () => {
    expect(resolveAgentChoice({ ...base, lastRun: { model: hidden } }).model?.id).toBe(hidden)
    expect(resolveAgentChoice({ ...base, connected: [], lastRun: { model: hidden } }).model?.id).toBe(first)
  })

  test("a pick that is no longer on offer does not count", () => {
    expect(resolveAgentChoice({ ...base, pickedModel: hidden, lastRun: { model: second } }).model?.id).toBe(second)
  })

  test("without a run the device default applies, then the first model on offer", () => {
    expect(resolveAgentChoice({ ...base, defaultModel: second, defaultEffort: level })).toMatchObject({ model: { id: second }, effort: level })
    expect(resolveAgentChoice(base).model?.id).toBe(first)
  })

  test("nothing resolves before the connections load", () => {
    expect(resolveAgentChoice({ ...base, offered: [], connected: [], lastRun: { model: second, effort: level } })).toEqual({ model: undefined, effort: undefined })
  })
})
