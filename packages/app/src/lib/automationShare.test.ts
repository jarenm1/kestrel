import { describe, expect, test } from "bun:test"
import type { Automation } from "@cloudagents/protocol"
import {
  AUTOMATION_IMPORT_PATH,
  AUTOMATION_SHARE_PARAM,
  automationImportUrl,
  encodeAutomationShare,
  parseAutomationShare,
} from "./automationShare"

const automation: Automation = {
  id: "automation-1",
  name: "Review pull requests",
  repo: "acme/app",
  prompt: "Review the pull request and report only real bugs.\n\nKeep it short — no style nits 🕵️",
  model: null,
  enabled: true,
  trigger: { _tag: "schedule", cron: "0 9 * * 1-5", timezone: "America/New_York" },
  createdAt: "2026-10-01T12:00:00.000Z",
  updatedAt: "2026-10-02T12:00:00.000Z",
  nextRunAt: "2026-11-09T14:00:00.000Z",
}

describe("automation share links", () => {
  test("round-trips every portable field, including non-ASCII prompts", () => {
    expect(parseAutomationShare(decodeURIComponent(encodeAutomationShare(automation)))).toEqual({
      version: 1,
      name: automation.name,
      repo: automation.repo,
      prompt: automation.prompt,
      model: null,
      trigger: automation.trigger,
    })
  })

  test("keeps a GitHub trigger's filters", () => {
    const github: Automation = {
      ...automation,
      trigger: {
        _tag: "github",
        events: ["pull_request.opened", "pull_request.review_requested"],
        reviewers: ["alice"],
        baseBranches: ["main"],
        includeDrafts: false,
      },
    }
    expect(parseAutomationShare(decodeURIComponent(encodeAutomationShare(github)))?.trigger).toEqual(github.trigger)
  })

  test("builds an app-relative import link with the payload in the query", () => {
    const url = new URL(automationImportUrl("https://app.kestrel-agent.com", automation))
    expect(url.origin).toBe("https://app.kestrel-agent.com")
    expect(url.pathname).toBe(AUTOMATION_IMPORT_PATH)
    expect(parseAutomationShare(url.searchParams.get(AUTOMATION_SHARE_PARAM))?.name).toBe(automation.name)
  })

  test("rejects missing, malformed and unsupported payloads instead of importing them", () => {
    expect(parseAutomationShare(null)).toBeNull()
    expect(parseAutomationShare("")).toBeNull()
    expect(parseAutomationShare("not json")).toBeNull()
    expect(parseAutomationShare(JSON.stringify({ ...automation, version: 2 }))).toBeNull()
    expect(parseAutomationShare(JSON.stringify({ ...automation, repo: "not a repo" }))).toBeNull()
    expect(parseAutomationShare(JSON.stringify({ ...automation, trigger: { _tag: "github", events: [] } }))).toBeNull()
  })
})
