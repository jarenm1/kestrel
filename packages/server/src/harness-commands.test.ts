import { describe, expect, test } from "bun:test"
import { parseClaudeCommands, parseCodexSkills } from "./harness-commands"

describe("parseClaudeCommands", () => {
  test("normalizes the CLI's command metadata and drops unusable rows", () => {
    expect(
      parseClaudeCommands([
        { name: "/review", description: "Review a pull request\n(bundled)", argumentHint: "[pr]" },
        { name: "review", description: "duplicate" },
        { name: "bad name", description: "not one token" },
        { name: "", description: "empty" },
        { name: "plain", description: "No hint (user)", argumentHint: "" },
        null,
        "not a command",
      ]),
    ).toEqual([
      { name: "review", description: "Review a pull request", argumentHint: "[pr]" },
      { name: "plain", description: "No hint" },
    ])
  })

  test("is empty for a payload that is not a command list", () => {
    expect(parseClaudeCommands(undefined)).toEqual([])
    expect(parseClaudeCommands({ commands: [] })).toEqual([])
  })
})

describe("parseCodexSkills", () => {
  test("keeps enabled skills, dedupes by name and never exposes paths", () => {
    expect(
      parseCodexSkills({
        data: [
          {
            cwd: "/secret/workspace",
            skills: [
              { name: "grilling", description: "Grill a plan", path: "/home/me/.agents/skills/grilling/SKILL.md", enabled: true },
              { name: "grilling", description: "duplicate" },
              { name: "disabled", description: "not available", path: "/secret", enabled: false },
              { name: "../escape", description: "bad name", enabled: true },
            ],
          },
        ],
      }),
    ).toEqual([{ name: "grilling", description: "Grill a plan" }])
    expect(JSON.stringify(parseCodexSkills({ data: [{ skills: [{ name: "x", description: "y", path: "/secret" }] }] }))).not.toContain(
      "/secret",
    )
  })

  test("is empty for malformed data", () => {
    expect(parseCodexSkills({ data: "nope" })).toEqual([])
    expect(parseCodexSkills(null)).toEqual([])
  })
})
