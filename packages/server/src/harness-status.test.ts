import { describe, expect, test } from "bun:test"
import { harnessBinary, harnessStatuses, type HarnessProbe } from "./harness-status"

const installed = (...names: string[]): HarnessProbe => ({
  executable: (name) => names.includes(name),
})

const commands = {
  anthropic: "claude -p",
  openai: "codex app-server",
  omp: "omp acp",
  pi: "pi-acp",
  hermes: "'/opt/hermes/bin/hermes' acp",
}

describe("harnessBinary", () => {
  test("takes the command's first shell word, skipping env assignments and quoting", () => {
    expect(harnessBinary("omp acp")).toBe("omp")
    expect(harnessBinary("CLOUDAGENTS_X=1 'omp acp'")).toBe("omp acp")
    expect(harnessBinary("'/opt/hermes/bin/hermes' acp")).toBe("/opt/hermes/bin/hermes")
    expect(harnessBinary("   ")).toBeNull()
  })
})

describe("harnessStatuses", () => {
  test("reports each standalone harness as the box finds it", () => {
    const statuses = harnessStatuses({ agentCommands: commands, fakeAgent: false }, installed("omp", "pi-acp"))
    expect(statuses.map((s) => s.harness)).toEqual(["omp", "pi", "hermes"])
    expect(statuses.find((s) => s.harness === "omp")).toEqual({ harness: "omp", available: true })
    expect(statuses.find((s) => s.harness === "pi")).toEqual({ harness: "pi", available: true })
    const hermes = statuses.find((s) => s.harness === "hermes")
    expect(hermes?.available).toBe(false)
    expect(hermes?.error).toContain("not installed")
  })

  test("a harness whose command names a missing binary is unavailable, never offered", () => {
    const statuses = harnessStatuses({ agentCommands: commands, fakeAgent: false }, installed())
    expect(statuses.every((s) => !s.available)).toBe(true)
  })

  test("the fake agent cannot run an ACP harness, so none is reported available", () => {
    // Its scripted CLI config replaces every command, including the harnesses'.
    const fake = { ...commands, omp: "bun fake-agent.ts", pi: "bun fake-agent.ts", hermes: "bun fake-agent.ts" }
    const statuses = harnessStatuses({ agentCommands: fake, fakeAgent: true }, installed("bun"))
    expect(statuses.every((s) => !s.available)).toBe(true)
    expect(statuses[0]?.error).toContain("fake agent")
  })
})
