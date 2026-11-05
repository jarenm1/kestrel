import { useId, useState, type PointerEvent } from "react"
import {
  TASK_STATS_WINDOW_MS,
  type TaskAppUsage,
  type TaskRamOther,
  type TaskStatsSample,
} from "@cloudagents/protocol"
import { useTaskStats } from "@/hooks/useTaskStats"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { cn } from "@/lib/utils"
import { formatSize } from "@/util"

/** Graph drawing units; the SVG stretches to the card, and strokes do not scale with it. */
const W = 1000
const H = 100

const ratio = (used: number | null, max: number | null): number | null =>
  used === null || max === null || max <= 0 ? null : used / max

const GRAPHS: readonly { label: string; value: (s: TaskStatsSample) => number | null }[] = [
  { label: "RAM", value: (s) => ratio(s.ramUsed, s.ramMax) },
  // No per-thread VRAM limit exists: this is the whole GPU, which every thread shares.
  { label: "VRAM · shared", value: (s) => ratio(s.vramUsed, s.vramTotal) },
  { label: "CPU", value: (s) => s.cpu },
  { label: "Storage", value: (s) => ratio(s.diskUsed, s.diskMax) },
]

/** One sampled point on a graph: x and y as 0-1 fractions of the card, `value` unclipped (storage can pass 100%). */
interface Point {
  readonly x: number
  readonly y: number
  readonly value: number
  readonly agoMs: number
}

/** Share of the card's height kept above 100%, so a full reading and its hover dot stay inside the card. */
const HEADROOM = 0.1

/** Card height fraction (0 = top) where a 0-1 reading sits. */
const yOf = (v: number): number => HEADROOM + (1 - HEADROOM) * (1 - Math.min(1, Math.max(0, v)))

/** x is time over the last minute (right edge = newest sample), y is 0-100%. */
function pointsOf(samples: readonly TaskStatsSample[], value: (s: TaskStatsSample) => number | null): Point[] {
  const newest = samples.at(-1)?.at ?? 0
  const points: Point[] = []
  for (const s of samples) {
    const v = value(s)
    if (v === null || !Number.isFinite(v)) continue
    points.push({
      x: 1 - (newest - s.at) / TASK_STATS_WINDOW_MS,
      y: yOf(v),
      value: v,
      agoMs: newest - s.at,
    })
  }
  return points
}

function percentText(value: number): string {
  if (value > 0 && value < 0.01) return "<1%"
  return `${Math.round(value * 100)}%`
}

function agoText(ms: number): string {
  const s = Math.round(ms / 1000)
  return s === 0 ? "now" : `${s}s ago`
}

/** The point nearest to `x` (0-1 across the card): hovering snaps to sampled points, never between them. */
function nearest(points: readonly Point[], x: number): Point | null {
  let best: Point | null = null
  for (const p of points) if (best === null || Math.abs(p.x - x) < Math.abs(best.x - x)) best = p
  return best
}

function Graph({ label, points }: { label: string; points: readonly Point[] }) {
  const gradient = `thread-fill-${useId().replace(/[^a-zA-Z0-9]/g, "")}`
  // The pointer's position across the card, so the snapped point follows new samples as they shift left.
  const [hoverX, setHoverX] = useState<number | null>(null)
  const drawn = points.length >= 2
  const coords = points.map((p) => `${(p.x * W).toFixed(1)},${(p.y * H).toFixed(1)}`)
  const line = `M${coords.join("L")}`
  const area = drawn ? `${line}L${W},${H}L${(points[0]!.x * W).toFixed(1)},${H}Z` : ""
  const hovered = drawn && hoverX !== null ? nearest(points, hoverX) : null

  function onPointerMove(e: PointerEvent<HTMLDivElement>) {
    const rect = e.currentTarget.getBoundingClientRect()
    setHoverX((e.clientX - rect.left) / rect.width)
  }

  return (
    <div
      className="relative h-[70px] overflow-hidden rounded-lg bg-card shadow-well"
      onPointerMove={onPointerMove}
      onPointerLeave={() => setHoverX(null)}
    >
      <svg className="absolute inset-0 size-full" viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" aria-hidden>
        <defs>
          <linearGradient id={gradient} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="white" stopOpacity="0.22" />
            <stop offset="100%" stopColor="white" stopOpacity="0" />
          </linearGradient>
        </defs>
        {[0.25, 0.5, 0.75].map((q) => yOf(q) * H).map((y) => (
          <line key={y} x1="0" x2={W} y1={y} y2={y} stroke="white" strokeOpacity="0.05" vectorEffect="non-scaling-stroke" />
        ))}
        {drawn && (
          <>
            <path d={area} fill={`url(#${gradient})`} />
            <path
              d={line}
              fill="none"
              stroke="white"
              strokeOpacity="0.8"
              strokeWidth="1.5"
              strokeLinejoin="round"
              vectorEffect="non-scaling-stroke"
            />
          </>
        )}
        {hovered && (
          <line
            x1={hovered.x * W}
            x2={hovered.x * W}
            y1="0"
            y2={H}
            stroke="white"
            strokeOpacity="0.15"
            vectorEffect="non-scaling-stroke"
          />
        )}
      </svg>
      <span className="absolute top-1.5 left-2.5 text-[11px] font-medium text-muted-foreground">{label}</span>
      {hovered && (
        <>
          {/* Drawn in HTML, not the stretched SVG, so the dot stays round. */}
          <span
            className="pointer-events-none absolute size-2 -translate-x-1/2 -translate-y-1/2 rounded-full bg-white shadow-[0_0_0_3px_rgb(255_255_255/0.15)]"
            style={{ left: `${hovered.x * 100}%`, top: `${hovered.y * 100}%` }}
          />
          <span
            className={cn(
              "pointer-events-none absolute -translate-y-1/2 rounded-md bg-popover px-1.5 py-0.5 text-[11px] whitespace-nowrap text-popover-foreground tabular-nums shadow-soft",
              // Flips to the dot's left near the right edge, so it stays inside the card.
              hovered.x > 0.7 ? "-translate-x-full -ml-2.5" : "ml-2.5",
            )}
            style={{ left: `${hovered.x * 100}%`, top: `${Math.min(78, Math.max(22, hovered.y * 100))}%` }}
          >
            {percentText(hovered.value)} · {agoText(hovered.agoMs)}
          </span>
        </>
      )}
    </div>
  )
}

/** One row of the applications list; `program` is false for memory no process maps, which has no CPU. */
interface AppRow {
  readonly name: string
  readonly program: boolean
  readonly detail: string | null
  readonly ramUsed: number
  readonly cpu: number | null
}

/** The latest sample as rows: its applications, most memory first, then the slice's memory outside any process. */
function appRows(apps: readonly TaskAppUsage[], other: TaskRamOther | null | undefined): AppRow[] {
  const rows: AppRow[] = apps.map((a) => ({
    name: a.name ?? "Other",
    program: a.name !== null,
    detail: a.processes > 1 ? `${a.processes} processes` : null,
    ramUsed: a.ramUsed,
    cpu: a.cpu,
  }))
  if (other) {
    const rest: readonly [string, number][] = [
      ["Page cache", other.pageCache],
      ["tmpfs & shared memory", other.tmpfs],
      ["Kernel", other.kernel],
    ]
    for (const [name, ramUsed] of rest) {
      if (ramUsed > 0) rows.push({ name, program: false, detail: null, ramUsed, cpu: null })
    }
  }
  return rows
}

/**
 * What each application in the thread uses now, with its RAM against the thread's RAM limit, then the memory the
 * thread holds outside its processes. Memory processes share is divided between them, so the rows add up to the total.
 */
function Applications({ sample }: { sample: TaskStatsSample | undefined }) {
  if (sample === undefined) return <p className="px-1 text-xs text-muted-foreground">Waiting for the first reading…</p>
  const { apps, ramUsed, ramMax } = sample
  if (apps === undefined || ramUsed === null || ramMax === null || ramMax <= 0) {
    return <p className="px-1 text-xs text-muted-foreground">This box does not report applications.</p>
  }
  const rows = appRows(apps, sample.ramOther)
  return (
    <div className="rounded-lg bg-card px-2.5 py-2 shadow-well">
      <div className="flex items-baseline justify-between text-[11px] font-medium text-muted-foreground">
        <span>RAM · CPU</span>
        <span className="tabular-nums">
          {formatSize(ramUsed)} of {formatSize(ramMax)}
        </span>
      </div>
      {rows.length === 0 ? (
        <p className="mt-1.5 text-xs text-muted-foreground">Nothing running</p>
      ) : (
        <ul className="mt-1.5 flex flex-col gap-1.5">
          {rows.map((row) => (
            <li key={`${row.program}:${row.name}`} className="text-xs">
              <div className="flex items-baseline gap-2">
                <span
                  className={cn(
                    "min-w-0 flex-1 truncate",
                    row.program ? "font-mono text-foreground" : "text-muted-foreground",
                  )}
                  title={row.name}
                >
                  {row.name}
                  {row.detail && <span className="ml-1.5 font-sans text-muted-foreground">{row.detail}</span>}
                </span>
                <span className="w-16 shrink-0 text-right text-muted-foreground tabular-nums">
                  {formatSize(row.ramUsed)}
                </span>
                <span className="w-10 shrink-0 text-right text-muted-foreground tabular-nums">
                  {row.cpu === null ? "" : percentText(row.cpu)}
                </span>
              </div>
              <div className="mt-0.5 h-1 overflow-hidden rounded-full bg-white/5">
                <div
                  className="h-full rounded-full bg-white/60"
                  style={{ width: `${Math.min(100, (row.ramUsed / ramMax) * 100)}%` }}
                />
              </div>
            </li>
          ))}
        </ul>
      )}
      <p className="mt-2 text-[11px] text-muted-foreground">Memory shared by several processes is split between them.</p>
    </div>
  )
}

/**
 * Two tabs under the desktop. Resources: the thread's RAM, CPU and storage against its own limits over the last
 * minute, stacked, plus the GPU's VRAM (shared by every thread); each graph spans 0-100%, and hovering one shows the
 * sample nearest the pointer. Applications: what each application in the thread uses now.
 */
export function ThreadGraphs({ taskId }: { taskId: string }) {
  const samples = useTaskStats(taskId)
  return (
    <Tabs defaultValue="resources" className="gap-2">
      <TabsList className="h-8">
        <TabsTrigger value="resources" className="px-3 text-xs">
          Resources
        </TabsTrigger>
        <TabsTrigger value="applications" className="px-3 text-xs">
          Applications
        </TabsTrigger>
      </TabsList>
      <TabsContent value="resources" className="flex flex-col gap-2">
        {GRAPHS.map((g) => (
          <Graph key={g.label} label={g.label} points={pointsOf(samples, g.value)} />
        ))}
      </TabsContent>
      <TabsContent value="applications">
        <Applications sample={samples.at(-1)} />
      </TabsContent>
    </Tabs>
  )
}
