import type { ActivityDay, UsageActivity } from "@cloudagents/protocol"

/** 53 weeks: enough for a year-wide grid that starts on a Monday, whatever today is. */
export const ACTIVITY_DAYS = 53 * 7
const DAY_MS = 86_400_000

/** A formatter for `YYYY-MM-DD` dates in `timeZone`; throws a RangeError for an unknown zone. */
export const dayFormat = (timeZone: string): Intl.DateTimeFormat =>
  new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" })

/**
 * Buckets runs by the local day they started in `timeZone`, over the last `ACTIVITY_DAYS` days. A run's whole active
 * time counts on its start day; a run still going counts up to `now`.
 */
export const dailyActivity = (
  runs: Iterable<{ readonly startedAt: string; readonly endedAt: string | null }>,
  now: Date,
  timeZone: string,
): UsageActivity => {
  const format = dayFormat(timeZone)
  const since = now.getTime() - ACTIVITY_DAYS * DAY_MS
  const days = new Map<string, { runs: number; agentMs: number }>()
  for (const run of runs) {
    const started = Date.parse(run.startedAt)
    if (!(started >= since)) continue
    const ended = run.endedAt === null ? now.getTime() : Date.parse(run.endedAt)
    const date = format.format(started)
    const day = days.get(date) ?? { runs: 0, agentMs: 0 }
    day.runs += 1
    day.agentMs += Math.max(0, ended - started)
    days.set(date, day)
  }
  const list: ActivityDay[] = [...days]
    .map(([date, day]) => ({ date, runs: day.runs, agentSeconds: Math.round(day.agentMs / 1000) }))
    .sort((a, b) => a.date.localeCompare(b.date))
  return { timeZone, days: list }
}
