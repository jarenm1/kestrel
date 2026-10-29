import { describe, expect, test } from "bun:test"
import type { Run } from "@cloudagents/protocol"
import { commandProvider } from "./command-provider"

const run = (provider?: "anthropic" | "openai"): Run => ({
  id: "run-1",
  taskId: "task-1",
  prompt: "hello",
  status: "running",
  startedAt: "2026-01-01T00:00:00.000Z",
  endedAt: null,
  exitCode: null,
  ...(provider === undefined ? {} : { provider }),
})

describe("commandProvider", () => {
  test("uses the running run's provider before its session exists", () => {
    expect(commandProvider(run("openai"), undefined, "claude-opus-4-5")).toBe("openai")
  })

  test("keeps the running run's recorded session when the run itself predates the field", () => {
    expect(commandProvider(run(), { provider: "anthropic" }, "gpt-6-sol")).toBe("anthropic")
  })

  test("uses the chosen model while no run is active", () => {
    expect(commandProvider(undefined, { provider: "anthropic" }, "gpt-6-sol")).toBe("openai")
  })
})
