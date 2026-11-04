import { expect, test } from "bun:test"
import { availableHarnesses, type HarnessProbe } from "./capabilities"

const probe = (installed: Record<string, string>): HarnessProbe => ({
  which: (name) => (name in installed ? `/bin/${name}` : null),
  version: (path) => installed[path.slice("/bin/".length)] ?? "",
})

const box = { fakeAgent: false, sandboxPath: null }

test("a box offers only the harnesses it has, OpenCode only from version 2", () => {
  expect(availableHarnesses(box, probe({ claude: "2.1.318 (Claude Code)", codex: "codex-cli 0.166.0" }))).toEqual(["anthropic", "openai"])
  expect(availableHarnesses(box, probe({ opencode: "opencode v2.0.6" }))).toEqual(["opencode"])
  expect(availableHarnesses(box, probe({ opencode: "1.19.5" }))).toEqual([])
  // A binary that runs but does not say its version (a broken shim) cannot be trusted to be OpenCode 2.
  expect(availableHarnesses(box, probe({ opencode: "error: could not create process" }))).toEqual([])
})

test("a fake-agent box plays every harness itself", () => {
  expect(availableHarnesses({ fakeAgent: true, sandboxPath: null }, probe({}))).toEqual(["anthropic", "openai", "opencode"])
})
