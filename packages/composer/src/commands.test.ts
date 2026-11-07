import { describe, expect, test } from "bun:test"
import type { HarnessCommand } from "@cloudagents/protocol"
import {
  appCommandOfHarness,
  commandPrefixForHarness,
  matchAppCommand,
  withAppCommandsForHarness,
} from "./commands"

describe("app-command precedence", () => {
  test("shadows the harness slash action without hiding a same-named Codex skill", () => {
    const harness: readonly HarnessCommand[] = [
      { name: "USAGE", description: "Harness usage", prefix: "/" },
      { name: "usage", description: "A project skill", prefix: "$" },
      { name: "compact", description: "Summarize context", prefix: "/" },
    ]
    const commands = withAppCommandsForHarness(harness, "codex")
    expect(commands.map((command) => [command.prefix, command.name])).toEqual([
      ["/", "usage"], ["$", "usage"], ["/", "compact"],
    ])
    expect(appCommandOfHarness(harness[0]!, "codex")?.name).toBe("usage")
    expect(appCommandOfHarness(harness[1]!, "codex")).toBeUndefined()
    expect(appCommandOfHarness(harness[2]!, "codex")).toBeUndefined()
  })

  test("uses each harness's implicit invocation prefix for an unprefixed command", () => {
    const legacy = { name: "usage", description: "Legacy command" }
    expect(appCommandOfHarness(legacy, "claude")?.name).toBe("usage")
    expect(appCommandOfHarness(legacy, "opencode")?.name).toBe("usage")
    expect(appCommandOfHarness(legacy, "codex")).toBeUndefined()
    expect(withAppCommandsForHarness([legacy], "claude").map((command) => `${commandPrefixForHarness(command, "claude")}${command.name}`)).toEqual(["/usage"])
    expect(withAppCommandsForHarness([legacy], "codex").map((command) => `${commandPrefixForHarness(command, "codex")}${command.name}`)).toEqual(["/usage", "$usage"])
  })

  test("uses the actual harness for a route, not its credential provider", () => {
    const commands: readonly HarnessCommand[] = [
      { name: "usage", description: "A command" },
      { name: "usage", description: "A skill", prefix: "$" },
    ]
    expect(commandPrefixForHarness(commands[0]!, "codex")).toBe("$")
    expect(commandPrefixForHarness(commands[0]!, "opencode")).toBe("/")
    expect(appCommandOfHarness(commands[0]!, "codex")).toBeUndefined()
    expect(appCommandOfHarness(commands[0]!, "opencode")?.name).toBe("usage")
    expect(
      withAppCommandsForHarness(commands, "codex").map((command) => [
        commandPrefixForHarness(command, "codex"),
        command.name,
      ]),
    ).toEqual([
      ["/", "usage"], ["$", "usage"], ["$", "usage"],
    ])
  })
})

describe("submitted app commands", () => {
  test("consumes a case-insensitive command and gap, preserving the rest of a rich draft", () => {
    const rest = "Review [PR #7](https://github.com/acme/repo/pull/7)\nthen report"
    const draft = ` \n/UsAgE\t \n${rest}`
    const match = matchAppCommand(draft)
    expect(match?.command.name).toBe("usage")
    expect(draft.slice(match!.consumed)).toBe(rest)
    expect(matchAppCommand("/usage")?.consumed).toBe(6)
    expect(matchAppCommand("/usage \n")?.consumed).toBe(8)
  })

  test("does not execute partial names, punctuation suffixes, skills, or mentions in ordinary messages", () => {
    for (const text of ["/us", "/usage-report", "/usage?", "/usage.json", "$usage", "check /usage", "//usage", ""]) {
      expect(matchAppCommand(text)).toBeUndefined()
    }
  })
})

describe("live app-command selection", () => {
  test("consumes a selected prefix while retaining newly typed text and reference Markdown", () => {
    const remainder = "latest text [PR #7](https://github.com/acme/repo/pull/7)"
    const liveDraft = `/u \n${remainder}`
    const match = matchAppCommand(liveDraft, "usage")
    expect(match?.command.name).toBe("usage")
    expect(liveDraft.slice(match!.consumed)).toBe(remainder)
    expect(matchAppCommand("/", "usage")?.consumed).toBe(1)
    expect(matchAppCommand("/UsAgE", "usage")?.consumed).toBe(6)
  })

  test("does not consume a changed live token just because an old usage suggestion was tapped", () => {
    for (const draft of ["/compact latest text", "/usage-report", "$usage", "ordinary text"]) {
      expect(matchAppCommand(draft, "usage")).toBeUndefined()
    }
  })
})
