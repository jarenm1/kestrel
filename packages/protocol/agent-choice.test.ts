import { describe, expect, test } from "bun:test"
import { AGENT_MODELS, MODEL_PROVIDERS, connectedModelProviders, resolveAgentChoice, threadChoiceRun, type AgentEffort, type AgentModel } from "./src/models"
import { connectionsForBox, type Connection } from "./src/control"

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

  test("Z.ai preserves Max for unchosen and legacy defaults without overriding deliberate choices", () => {
    const zai = {
      ...base,
      offered: AGENT_MODELS.filter((m) => m.provider === "zai" && !m.harness),
      connected: MODEL_PROVIDERS.filter((p) => p.id === "zai"),
    }
    for (const model of zai.offered) {
      const input = { ...zai, pickedModel: model.id }
      expect(resolveAgentChoice(input).effort).toBe("max")
      expect(resolveAgentChoice({ ...input, pickedEffort: "default", defaultEffort: "low" }).effort).toBe("max")
      expect(resolveAgentChoice({ ...input, lastRun: { model: model.id, effort: null }, defaultEffort: "low" }).effort).toBe("max")
      expect(resolveAgentChoice({ ...input, pickedEffort: "medium" }).effort).toBe("max")
      expect(resolveAgentChoice({ ...input, pickedEffort: "low" }).effort).toBe("low")
      expect(resolveAgentChoice({ ...input, lastRun: { model: model.id, effort: "high" } }).effort).toBe("high")
      expect(resolveAgentChoice({ ...input, defaultEffort: "low" }).effort).toBe("low")
    }
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

describe("selected-box connections", () => {
  const cli = (provider: string, connected: boolean): Connection => ({
    provider, label: provider, kind: "cli", connected, account: null, available: connected,
  })

  test("unavailable connected keys and CLI logins are not offered, but another usable connection still works", () => {
    const rows = [
      { provider: "anthropic", connected: true, available: false },
      { provider: "opencode-go", connected: true, available: false },
      { provider: "openrouter", connected: true, available: true },
    ]
    expect(connectedModelProviders(rows).map((provider) => provider.id)).toEqual(["openrouter"])
    expect(connectedModelProviders([...rows, { provider: "claude-cli", connected: true, available: true }])
      .map((provider) => provider.id)).toEqual(["anthropic", "openrouter"])
    expect(connectedModelProviders([{ provider: "openai", connected: true }])
      .map((provider) => provider.id)).toEqual(["openai"])
  })

  test("the selected box's OpenCode logins replace conflicting relay state across a box switch", () => {
    const relay = [{ ...cli("opencode-go", false), error: "not installed on the managed box" }, cli("opencode", false)]
    const selected = connectionsForBox(relay, {
      cliAuth: [
        { provider: "opencode-go", loggedIn: true, account: null },
        { provider: "opencode", loggedIn: true, account: null },
      ],
      harnesses: ["opencode"],
    })
    expect(connectedModelProviders(selected).map((provider) => provider.id)).toEqual(["opencode", "opencode-go"])
    expect(selected.find((connection) => connection.provider === "opencode-go")?.error).toBeUndefined()

    const switched = connectionsForBox(selected, {
      cliAuth: [{ provider: "opencode-go", loggedIn: false, account: null }],
      harnesses: [],
    })
    expect(connectedModelProviders(switched).map((provider) => provider.id)).toEqual([])
    expect(switched.find((connection) => connection.provider === "opencode")).toMatchObject({ connected: false, available: false })
  })

  test("installation alone never authenticates free OpenCode models", () => {
    const rows = connectionsForBox([cli("opencode", true)], { cliAuth: [], harnesses: ["opencode"] })
    expect(rows.find((connection) => connection.provider === "opencode")).toMatchObject({ connected: false, available: false })
    expect(connectedModelProviders(rows).map((provider) => provider.id)).toEqual([])
  })

  test("retired standalone harness rows never survive the merge", () => {
    const rows = connectionsForBox([cli("omp", true), cli("pi", true), cli("hermes", true), cli("opencode", true)], {
      cliAuth: [],
      harnesses: ["opencode"],
    })
    expect(rows.map((connection) => connection.provider)).toEqual(["opencode"])
    expect(connectedModelProviders(rows).map((provider) => provider.id)).toEqual([])
  })

  test("an unreachable box clears stale CLI availability without discarding stored API keys", () => {
    const key: Connection = { provider: "anthropic", label: "Anthropic", kind: "apikey", connected: true, account: "saved key", available: true }
    const rows = connectionsForBox([key, cli("opencode-go", true), cli("opencode", true)], {
      cliAuth: undefined,
      harnesses: undefined,
      error: "Selected box is offline",
    })
    expect(rows.find((connection) => connection.provider === "anthropic")).toEqual(key)
    expect(rows.find((connection) => connection.provider === "opencode-go")).toMatchObject({
      connected: false, available: false, error: "Selected box is offline",
    })
    expect(connectedModelProviders(rows).map((provider) => provider.id)).toEqual(["anthropic"])
  })
})
