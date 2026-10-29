import { useId } from "react"
import { useQuery } from "@tanstack/react-query"
import { MACHINE_STATS_WINDOW_MS, type MachineSample } from "@cloudagents/protocol"
import { queries } from "@/api/queries"

/** Graph drawing units; the SVG stretches to the card, and strokes do not scale with it. */
const W = 1000
const H = 100

const GRAPHS: readonly { label: string; value: (s: MachineSample) => number | null }[] = [
  { label: "RAM", value: (s) => s.ramUsed / s.ramTotal },
  { label: "VRAM", value: (s) => (s.vramUsed === null || !s.vramTotal ? null : s.vramUsed / s.vramTotal) },
  { label: "CPU", value: (s) => s.cpu },
  { label: "Storage", value: (s) => s.diskUsed / s.diskTotal },
]

/** Line and area paths of one graph: x is time over the last minute (right edge = newest sample), y is 0-100%. */
function paths(samples: readonly MachineSample[], value: (s: MachineSample) => number | null) {
  const newest = samples.at(-1)?.at ?? 0
  const points: string[] = []
  for (const s of samples) {
    const v = value(s)
    if (v === null || !Number.isFinite(v)) continue
    const x = W * (1 - (newest - s.at) / MACHINE_STATS_WINDOW_MS)
    const y = H * (1 - Math.min(1, Math.max(0, v)))
    points.push(`${x.toFixed(1)},${y.toFixed(1)}`)
  }
  if (points.length < 2) return null
  const line = `M${points.join("L")}`
  const first = points[0]!.split(",")[0]
  return { line, area: `${line}L${W},${H}L${first},${H}Z` }
}

function Graph({ label, samples, value }: { label: string; samples: readonly MachineSample[]; value: (s: MachineSample) => number | null }) {
  const gradient = `machine-fill-${useId().replace(/[^a-zA-Z0-9]/g, "")}`
  const drawn = paths(samples, value)
  return (
    <div className="relative h-16 overflow-hidden rounded-lg bg-card shadow-well">
      <svg className="absolute inset-0 size-full" viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" aria-hidden>
        <defs>
          <linearGradient id={gradient} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="white" stopOpacity="0.22" />
            <stop offset="100%" stopColor="white" stopOpacity="0" />
          </linearGradient>
        </defs>
        {[25, 50, 75].map((y) => (
          <line key={y} x1="0" x2={W} y1={y} y2={y} stroke="white" strokeOpacity="0.05" vectorEffect="non-scaling-stroke" />
        ))}
        {drawn && (
          <>
            <path d={drawn.area} fill={`url(#${gradient})`} />
            <path
              d={drawn.line}
              fill="none"
              stroke="white"
              strokeOpacity="0.8"
              strokeWidth="1.5"
              strokeLinejoin="round"
              vectorEffect="non-scaling-stroke"
            />
          </>
        )}
      </svg>
      <span className="absolute top-1.5 left-2.5 text-[11px] font-medium text-muted-foreground">{label}</span>
    </div>
  )
}

/** The box's RAM, VRAM, CPU and storage use over the last minute, stacked; each graph spans 0-100%. */
export function MachineGraphs() {
  const stats = useQuery(queries.machineStats)
  const samples = stats.data?.samples ?? []
  return (
    <div className="flex flex-col gap-2">
      {GRAPHS.map((g) => (
        <Graph key={g.label} label={g.label} samples={samples} value={g.value} />
      ))}
    </div>
  )
}
