import { describe, expect, test } from "bun:test"
import {
  AGENT_MODELS,
  HARNESS_IDS,
  connectedModelProviders,
  harnessIdOfModel,
  harnessIdOfProvider,
  modelInfo,
  providersForHarness,
  resolveModelRoute,
  type ConnectionState,
} from "@cloudagents/protocol"

/** A Connections row, connected and enabled unless the test says otherwise. */
const row = (provider: string, extra: Partial<ConnectionState> = {}): ConnectionState => ({
  provider,
  connected: true,
  ...extra,
})

const anthropic = row("anthropic")
const openai = row("openai")

describe("harness routing", () => {
  test("a model is scoped to its own harness; another harness never claims it by catalog order", () => {
    // OMP, Pi and Hermes each offer a "DeepSeek Flash" entry; only the model id's own harness runs it.
    expect(harnessIdOfModel("omp-deepseek-flash")).toBe("omp")
    expect(harnessIdOfModel("pi-deepseek-flash")).toBe("pi")
    expect(harnessIdOfModel("hermes-deepseek-flash")).toBe("hermes")
    const scoped = resolveModelRoute({
      harnessId: "pi",
      modelId: "pi-deepseek-pro",
      connections: [row("omp"), row("pi")],
    })
    if (!scoped.ok) throw new Error(scoped.message)
    expect(scoped.route.provider).toBe("pi")
    expect(scoped.route.connectionId).toBe("pi")
    expect(scoped.route.acpModel).toBe("deepseek/deepseek-v4-pro")
  })

  test("a model from another harness is a mismatch, never a hidden fallback", () => {
    const result = resolveModelRoute({ harnessId: "omp", modelId: "claude-opus-5-5", connections: [anthropic] })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.code).toBe("harness-mismatch")
    expect(result.message).toContain("OMP")
  })

  test("an unknown harness is rejected instead of resolving on a default", () => {
    const result = resolveModelRoute({
      harnessId: "local-llama" as never,
      modelId: "claude-opus-5-5",
      connections: [anthropic],
    })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.code).toBe("unknown-harness")
  })

  test("a missing or unknown model is an explicit failure", () => {
    const missing = resolveModelRoute({ harnessId: "claude", modelId: undefined, connections: [anthropic] })
    expect(missing.ok).toBe(false)
    if (!missing.ok) expect(missing.code).toBe("missing-model")

    const unknown = resolveModelRoute({ harnessId: "claude", modelId: "no-such-model", connections: [anthropic] })
    expect(unknown.ok).toBe(false)
    if (!unknown.ok) {
      expect(unknown.code).toBe("missing-model")
      expect(unknown.message).toContain("catalog")
    }
  })

  test("the thread's harness picks the connection when a provider has both a key and a CLI login", () => {
    const result = resolveModelRoute({
      harnessId: "codex",
      modelId: "gpt-6-astra",
      connections: [anthropic, openai, row("codex-cli")],
    })
    if (!result.ok) throw new Error(result.message)
    expect(result.route.harness).toBe("codex")
    expect(result.route.connectionId).toBe("openai")
  })
})

describe("connection state gates a route", () => {
  test("a disabled connection refuses the message", () => {
    const result = resolveModelRoute({
      harnessId: "claude",
      modelId: "claude-opus-5-5",
      connections: [row("anthropic", { enabled: false })],
    })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.code).toBe("disabled-connection")
  })

  test("a connection the box cannot serve is unavailable, with its reason", () => {
    const result = resolveModelRoute({
      harnessId: "claude",
      modelId: "claude-opus-5-5",
      connections: [row("anthropic", { available: false, error: "key rejected" })],
    })
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.code).toBe("connection-unavailable")
      expect(result.message).toContain("key rejected")
    }
  })

  test("no connection at all asks for one", () => {
    const result = resolveModelRoute({ harnessId: "claude", modelId: "claude-opus-5-5", connections: [] })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.code).toBe("missing-connection")
  })

  test("a standalone harness the box has not reported is unavailable, not silently offered", () => {
    const result = resolveModelRoute({
      harnessId: "omp",
      modelId: "omp-deepseek-flash",
      connections: [anthropic],
    })
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.code).toBe("connection-unavailable")
      expect(result.message).toContain("OMP")
    }
  })

  test("a standalone harness whose CLI is missing is unavailable, with the box's reason", () => {
    const result = resolveModelRoute({
      harnessId: "hermes",
      modelId: "hermes-deepseek-flash",
      connections: [row("hermes", { connected: false, available: false, error: "its CLI (hermes) is not installed on this box" })],
    })
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.code).toBe("connection-unavailable")
      expect(result.message).toContain("not installed")
    }
  })

  test("a standalone harness the box reports runs on its own connection", () => {
    const result = resolveModelRoute({
      harnessId: "omp",
      modelId: "omp-deepseek-flash",
      connections: [anthropic, row("omp")],
    })
    if (!result.ok) throw new Error(result.message)
    expect(result.route.connectionId).toBe("omp")
    expect(result.route.harness).toBe("omp")
  })
})

describe("connectedModelProviders", () => {
  test("offers only providers with a usable connection", () => {
    const offered = connectedModelProviders([anthropic, row("openai", { enabled: false })])
    expect(offered.map((p) => p.id)).toEqual(["anthropic"])
  })

  test("a standalone harness is offered only when the box reported it", () => {
    expect(connectedModelProviders([anthropic]).map((p) => p.id)).not.toContain("omp")
    expect(connectedModelProviders([anthropic, row("omp")]).map((p) => p.id)).toContain("omp")
    expect(connectedModelProviders([anthropic, row("omp", { available: false })]).map((p) => p.id)).not.toContain("omp")
    expect(connectedModelProviders([anthropic, row("omp", { connected: false })]).map((p) => p.id)).not.toContain("omp")
  })

  test("the enabled harnesses only narrow what is offered", () => {
    const connections = [anthropic, openai, row("omp")]
    const enabled = HARNESS_IDS.filter((id) => id !== "omp")
    expect(connectedModelProviders(connections, enabled).map((p) => p.id)).not.toContain("omp")
    // Disabling a harness never invents one that has no connection.
    expect(connectedModelProviders([row("pi")], HARNESS_IDS).map((p) => p.id)).toEqual(["pi"])
  })
})

describe("catalog", () => {
  test("every model's provider belongs to the harness it reports", () => {
    for (const model of AGENT_MODELS) {
      expect(harnessIdOfProvider(model.provider)).toBe(harnessIdOfModel(model.id))
    }
  })

  test("every harness offers at least one model", () => {
    for (const harness of HARNESS_IDS) expect(providersForHarness(harness).length).toBeGreaterThan(0)
  })

  test("a model id never resolves to a provider the catalog disagrees with", () => {
    for (const model of AGENT_MODELS) expect(modelInfo(model.id).provider).toBe(model.provider)
  })
})
