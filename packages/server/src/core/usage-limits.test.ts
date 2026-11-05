import { expect, test } from "bun:test"
import type { ProviderUsage } from "@cloudagents/protocol"
import { isUsageLimitFailure, usageLimitResetAt } from "./usage-limits"

const usage = (windows: ProviderUsage["windows"], status: ProviderUsage["status"] = "ok"): ProviderUsage => ({
  provider: "claude-cli",
  status,
  plan: "Pro",
  windows,
})

const window = (id: string, usedPercent: number, resetsAt: string | null): ProviderUsage["windows"][number] => ({
  id,
  label: id,
  usedPercent,
  resetsAt,
})

test("recognizes the limit failures the harnesses report and leaves other failures alone", () => {
  expect(isUsageLimitFailure(["Claude AI usage limit reached|1793550000"])).toBe(true)
  expect(isUsageLimitFailure(["You've hit your usage limit. Try again later."])).toBe(true)
  expect(isUsageLimitFailure(["rate limit exceeded"])).toBe(true)
  expect(isUsageLimitFailure(["HTTP 429: too many requests"])).toBe(true)
  expect(isUsageLimitFailure(["quota exceeded for this model"])).toBe(true)
  expect(isUsageLimitFailure(["insufficient_quota"])).toBe(true)
  expect(isUsageLimitFailure(["Credit balance is too low"])).toBe(true)
  expect(isUsageLimitFailure(["You've reached your limit for this period."])).toBe(true)
  expect(isUsageLimitFailure(["You are out of credits."])).toBe(true)
  expect(isUsageLimitFailure(["The model refused to continue.", "tool call failed"])).toBe(false)
  expect(isUsageLimitFailure([])).toBe(false)
})

test("resets when every exhausted window has reset, and only if that is after the failed run", () => {
  const now = Date.parse("2026-11-05T10:00:00.000Z")
  const usageReport = usage([
    window("five_hour", 100, "2026-11-05T12:00:00.000Z"),
    window("seven_day", 100, "2026-11-08T12:00:00.000Z"),
    window("extra_usage", 3, "2026-11-20T12:00:00.000Z"),
  ])
  // The weekly window is still exhausted at the 5-hour reset, so the thread waits for the later one.
  expect(usageLimitResetAt(usageReport, now)).toBe("2026-11-08T12:00:00.000Z")

  expect(usageLimitResetAt(usage([window("five_hour", 100, "2026-11-05T11:00:00.000Z")]), now)).toBe(
    "2026-11-05T11:00:00.000Z",
  )
  // A stale report (its window reset before the run failed) cannot start a retry loop.
  expect(usageLimitResetAt(usage([window("five_hour", 100, "2026-11-05T09:00:00.000Z")]), now)).toBeNull()
  // Without a reported reset there is no safe time to resume.
  expect(usageLimitResetAt(usage([window("seven_day", 100, null)]), now)).toBeNull()
  // Only a window that is actually exhausted blocks the thread.
  expect(usageLimitResetAt(usage([window("seven_day", 99, "2026-11-08T12:00:00.000Z")]), now)).toBeNull()
  expect(usageLimitResetAt(usage([], "signed_out"), now)).toBeNull()
  expect(usageLimitResetAt(undefined, now)).toBeNull()
})
