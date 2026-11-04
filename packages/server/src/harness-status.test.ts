import { describe, expect, test } from "bun:test"
import { harnessAvailability, harnessBinary, type HarnessProbe } from "./capabilities"
import { harnessStatuses } from "./harness-status"

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
  moonshot: "claude -p",
  opencode: `OPENCODE_CONFIG_CONTENT='{"share": "disabled", "update": "disable"}' opencode acp`,
  "opencode-go": "opencode acp",
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

  test("a configured command path is the binary the box probes, not the default name", () => {
    const probes: string[] = []
    const probe: HarnessProbe = {
      which: (name) => {
        probes.push(name)
        return name === "/opt/opencode/bin/opencode" ? name : null
      },
      version: () => "opencode 2.1.0",
    }
    const statuses = harnessStatuses(
      { ...box, agentCommands: { ...commands, opencode: "'/opt/opencode/bin/opencode' acp" } },
      probe,
    )
    expect(statuses.find((s) => s.harness === "opencode")).toEqual({ harness: "opencode", available: true })
    expect(probes).toContain("/opt/opencode/bin/opencode")
    expect(probes).not.toContain("opencode")
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

  test("the fake agent plays OpenCode, but none of the other standalone harnesses", () => {
    // Its scripted CLI config replaces every command; only OpenCode's ACP is played.
    const fake = { ...commands, opencode: "bun fake-agent.ts", omp: "bun fake-agent.ts", pi: "bun fake-agent.ts", hermes: "bun fake-agent.ts" }
    const statuses = harnessStatuses({ ...box, agentCommands: fake, fakeAgent: true }, installed({ bun: "", opencode: "2.0.6" }))
    expect(statuses.find((s) => s.harness === "opencode")).toEqual({ harness: "opencode", available: true })
    for (const status of statuses.filter((s) => s.harness !== "opencode")) {
      expect(status.available).toBe(false)
      expect(status.error).toContain("fake agent")
    }
  })
})

describe("harnessAvailability", () => {
  test("the fake agent offers OpenCode and Go without probing a binary it does not use", () => {
    const untouched: HarnessProbe = {
      which: () => {
        throw new Error("the fake agent must not probe a binary")
      },
      version: () => {
        throw new Error("the fake agent must not probe a binary")
      },
    }
    expect(harnessAvailability("opencode", { fakeAgent: true }, untouched)).toEqual({ available: true })
    expect(harnessAvailability("opencode-go", { fakeAgent: true }, untouched)).toEqual({ available: true })
    expect(harnessAvailability("omp", { fakeAgent: true }, untouched).available).toBe(false)
  })

  test("OpenCode Go needs OpenCode 2.1 even though it is not a standalone harness", () => {
    const check = (version: string) => {
      const probes: string[] = []
      const probe: HarnessProbe = {
        which: (name) => {
          probes.push(name)
          return "/bin/opencode"
        },
        version: () => version,
      }
      return { availability: harnessAvailability("opencode-go", box, probe), probes }
    }
    expect(check("opencode 2.0.6").availability).toEqual({
      available: false,
      error: "its CLI (opencode) must be version 2.1 or newer",
    })
    expect(check("opencode 2.1.0").availability).toEqual({ available: true })
    // Only the requested provider's harness is probed; a spawn never runs all four standalone probes.
    expect(check("opencode 2.1.0").probes).toEqual(["opencode"])
  })
})
