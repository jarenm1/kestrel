import { describe, expect, test } from "bun:test"
import { limitDiscovery, parseClaudeCommands, parseCodexSkills } from "./harness-commands"

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
      { name: "review", description: "Review a pull request", argumentHint: "[pr]", prefix: "/" },
      { name: "plain", description: "No hint", prefix: "/" },
    ])
  })

  test("is empty for a payload that is not a command list", () => {
    expect(parseClaudeCommands(undefined)).toEqual([])
    expect(parseClaudeCommands({ commands: [] })).toEqual([])
  })
})

describe("limitDiscovery", () => {
  test("runs four children at once, queues the rest, and rejects once the queue is full", async () => {
    const total = 36
    const begun = Array.from({ length: total }, () => Promise.withResolvers<void>())
    const finished = Array.from({ length: total }, () => Promise.withResolvers<number>())
    let started = 0
    let running = 0
    let peak = 0
    const start = () => {
      const index = started++
      running++
      peak = Math.max(peak, running)
      begun[index]!.resolve()
      return finished[index]!.promise.finally(() => {
        running--
      })
    }

    // 4 running + 32 queued fills the limiter; the 37th request is refused instead of growing the queue.
    const admitted = Array.from({ length: total }, () => limitDiscovery(start))
    await expect(limitDiscovery(start)).rejects.toThrow("command discovery is busy")

    for (let index = 0; index < total; index++) {
      await begun[index]!.promise
      finished[index]!.resolve(1)
    }
    expect(await Promise.all(admitted)).toEqual(Array.from({ length: total }, () => 1))
    expect(peak).toBe(4)
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
    ).toEqual([{ name: "grilling", description: "Grill a plan", prefix: "$" }])
    expect(JSON.stringify(parseCodexSkills({ data: [{ skills: [{ name: "x", description: "y", path: "/secret" }] }] }))).not.toContain(
      "/secret",
    )
  })

  test("is empty for malformed data", () => {
    expect(parseCodexSkills({ data: "nope" })).toEqual([])
    expect(parseCodexSkills(null)).toEqual([])
  })
})
