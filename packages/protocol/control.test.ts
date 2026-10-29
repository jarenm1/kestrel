import { describe, expect, test } from "bun:test"
import { Schema } from "effect"
import { Automation, UpdateAutomationBody } from "./src/control"

const legacyAutomation = {
  id: "daily",
  name: "Daily summary",
  repo: null,
  prompt: "Summarize the day",
  enabled: true,
  trigger: { _tag: "schedule", cron: "0 9 * * *", timezone: "UTC" },
  createdAt: "2026-10-28T00:00:00.000Z",
  updatedAt: "2026-10-28T00:00:00.000Z",
  nextRunAt: "2026-10-29T09:00:00.000Z",
}

const decodeList = Schema.decodeUnknownSync(Schema.Array(Automation))

describe("automation model response compatibility", () => {
  test("legacy automation lists decode to the box default without changing other fields", () => {
    expect(decodeList([legacyAutomation])).toEqual([{ ...legacyAutomation, model: null }])
  })

  test("explicit selections and the explicit box default survive decoding", () => {
    expect(decodeList([
      { ...legacyAutomation, model: "gpt-6.1-sol" },
      { ...legacyAutomation, id: "default", model: null },
    ]).map((automation) => automation.model)).toEqual(["gpt-6.1-sol", null])
  })

  test("invalid model IDs are rejected rather than replaced with the default", () => {
    expect(() => decodeList([{ ...legacyAutomation, model: "unknown-model" }])).toThrow()
  })

  test("omitting a model in an update remains distinct from resetting it", () => {
    const decodeUpdate = Schema.decodeUnknownSync(UpdateAutomationBody)
    expect(decodeUpdate({ enabled: false })).toEqual({ enabled: false })
    expect(decodeUpdate({ model: null })).toEqual({ model: null })
  })
})
