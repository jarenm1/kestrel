import { useLayoutEffect, useRef } from "react"
import type { ActivityDay } from "@cloudagents/protocol"
import { cn } from "@/lib/utils"

const WEEKS = 53
const DAY_LABELS: Record<number, string> = { 0: "M", 2: "W", 4: "F" }
/** Fill per level: none, then quarters of the busiest day's runs, up to full white. */
const LEVELS = ["bg-white/[0.05]", "bg-white/20", "bg-white/40", "bg-white/70", "bg-white"] as const

const monthFormat = new Intl.DateTimeFormat(undefined, { month: "short" })
const dayFormat = new Intl.DateTimeFormat(undefined, { day: "numeric", month: "short", year: "numeric" })

/** `YYYY-MM-DD` in local time, the key the box counts days by. */
const dateKey = (d: Date) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`

function duration(seconds: number): string {
  const minutes = Math.round(seconds / 60)
  return minutes >= 60 ? `${Math.floor(minutes / 60)}h ${minutes % 60}m` : `${minutes}m`
}

interface Cell {
  readonly date: Date
  readonly day: ActivityDay | undefined
}

/**
 * The last 53 weeks of runs, one column per week starting on Monday, ending today. `days` are keyed by local date,
 * so the box must have counted them in the browser's time zone.
 */
export function ActivityHeatmap({ days, today }: { days: readonly ActivityDay[] | undefined; today: Date }) {
  const byDate = new Map(days?.map((d) => [d.date, d]))
  const scroller = useRef<HTMLDivElement>(null)
  // Narrow screens scroll the year sideways; start at today's end, where the recent weeks are.
  useLayoutEffect(() => {
    const el = scroller.current
    if (el) el.scrollLeft = el.scrollWidth
  }, [])
  const end = new Date(today.getFullYear(), today.getMonth(), today.getDate())
  const start = new Date(end.getFullYear(), end.getMonth(), end.getDate() - (end.getDay() + 6) % 7 - (WEEKS - 1) * 7)

  const weeks: Cell[][] = Array.from({ length: WEEKS }, (_, week) =>
    Array.from({ length: 7 }, (_, row) => {
      const date = new Date(start.getFullYear(), start.getMonth(), start.getDate() + week * 7 + row)
      return { date, day: byDate.get(dateKey(date)) }
    }).filter((cell) => cell.date <= end),
  )
  const cells = weeks.flat()
  const busiest = Math.max(1, ...cells.map((c) => c.day?.runs ?? 0))

  let activeDays = 0
  let longest = 0
  let streak = 0
  for (const cell of cells) {
    streak = (cell.day?.runs ?? 0) > 0 ? streak + 1 : 0
    if (streak > 0) activeDays += 1
    longest = Math.max(longest, streak)
  }

  // A month is named over the week holding its 1st; the first week is named too unless a label follows too closely.
  const monthLabels = weeks.map((week, i) => {
    const first = week.find((cell) => cell.date.getDate() === 1)
    if (first) return monthFormat.format(first.date)
    if (i === 0 && !weeks.slice(1, 3).some((w) => w.some((c) => c.date.getDate() === 1))) {
      return monthFormat.format(start)
    }
    return null
  })

  return (
    <section className="flex flex-col gap-3">
      <div className="flex items-baseline justify-between gap-4">
        <h3 className="font-semibold">Activity</h3>
        <span className="text-muted-foreground">
          {dayFormat.format(start)} – {dayFormat.format(end)}
        </span>
      </div>
      <div ref={scroller} className="overflow-x-auto sm:overflow-x-visible">
        <div
          className="grid min-w-[40rem] gap-[3px] text-xs text-muted-foreground"
          style={{ gridTemplateColumns: `1.25rem repeat(${WEEKS}, minmax(0, 1fr))` }}
        >
          {monthLabels.map(
            (label, week) =>
              label !== null && (
                <span key={`m${week}`} className="whitespace-nowrap" style={{ gridRow: 1, gridColumn: week + 2 }}>
                  {label}
                </span>
              ),
          )}
          {Object.entries(DAY_LABELS).map(([row, label]) => (
            <span key={`d${row}`} className="leading-none" style={{ gridRow: Number(row) + 2, gridColumn: 1 }}>
              {label}
            </span>
          ))}
          {weeks.map((week, w) =>
            week.map(({ date, day }, row) => {
              const runs = day?.runs ?? 0
              const level = runs === 0 ? 0 : Math.min(4, Math.ceil((runs / busiest) * 4))
              return (
                <span
                  key={dateKey(date)}
                  title={`${runs === 0 ? "No runs" : `${runs} ${runs === 1 ? "run" : "runs"} · ${duration(day?.agentSeconds ?? 0)}`} · ${dayFormat.format(date)}`}
                  className={cn("aspect-square rounded-[3px]", LEVELS[level])}
                  style={{ gridRow: row + 2, gridColumn: w + 2 }}
                />
              )
            }),
          )}
        </div>
      </div>
      <div className="flex items-center justify-between gap-4 text-muted-foreground">
        <span>
          {days === undefined
            ? " "
            : `${activeDays} active ${activeDays === 1 ? "day" : "days"} · longest streak ${longest} ${longest === 1 ? "day" : "days"}`}
        </span>
        <span className="flex items-center gap-[3px]">
          <span className="mr-1">Less</span>
          {LEVELS.map((level) => (
            <span key={level} className={cn("size-3 rounded-[3px]", level)} />
          ))}
          <span className="ml-1">More</span>
        </span>
      </div>
    </section>
  )
}
