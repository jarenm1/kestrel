import { describe, expect, test } from "bun:test"
import { ACTIVITY_DAYS, dailyActivity } from "./activity"

const now = new Date("2026-11-01T12:00:00Z")

describe("dailyActivity", () => {
  test("counts each run on the local day it started in the requested zone", () => {
    // 03:30 UTC on Nov 1 is still Oct 31 in New York.
    const runs = [
      { startedAt: "2026-11-01T03:30:00Z", endedAt: "2026-11-01T04:00:00Z" },
      { startedAt: "2026-11-01T10:00:00Z", endedAt: "2026-11-01T10:10:00Z" },
    ]
    expect(dailyActivity(runs, now, "UTC").days).toEqual([{ date: "2026-11-01", runs: 2, agentSeconds: 2400 }])
    expect(dailyActivity(runs, now, "America/New_York").days).toEqual([
      { date: "2026-10-31", runs: 1, agentSeconds: 1800 },
      { date: "2026-11-01", runs: 1, agentSeconds: 600 },
    ])
  })

  test("a running run counts up to now, and runs older than the window are left out", () => {
    const oldest = new Date(now.getTime() - ACTIVITY_DAYS * 86_400_000)
    const runs = [
      { startedAt: new Date(oldest.getTime() - 1000).toISOString(), endedAt: oldest.toISOString() },
      { startedAt: "2026-11-01T11:00:00Z", endedAt: null },
    ]
    expect(dailyActivity(runs, now, "UTC").days).toEqual([{ date: "2026-11-01", runs: 1, agentSeconds: 3600 }])
  })
})
