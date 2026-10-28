import { describe, expect, test } from "bun:test"
import type { AutomationTrigger } from "@cloudagents/protocol"
import { triggerProblem } from "./automation-rules"

const NOW = Date.UTC(2026, 0, 1)
const schedule: AutomationTrigger = { _tag: "schedule", cron: "0 9 * * *", timezone: "UTC" }
const github: AutomationTrigger = { _tag: "github", events: ["pull_request.opened"] }

describe("triggerProblem", () => {
  test("a schedule needs no repository", () => {
    expect(triggerProblem(schedule, null, NOW)).toBeNull()
    expect(triggerProblem(schedule, "acme/app", NOW)).toBeNull()
  })

  test("a schedule with a bad cron is refused", () => {
    expect(triggerProblem({ _tag: "schedule", cron: "not a cron", timezone: "UTC" }, null, NOW)).not.toBeNull()
  })

  test("a GitHub trigger needs a repository", () => {
    expect(triggerProblem(github, null, NOW)).toBe("GitHub triggers need a GitHub repository")
    expect(triggerProblem(github, "acme/app", NOW)).toBeNull()
  })
})
