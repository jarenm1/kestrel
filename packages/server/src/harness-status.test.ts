import { describe, expect, test } from "bun:test"
import type { HarnessProbe } from "./capabilities"
import { harnessBinary, harnessStatuses } from "./harness-status"

/** A box with these binaries on its PATH, each printing `versions[name]` for `--version`. */
const installed = (versions: Record<string, string> = {}): HarnessProbe => ({
  which: (name) => (name in versions ? `/bin/${name}` : null),
  version: (path) => versions[path.slice("/bin/".length)] ?? "",
})

const commands = {
  anthropic: "claude -p",
  openai: "codex app-server",
  openrouter: "claude -p",
  zai: "claude -p",
  deepseek: "claude -p",
  minimax: "claude -p",
  opencode: `OPENCODE_CONFIG_CONTENT='{"share": "disabled", "update": "disable"}' opencode acp`,
  google: 'agy acp --gemini-dir "${AGY_GEMINI_DIR:-$HOME/.gemini}" --dangerously-skip-permissions --disable-telemetry',
  omp: "omp acp",
  pi: "pi-acp",
  hermes: "'/opt/hermes/bin/hermes' acp",
}

const box = { agentCommands: commands, fakeAgent: false, sandboxPath: null }

describe("harnessBinary", () => {
  test("takes the command's first shell word, skipping env assignments and quoting", () => {
    expect(harnessBinary("omp acp")).toBe("omp")
    expect(harnessBinary("CLOUDAGENTS_X=1 'omp acp'")).toBe("omp acp")
    expect(harnessBinary("'/opt/hermes/bin/hermes' acp")).toBe("/opt/hermes/bin/hermes")
    // An assignment's value may be quoted and contain spaces (OpenCode's JSON config).
    expect(harnessBinary(commands.opencode)).toBe("opencode")
    expect(harnessBinary("FOO='a b' BAR=2 claude -p")).toBe("claude")
    expect(harnessBinary("   ")).toBeNull()
  })
})

describe("harnessStatuses", () => {
  test("reports each standalone harness as the box finds it", () => {
    const statuses = harnessStatuses(box, installed({ omp: "", "pi-acp": "", opencode: "opencode v2.0.6" }))
    expect(statuses.map((s) => s.harness)).toEqual(["opencode", "omp", "pi", "hermes"])
    expect(statuses.find((s) => s.harness === "opencode")).toEqual({ harness: "opencode", available: true })
    expect(statuses.find((s) => s.harness === "omp")).toEqual({ harness: "omp", available: true })
    expect(statuses.find((s) => s.harness === "pi")).toEqual({ harness: "pi", available: true })
    const hermes = statuses.find((s) => s.harness === "hermes")
    expect(hermes?.available).toBe(false)
    expect(hermes?.error).toContain("not installed")
  })

  test("a harness whose command names a missing binary is unavailable, never offered", () => {
    const statuses = harnessStatuses(box, installed())
    expect(statuses.every((s) => !s.available)).toBe(true)
  })

  test("OpenCode is offered only from version 2; a broken shim is not trusted", () => {
    const statuses = (version: string) => harnessStatuses(box, installed({ opencode: version }))
    expect(statuses("opencode v2.0.6")[0]).toEqual({ harness: "opencode", available: true })
    for (const version of ["1.19.5", "error: could not create process", ""]) {
      const opencode = statuses(version)[0]
      expect(opencode?.available).toBe(false)
      expect(opencode?.error).toContain("version 2.0")
    }
  })

  test("the fake agent cannot run an ACP harness, so none is reported available", () => {
    // Its scripted CLI config replaces every command, including the harnesses'.
    const fake = { ...commands, opencode: "bun fake-agent.ts", omp: "bun fake-agent.ts", pi: "bun fake-agent.ts", hermes: "bun fake-agent.ts" }
    const statuses = harnessStatuses({ ...box, agentCommands: fake, fakeAgent: true }, installed({ bun: "", opencode: "2.0.6" }))
    expect(statuses.every((s) => !s.available)).toBe(true)
    expect(statuses[0]?.error).toContain("fake agent")
  })
})
