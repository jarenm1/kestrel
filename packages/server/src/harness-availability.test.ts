import { expect, test } from "bun:test"
import { availableHarnesses, harnessAvailability, type HarnessProbe } from "./capabilities"

const probe = (installed: Record<string, string>): HarnessProbe => ({
  which: (name) => (name in installed ? `/bin/${name}` : null),
  version: (path) => installed[path.slice("/bin/".length)] ?? "",
})

const box = { fakeAgent: false, sandboxPath: null }

test("a box offers only the harnesses it has, OpenCode only from version 2", () => {
  // The Anthropic-compatible gateways run through Claude Code, so having `claude` offers them too.
  expect(availableHarnesses(box, probe({ claude: "2.1.318 (Claude Code)", codex: "codex-cli 0.166.0" }))).toEqual([
    "anthropic",
    "openai",
    "openrouter",
    "zai",
    "deepseek",
    "minimax",
    "moonshot",
    "deepinfra",
  ])
  expect(availableHarnesses(box, probe({ opencode: "opencode v2.0.6" }))).toEqual(["opencode"])
  expect(availableHarnesses(box, probe({ opencode: "1.19.5" }))).toEqual([])
  // A binary that runs but does not say its version (a broken shim) cannot be trusted to be OpenCode 2.
  expect(availableHarnesses(box, probe({ opencode: "error: could not create process" }))).toEqual([])
  expect(availableHarnesses(box, probe({ agy: "1.5.0" }))).toEqual(["google"])
  // agy before 1.5 cannot sign in from a terminal.
  expect(availableHarnesses(box, probe({ agy: "1.4.12" }))).toEqual([])
})

test("OpenCode 2.1 adds the Go plan", () => {
  expect(availableHarnesses(box, probe({ opencode: "opencode v2.1.0" }))).toEqual(["opencode", "opencode-go"])
  // The Go plan shares OpenCode's binary but needs 2.1; 2.0 offers only free OpenCode.
  expect(availableHarnesses(box, probe({ opencode: "opencode v2.0.6" }))).toEqual(["opencode"])
})

test("a configured command's own binary is what the box offers", () => {
  const seen: string[] = []
  const custom: HarnessProbe = {
    which: (name) => {
      seen.push(name)
      return name === "/opt/opencode/bin/opencode" ? name : null
    },
    version: () => "opencode 2.1.0",
  }
  const config = {
    fakeAgent: false,
    sandboxPath: null,
    agentCommands: {
      opencode: "'/opt/opencode/bin/opencode' acp",
      "opencode-go": `OPENCODE_CONFIG_CONTENT='{"share":"disabled"}' '/opt/opencode/bin/opencode' acp`,
    },
  }
  expect(availableHarnesses(config, custom)).toEqual(["opencode", "opencode-go"])
  expect(seen.filter((name) => name === "/opt/opencode/bin/opencode")).toHaveLength(2)
  expect(seen).not.toContain("opencode")
})

test("a fake-agent box plays every harness itself", () => {
  // The scripted agent speaks Claude stream-json, Codex app-server and ACP, so it plays every remaining provider.
  expect(availableHarnesses({ fakeAgent: true, sandboxPath: null }, probe({}))).toEqual([
    "anthropic",
    "openai",
    "opencode",
    "opencode-go",
    "google",
  ])
})

test("standalone ACP harnesses are offered by their own binary", () => {
  expect(availableHarnesses(box, probe({ omp: "omp 18.12.6" }))).toEqual(["omp"])
  // Pi needs its adapter and the agent it starts; either alone cannot run a turn.
  expect(availableHarnesses(box, probe({ "pi-acp": "pi-acp 0.0.34", pi: "0.0.34" }))).toEqual(["pi"])
  expect(availableHarnesses(box, probe({ hermes: "hermes 0.8.0" }))).toEqual(["hermes"])
  expect(availableHarnesses(box, probe({ omp: "omp 18.12.6", "pi-acp": "pi-acp 0.0.34", pi: "0.0.34", hermes: "hermes 0.8.0" }))).toEqual([
    "omp", "pi", "hermes",
  ])
})

test("a missing standalone harness names its install command", () => {
  expect(harnessAvailability("pi", box, probe({}))).toEqual({
    available: false,
    error: "its CLI (pi-acp) is not installed on this box; install it with: npm install -g @earendil-works/pi-coding-agent pi-acp",
  })
  expect(harnessAvailability("omp", box, probe({}))).toEqual({
    available: false,
    error: "its CLI (omp) is not installed on this box; install it with: curl -fsSL https://omp.sh/install | sh",
  })
})

test("Pi's adapter is not enough without the pi agent it starts", () => {
  expect(availableHarnesses(box, probe({ "pi-acp": "pi-acp 0.0.34" }))).toEqual([])
  expect(harnessAvailability("pi", box, probe({ "pi-acp": "pi-acp 0.0.34" }))).toEqual({
    available: false,
    error: "its CLI (pi-acp) needs pi, which is not installed on this box; install it with: npm install -g @earendil-works/pi-coding-agent pi-acp",
  })
})
