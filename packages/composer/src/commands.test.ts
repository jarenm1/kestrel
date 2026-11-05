import { describe, expect, test } from "bun:test"
import { harnessCommandPrefix, type HarnessCommand } from "@cloudagents/protocol"
import { appCommandOf, matchAppCommand, withAppCommands } from "./commands"

describe("app-command precedence", () => {
  test("shadows the harness slash action without hiding a same-named Codex skill", () => {
    const harness: readonly HarnessCommand[] = [
      { name: "USAGE", description: "Harness usage", prefix: "/" },
      { name: "usage", description: "A project skill", prefix: "$" },
      { name: "compact", description: "Summarize context", prefix: "/" },
    ]
    const commands = withAppCommands(harness, "openai")
    expect(commands.map((command) => [command.prefix, command.name])).toEqual([
      ["/", "usage"], ["$", "usage"], ["/", "compact"],
    ])
    expect(appCommandOf(harness[0]!, "openai")?.name).toBe("usage")
    expect(appCommandOf(harness[1]!, "openai")).toBeUndefined()
    expect(appCommandOf(harness[2]!, "openai")).toBeUndefined()
  })

  test("respects old boxes' provider-specific implicit invocation prefix", () => {
    const legacy = { name: "usage", description: "Legacy command" }
    expect(appCommandOf(legacy, "anthropic")?.name).toBe("usage")
    expect(appCommandOf(legacy, undefined)?.name).toBe("usage")
    expect(appCommandOf(legacy, "openai")).toBeUndefined()
    expect(withAppCommands([legacy], "anthropic").map((command) => `${harnessCommandPrefix(command, "anthropic")}${command.name}`)).toEqual(["/usage"])
    expect(withAppCommands([legacy], "openai").map((command) => `${harnessCommandPrefix(command, "openai")}${command.name}`)).toEqual(["/usage", "$usage"])
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
