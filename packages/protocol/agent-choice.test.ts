import { describe, expect, test } from "bun:test"
import { AGENT_MODELS, MODEL_PROVIDERS, resolveAgentChoice, threadChoiceRun, type AgentEffort, type AgentModel } from "./src/models"

const anthropic = AGENT_MODELS.filter((m) => m.provider === "anthropic" && m.efforts.length > 0)
const [first, second, hidden] = anthropic.map((m) => m.id) as [AgentModel, AgentModel, AgentModel]
const level = anthropic[1]!.efforts.at(-1) as AgentEffort
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

  test("a legacy default pick uses the first supported level", () => {
    const { effort } = resolveAgentChoice({ ...base, pickedEffort: "default", lastRun: { model: second, effort: level } })
    expect(effort).toBe(anthropic[1]!.efforts[0])
  })

  test("a run on the default level does not inherit the device's level", () => {
    const { effort } = resolveAgentChoice({ ...base, lastRun: { model: second, effort: null }, defaultEffort: level })
    expect(effort).toBe(anthropic[1]!.efforts[0])
  })

  test("older runs without a recorded level retain the device default", () => {
    const { effort } = resolveAgentChoice({ ...base, lastRun: { model: second }, defaultEffort: level })
    expect(effort).toBe(level)
  })

  test("a last run on the box default falls to the device's model and keeps its own level", () => {
    const run = resolveAgentChoice({ ...base, lastRun: { effort: null }, defaultModel: second, defaultEffort: level })
    expect(run.model?.id).toBe(second)
    expect(run.effort).toBe(anthropic[1]!.efforts[0])
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

describe("threadChoiceRun", () => {
  const github = { id: "github", title: "GitHub" }
  const typed = (runId: string, createdAt: string) => ({ role: "user", runId, createdAt })
  const woken = (runId: string, createdAt: string) => ({ ...typed(runId, createdAt), fromThread: github })

  test("a run another thread or GitHub woke does not change the thread's choice", () => {
    const runs = [{ id: "a", model: second, effort: level }, { id: "b", model: first, effort: null }]
    expect(threadChoiceRun(runs, [typed("a", "1"), woken("b", "2")])?.id).toBe("a")
  })

  test("a run that recorded no model does not change the thread's choice", () => {
    const runs = [{ id: "a", model: second }, { id: "b" }]
    expect(threadChoiceRun(runs, [typed("a", "1"), typed("b", "2")])?.id).toBe("a")
  })

  test("the user's next message takes over from a woken run", () => {
    const runs = [{ id: "a", model: second }, { id: "b", model: first }, { id: "c", model: hidden }]
    expect(threadChoiceRun(runs, [typed("a", "1"), woken("b", "2"), typed("c", "3")])?.id).toBe("c")
  })

  test("mail reaching a run the user started leaves that run counting", () => {
    const runs = [{ id: "a", model: second }, { id: "b", model: first }]
    expect(threadChoiceRun(runs, [woken("b", "3"), typed("a", "1"), typed("b", "2")])?.id).toBe("b")
  })

  test("a delegated thread's assignment counts as its first run", () => {
    const runs = [{ id: "a", model: second }, { id: "b", model: first }]
    expect(threadChoiceRun(runs, [woken("a", "1"), woken("b", "2")])?.id).toBe("a")
  })

  test("a thread with no run that recorded a model has no choice to restore", () => {
    expect(threadChoiceRun([{ id: "a" }], [typed("a", "1")])).toBeUndefined()
    expect(threadChoiceRun([], [])).toBeUndefined()
  })
})
