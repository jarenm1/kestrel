/**
 * Cron schedules evaluated in an IANA time zone. Pure logic (no Worker APIs), so it is unit-tested with `bun test`.
 *
 * Syntax: five fields `minute hour day-of-month month day-of-week`. Each field is a comma list of items, each one
 * `*`, `N`, or `N-M`, optionally followed by `/step`. Day-of-week runs 0-7 and both 0 and 7 mean Sunday.
 * Day rules follow vixie cron: when both day fields are restricted a day matches if either does; when either
 * field starts with `*` both must match.
 *
 * DST: a wall-clock time skipped by a spring-forward gap never fires that day. A wall-clock time repeated by a
 * fall-back overlap fires once, at its first occurrence.
 */

export class CronError extends Error {}

interface FieldSpec {
  readonly name: string
  readonly min: number
  readonly max: number
}

const MINUTE: FieldSpec = { name: "minute", min: 0, max: 59 }
const HOUR: FieldSpec = { name: "hour", min: 0, max: 23 }
const DAY_OF_MONTH: FieldSpec = { name: "day-of-month", min: 1, max: 31 }
const MONTH: FieldSpec = { name: "month", min: 1, max: 12 }
const DAY_OF_WEEK: FieldSpec = { name: "day-of-week", min: 0, max: 7 }

const DAY_MS = 86_400_000

const integer = (text: string, field: FieldSpec): number => {
  if (!/^\d+$/.test(text)) throw new CronError(`${field.name}: "${text}" is not a number`)
  return Number(text)
}

const parseField = (text: string, field: FieldSpec): Set<number> => {
  const values = new Set<number>()
  for (const item of text.split(",")) {
    const [range, stepText, extra] = item.split("/")
    if (!range || extra !== undefined) throw new CronError(`${field.name}: invalid "${item}"`)
    const step = stepText === undefined ? 1 : integer(stepText, field)
    if (step < 1) throw new CronError(`${field.name}: step must be at least 1`)

    let low: number
    let high: number
    if (range === "*") {
      low = field.min
      high = field.max
    } else {
      const [startText, endText, more] = range.split("-")
      if (!startText || more !== undefined) throw new CronError(`${field.name}: invalid "${item}"`)
      low = integer(startText, field)
      high = endText === undefined ? (stepText === undefined ? low : field.max) : integer(endText, field)
    }
    if (low < field.min || high > field.max || low > high) {
      throw new CronError(`${field.name}: "${item}" is outside ${field.min}-${field.max}`)
    }
    for (let value = low; value <= high; value += step) values.add(value)
  }
  return values
}

interface CronSchedule {
  readonly minutes: readonly number[]
  readonly hours: readonly number[]
  readonly daysOfMonth: ReadonlySet<number>
  readonly months: ReadonlySet<number>
  readonly daysOfWeek: ReadonlySet<number>
  readonly domStar: boolean
  readonly dowStar: boolean
}

const parseCron = (expr: string): CronSchedule => {
  const fields = expr.trim().split(/\s+/)
  if (fields.length !== 5) throw new CronError("cron needs 5 fields: minute hour day-of-month month day-of-week")
  const [minute, hour, dayOfMonth, month, dayOfWeek] = fields as [string, string, string, string, string]
  const weekdays = new Set([...parseField(dayOfWeek, DAY_OF_WEEK)].map((day) => (day === 7 ? 0 : day)))
  return {
    minutes: [...parseField(minute, MINUTE)].sort((a, b) => a - b),
    hours: [...parseField(hour, HOUR)].sort((a, b) => a - b),
    daysOfMonth: parseField(dayOfMonth, DAY_OF_MONTH),
    months: parseField(month, MONTH),
    daysOfWeek: weekdays,
    domStar: dayOfMonth.startsWith("*"),
    dowStar: dayOfWeek.startsWith("*"),
  }
}

const formatters = new Map<string, Intl.DateTimeFormat>()

const formatterFor = (timeZone: string): Intl.DateTimeFormat => {
  let formatter = formatters.get(timeZone)
  if (!formatter) {
    formatter = new Intl.DateTimeFormat("en-US", {
      timeZone,
      hourCycle: "h23",
      year: "numeric",
      month: "numeric",
      day: "numeric",
      hour: "numeric",
      minute: "numeric",
      second: "numeric",
    })
    formatters.set(timeZone, formatter)
  }
  return formatter
}

/** True when `timeZone` is a valid IANA zone name. */
export const validTimeZone = (timeZone: string): boolean => {
  try {
    formatterFor(timeZone)
    return true
  } catch {
    return false
  }
}

interface WallTime {
  readonly year: number
  readonly month: number
  readonly day: number
  readonly hour: number
  readonly minute: number
  readonly second: number
}

const wallClock = (ms: number, timeZone: string): WallTime => {
  const parts: Record<string, number> = {}
  for (const part of formatterFor(timeZone).formatToParts(ms)) {
    if (part.type !== "literal") parts[part.type] = Number(part.value)
  }
  return {
    year: parts.year ?? Number.NaN,
    month: parts.month ?? Number.NaN,
    day: parts.day ?? Number.NaN,
    hour: parts.hour ?? Number.NaN,
    minute: parts.minute ?? Number.NaN,
    second: parts.second ?? Number.NaN,
  }
}

const wallAsUtc = (wall: WallTime): number =>
  Date.UTC(wall.year, wall.month - 1, wall.day, wall.hour, wall.minute, wall.second)

const sameWall = (a: WallTime, b: WallTime): boolean =>
  a.year === b.year &&
  a.month === b.month &&
  a.day === b.day &&
  a.hour === b.hour &&
  a.minute === b.minute &&
  a.second === b.second

/**
 * Instants at which the wall-clock reading `wall` happens in `timeZone`, earliest first. Empty inside a
 * spring-forward gap; two entries inside a fall-back overlap. Offsets are sampled a day and a half either side,
 * so a single DST transition near `wall` is always seen from both sides.
 */
const instantsOf = (wall: WallTime, timeZone: string): number[] => {
  const guess = wallAsUtc(wall)
  const window = DAY_MS * 1.5
  const offsets = new Set<number>()
  for (const probe of [guess - window, guess, guess + window]) {
    offsets.add(wallAsUtc(wallClock(probe, timeZone)) - probe)
  }
  const found = new Set<number>()
  for (const offset of offsets) {
    const instant = guess - offset
    if (sameWall(wallClock(instant, timeZone), wall)) found.add(instant)
  }
  return [...found].sort((a, b) => a - b)
}

const matchesDay = (schedule: CronSchedule, month: number, day: number, weekday: number): boolean => {
  if (!schedule.months.has(month)) return false
  const domMatch = schedule.daysOfMonth.has(day)
  const dowMatch = schedule.daysOfWeek.has(weekday)
  return schedule.domStar || schedule.dowStar ? domMatch && dowMatch : domMatch || dowMatch
}

/** Years of search before giving up; covers every day/weekday combination (e.g. Feb 29 on a Monday). */
const SEARCH_DAYS = 366 * 30

const nextFire = (schedule: CronSchedule, timeZone: string, afterMs: number): number | null => {
  const start = wallClock(afterMs, timeZone)
  // Start a day early: a zone may move its wall clock backwards across midnight.
  let cursor = Date.UTC(start.year, start.month - 1, start.day) - DAY_MS
  for (let i = 0; i < SEARCH_DAYS; i++, cursor += DAY_MS) {
    const date = new Date(cursor)
    const month = date.getUTCMonth() + 1
    const day = date.getUTCDate()
    if (!matchesDay(schedule, month, day, date.getUTCDay())) continue

    let best: number | null = null
    for (const hour of schedule.hours) {
      for (const minute of schedule.minutes) {
        const [first] = instantsOf(
          { year: date.getUTCFullYear(), month, day, hour, minute, second: 0 },
          timeZone,
        )
        if (first !== undefined && first > afterMs && (best === null || first < best)) best = first
      }
    }
    if (best !== null) return best
  }
  return null
}

/**
 * First fire time strictly after `afterMs` for a 5-field `cron` in `timeZone`, or null if it never fires.
 * Throws CronError for malformed expressions.
 */
export const nextFireTime = (cron: string, timeZone: string, afterMs: number): number | null =>
  nextFire(parseCron(cron), timeZone, afterMs)

/** Why a schedule can't be saved (bad zone, bad cron, or a cron that never fires), or null when it is valid. */
export const scheduleProblem = (cron: string, timeZone: string, nowMs: number): string | null => {
  if (!validTimeZone(timeZone)) return `unknown timezone "${timeZone}"`
  try {
    return nextFireTime(cron, timeZone, nowMs) === null ? "cron never fires" : null
  } catch (error) {
    return error instanceof CronError ? error.message : "invalid cron"
  }
}

/** Calendar date ("YYYY-MM-DD") of `ms` as seen in `timeZone`. */
export const localDate = (ms: number, timeZone: string): string => {
  const wall = wallClock(ms, timeZone)
  return `${wall.year}-${String(wall.month).padStart(2, "0")}-${String(wall.day).padStart(2, "0")}`
}
