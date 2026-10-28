import { describe, expect, test } from "bun:test"
import { CronError, localDate, nextFireTime, scheduleProblem } from "./cron"

const iso = (value: number | null): string | null => (value === null ? null : new Date(value).toISOString())
const next = (cron: string, timeZone: string, after: string): string | null =>
  iso(nextFireTime(cron, timeZone, Date.parse(after)))

describe("nextFireTime", () => {
  test("weekly Tuesday 13:00 New York keeps local time across DST", () => {
    // Tue 2026-10-27 13:00 EDT is 17:00Z; the next one is Tue 2026-11-03 13:00 EST (18:00Z).
    expect(next("0 13 * * 2", "America/New_York", "2026-10-27T17:00:00Z")).toBe("2026-11-03T18:00:00.000Z")
    // Tue 2026-03-03 13:00 EST is 18:00Z; DST starts 2026-03-08 so the next is 13:00 EDT (17:00Z).
    expect(next("0 13 * * 2", "America/New_York", "2026-03-03T18:00:00Z")).toBe("2026-03-10T17:00:00.000Z")
    expect(next("0 13 * * 2", "America/New_York", "2026-03-10T17:00:00Z")).toBe("2026-03-17T17:00:00.000Z")
  })

  test("a time inside the spring-forward gap is skipped that day", () => {
    // 02:30 does not exist on 2026-03-08 in New York; 02:30 EDT on 2026-03-09 is 06:30Z.
    expect(next("30 2 * * *", "America/New_York", "2026-03-08T00:00:00Z")).toBe("2026-03-09T06:30:00.000Z")
  })

  test("a time repeated by the fall-back overlap fires once, at its first occurrence", () => {
    // 01:30 happens twice on 2026-11-01 in New York: 05:30Z (EDT) and 06:30Z (EST). Only the first counts.
    expect(next("30 1 * * *", "America/New_York", "2026-10-31T12:00:00Z")).toBe("2026-11-01T05:30:00.000Z")
    expect(next("30 1 * * *", "America/New_York", "2026-11-01T05:30:00Z")).toBe("2026-11-02T06:30:00.000Z")
  })

  test("steps and UTC", () => {
    expect(next("*/15 * * * *", "UTC", "2026-06-01T10:07:00Z")).toBe("2026-06-01T10:15:00.000Z")
    expect(next("0 9 * * 7", "UTC", "2026-10-28T00:00:00Z")).toBe("2026-11-01T09:00:00.000Z")
  })

  test("day-of-month and day-of-week combine with OR when both are restricted", () => {
    // Monday (1) or the 15th: Mon 2026-11-02 comes before Sun 2026-11-15.
    expect(next("0 0 15 * 1", "UTC", "2026-10-28T00:00:00Z")).toBe("2026-11-02T00:00:00.000Z")
  })

  test("a Feb 29 Monday schedule still finds a fire inside the search window", () => {
    expect(nextFireTime("0 0 29 2 1", "UTC", Date.parse("2026-01-01T00:00:00Z"))).not.toBeNull()
  })

  test("malformed cron throws CronError", () => {
    expect(() => nextFireTime("60 * * * *", "UTC", 0)).toThrow(CronError)
    expect(() => nextFireTime("* * * *", "UTC", 0)).toThrow(CronError)
    expect(() => nextFireTime("*/0 * * * *", "UTC", 0)).toThrow(CronError)
  })
})

describe("scheduleProblem", () => {
  const now = Date.parse("2026-06-01T00:00:00Z")

  test("accepts a valid schedule", () => {
    expect(scheduleProblem("0 13 * * 2", "America/New_York", now)).toBeNull()
  })

  test("rejects unknown timezones, malformed cron, and schedules that never fire", () => {
    expect(scheduleProblem("0 13 * * 2", "Mars/Olympus", now)).toContain("unknown timezone")
    expect(scheduleProblem("0 13 * *", "UTC", now)).toContain("5 fields")
    expect(scheduleProblem("0 0 30 2 *", "UTC", now)).toBe("cron never fires")
  })
})

describe("localDate", () => {
  test("uses the zone's calendar date", () => {
    expect(localDate(Date.parse("2026-06-01T03:00:00Z"), "America/New_York")).toBe("2026-05-31")
    expect(localDate(Date.parse("2026-06-01T03:00:00Z"), "UTC")).toBe("2026-06-01")
  })
})
