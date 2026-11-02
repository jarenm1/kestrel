import { describe, expect, test } from "bun:test"
import { parseClaudeUsage, parseCodexUsage } from "./provider-usage"

describe("parseClaudeUsage", () => {
  test("reads the session, weekly and extra usage windows, not per-model ones", () => {
    const usage = parseClaudeUsage({
      subscription_type: "max",
      rate_limits_available: true,
      rate_limits: {
        five_hour: { utilization: 42, resets_at: "2026-11-01T15:00:00+00:00" },
        seven_day: { utilization: 130, resets_at: null },
        model_scoped: [{ display_name: "Opus", utilization: 7, resets_at: "2026-11-05T00:00:00Z" }, { utilization: 1 }],
        extra_usage: { is_enabled: true, utilization: 3 },
      },
    })
    expect(usage).toEqual({
      provider: "claude-cli",
      status: "ok",
      plan: "max",
      windows: [
        { id: "five_hour", label: "5-hour", usedPercent: 42, resetsAt: "2026-11-01T15:00:00.000Z" },
        { id: "seven_day", label: "Weekly", usedPercent: 100, resetsAt: null },
        { id: "extra_usage", label: "Extra usage", usedPercent: 3, resetsAt: null },
      ],
    })
  })

  test("no subscription login is signed out, as the CLI answers without one", () => {
    const answer = { session: {}, subscription_type: null, rate_limits_available: false, rate_limits: null, behaviors: null }
    expect(parseClaudeUsage(answer)).toEqual({ provider: "claude-cli", status: "signed_out", plan: null, windows: [] })
  })

  test("leaves out disabled extra usage and windows with no number", () => {
    const usage = parseClaudeUsage({
      rate_limits_available: true,
      rate_limits: { five_hour: { utilization: null }, seven_day: { utilization: 1 }, extra_usage: { is_enabled: false, utilization: 9 } },
    })
    expect(usage.windows.map((w) => w.id)).toEqual(["seven_day"])
  })
})

describe("parseCodexUsage", () => {
  test("prefers the account's main allowance and labels windows by duration", () => {
    const usage = parseCodexUsage({
      rateLimits: { limitId: "other", primary: { usedPercent: 99 } },
      rateLimitsByLimitId: {
        codex: {
          planType: "pro",
          primary: { usedPercent: 12.5, windowDurationMins: 300, resetsAt: 1793550000 },
          secondary: { usedPercent: 60, windowDurationMins: 10080, resetsAt: null },
          individualLimit: { remainingPercent: 75, resetsAt: 1793550000 },
        },
      },
    })
    expect(usage).toEqual({
      provider: "codex-cli",
      status: "ok",
      plan: "pro",
      windows: [
        { id: "primary", label: "5-hour", usedPercent: 12.5, resetsAt: new Date(1793550000_000).toISOString() },
        { id: "secondary", label: "Weekly", usedPercent: 60, resetsAt: null },
        { id: "individual", label: "Monthly credit limit", usedPercent: 25, resetsAt: new Date(1793550000_000).toISOString() },
      ],
    })
  })

  test("a window without a duration falls back by position and plan", () => {
    expect(parseCodexUsage({ rateLimits: { planType: "plus", primary: { usedPercent: 1 } } }).windows[0]?.label).toBe("5-hour")
    expect(parseCodexUsage({ rateLimits: { planType: "free", primary: { usedPercent: 1 } } }).windows[0]?.label).toBe("Monthly")
  })

  test("an answer with no snapshot is unavailable", () => {
    expect(parseCodexUsage({}).status).toBe("unavailable")
  })
})
