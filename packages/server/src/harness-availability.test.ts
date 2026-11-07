import { expect, test } from "bun:test"
import { availableHarnesses, availableModelHarnesses, type HarnessProbe } from "./capabilities"

const probe = (installed: Record<string, string>): HarnessProbe => ({
  which: (name) => (name in installed ? `/bin/${name}` : null),
  version: (path) => installed[path.slice("/bin/".length)] ?? "",
})

const box = { fakeAgent: false, sandboxPath: null }

test("a box offers only the harnesses it has, OpenCode only once its Console sign-in exists", () => {
  // The Anthropic-compatible gateways run through Claude Code, so having `claude` offers them too.
  expect(availableHarnesses(box, probe({ claude: "2.1.318 (Claude Code)", codex: "codex-cli 0.166.0" }))).toEqual([
    "anthropic",
    "openai",
    "openrouter",
    "zai",
    "deepseek",
    "minimax",
    "moonshot",
  ])
  expect(availableHarnesses(box, probe({ opencode: "opencode v2.0.7" }))).toEqual(["opencode"])
  // 2.0.6 has `auth login` but no `opencode` Console integration for the free models.
  expect(availableHarnesses(box, probe({ opencode: "opencode v2.0.6" }))).toEqual([])
  expect(availableHarnesses(box, probe({ opencode: "1.19.5" }))).toEqual([])
  // A binary that runs but does not say its version (a broken shim) cannot be trusted to be OpenCode 2.
  expect(availableHarnesses(box, probe({ opencode: "error: could not create process" }))).toEqual([])
  expect(availableHarnesses(box, probe({ agy: "1.5.0" }))).toEqual(["google"])
  // agy before 1.5 cannot sign in from a terminal.
  expect(availableHarnesses(box, probe({ agy: "1.4.12" }))).toEqual([])
})

test("OpenCode 2.1 adds the Go plan", () => {
  expect(availableHarnesses(box, probe({ opencode: "opencode v2.1.0" }))).toEqual(["opencode", "opencode-go"])
  // The Go plan shares OpenCode's binary but needs 2.1; 2.0 offers only free OpenCode, once its Console sign-in exists.
  expect(availableHarnesses(box, probe({ opencode: "opencode v2.0.7" }))).toEqual(["opencode"])
  expect(availableHarnesses(box, probe({ opencode: "opencode v2.0.6" }))).toEqual([])
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
  // The scripted agent speaks Claude stream-json, Codex app-server and ACP, so it plays every provider; routed
  // gateway models carry CLOUDAGENTS_HARNESS so the script picks the right protocol.
  expect(availableHarnesses({ fakeAgent: true, sandboxPath: null }, probe({}))).toEqual([
    "anthropic",
    "openai",
    "openrouter",
    "zai",
    "deepseek",
    "minimax",
    "moonshot",
    "opencode",
    "opencode-go",
    "google",
  ])
})

test("route harnesses need their own CLI and OpenCode route minimum", () => {
  expect(availableModelHarnesses(box, probe({ claude: "2.1.318 (Claude Code)", codex: "codex-cli 0.166.0" }))).toEqual([
    "claude",
    "codex",
  ])
  // Native free OpenCode 2.0.7 is enough for its own models, but API-provider routes need 2.1.
  expect(availableModelHarnesses(box, probe({ opencode: "opencode v2.0.7" }))).toEqual([])
  expect(availableModelHarnesses(box, probe({ opencode: "opencode v2.1.0" }))).toEqual(["opencode"])
  expect(availableModelHarnesses(box, probe({ agy: "1.5.0" }))).toEqual(["antigravity"])
  expect(availableModelHarnesses({ fakeAgent: true, sandboxPath: null }, probe({}))).toEqual([
    "claude",
    "codex",
    "opencode",
    "antigravity",
  ])
})
