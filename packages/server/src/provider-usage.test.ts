import { describe, expect, test } from "bun:test"
import { openCodeGoKey, parseClaudeUsage, parseCodexResetOutcome, parseCodexUsage, parseOpenCodeGoUsage } from "./provider-usage"

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

  test("lists available banked resets soonest to expire first, keeping the provider's count", () => {
    const usage = parseCodexUsage({
      rateLimits: { planType: "plus", primary: { usedPercent: 1 } },
      rateLimitResetCredits: {
        availableCount: 4,
        credits: [
          { id: "never", grantedAt: 1, resetType: "codexRateLimits", status: "available", title: null, expiresAt: null },
          { id: "late", grantedAt: 1, resetType: "codexRateLimits", status: "available", title: "Referral", expiresAt: 1793560000 },
          { id: "used", grantedAt: 1, resetType: "codexRateLimits", status: "redeemed", expiresAt: 1793500000 },
          { id: "soon", grantedAt: 1, resetType: "unknown", status: "available", expiresAt: 1793550000 },
        ],
      },
    })
    expect(usage.bankedResets).toEqual({
      available: 4,
      resets: [
        { id: "soon", title: null, expiresAt: new Date(1793550000_000).toISOString() },
        { id: "late", title: "Referral", expiresAt: new Date(1793560000_000).toISOString() },
        { id: "never", title: null, expiresAt: null },
      ],
    })
  })

  test("a count without details still reports banked resets; no summary reports none", () => {
    const base = { rateLimits: { primary: { usedPercent: 1 } } }
    expect(parseCodexUsage({ ...base, rateLimitResetCredits: { availableCount: 2, credits: null } }).bankedResets).toEqual({
      available: 2,
      resets: [],
    })
    expect(parseCodexUsage({ ...base, rateLimitResetCredits: null }).bankedResets).toBeUndefined()
  })
})

describe("parseCodexResetOutcome", () => {
  test("maps each consume outcome, a replayed key counting as reset", () => {
    expect(parseCodexResetOutcome({ outcome: "reset" })).toEqual({ outcome: "reset" })
    expect(parseCodexResetOutcome({ outcome: "alreadyRedeemed" })).toEqual({ outcome: "reset" })
    expect(parseCodexResetOutcome({ outcome: "nothingToReset" })).toEqual({ outcome: "nothing_to_reset" })
    expect(parseCodexResetOutcome({ outcome: "noCredit" })).toEqual({ outcome: "no_reset" })
    expect(() => parseCodexResetOutcome({ outcome: "later" })).toThrow()
  })
})

describe("OpenCode Go usage", () => {
  test("uses only the active Go key, never a different integration or an inactive account", () => {
    expect(openCodeGoKey([
      { integrationID: "opencode", active: true, value: { type: "key", key: "console" } },
      { integrationID: "opencode-go", active: false, value: { type: "key", key: "old" } },
      { integrationID: "opencode-go", active: true, value: { type: "key", key: "current" } },
    ])).toBe("current")
    expect(openCodeGoKey([{ integrationID: "opencode-go", active: true, value: { type: "oauth", access: "token" } }])).toBeNull()
  })

  test("maps all three windows, normalizes reset times and bounds percentages", () => {
    expect(parseOpenCodeGoUsage({ usage: {
      rolling: { percent: 12.5, resetsAt: "2026-11-04T01:00:00-05:00" },
      weekly: { percent: 125, resetsAt: null },
      monthly: { percent: -1, resetsAt: "unknown" },
    } })).toEqual({
      provider: "opencode-go", status: "ok", plan: "go",
      windows: [
        { id: "rolling", label: "5-hour", usedPercent: 12.5, resetsAt: "2026-11-04T06:00:00.000Z" },
        { id: "weekly", label: "Weekly", usedPercent: 100, resetsAt: null },
        { id: "monthly", label: "Monthly", usedPercent: 0, resetsAt: null },
      ],
    })
    expect(parseOpenCodeGoUsage({ usage: { rolling: { percent: Number.NaN } } }).status).toBe("unavailable")
  })
})
