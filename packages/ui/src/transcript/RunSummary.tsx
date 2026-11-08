import type { AgentItem, Run } from "@cloudagents/protocol"
import { ChevronRight } from "lucide-react"
import { formatMessageTime } from "./time"

const TOKENS = new Intl.NumberFormat("en", { notation: "compact", maximumFractionDigits: 1 })
const EXACT = new Intl.NumberFormat("en")

/** Wall-clock work time, not model generation time; round before choosing the unit. */
function duration(ms: number): string {
  if (ms < 1000) return `${Math.max(1, Math.round(ms))}ms`
  if (ms < 10_000) return `${Math.round(ms / 100) / 10}s`
  const seconds = Math.round(ms / 1000)
  if (seconds < 60) return `${seconds}s`
  const hours = Math.floor(seconds / 3600)
  const minutes = Math.floor(seconds % 3600 / 60)
  return [hours && `${hours}h`, minutes && `${minutes}m`, seconds % 60 && `${seconds % 60}s`].filter(Boolean).join(" ")
}

function count(value: number | null): string {
  return value === null ? "Not reported" : TOKENS.format(value)
}

/** One summary per harness invocation, using Kestrel's lifecycle clock for every harness. */
export function RunSummary({ run, items }: { run: Run; items: readonly AgentItem[] }) {
  if (run.status === "running") return null
  const elapsed = run.endedAt === null ? NaN : Date.parse(run.endedAt) - Date.parse(run.startedAt)
  const measured = !run.interruptedByRestart && Number.isFinite(elapsed) && elapsed >= 0
  const turns = items.filter((item) => item._tag === "turn")
  // A failed/stopped invocation can end without a final usage report. Do not call a completed prefix its total.
  const complete = run.status === "succeeded" && items.at(-1)?._tag === "turn"
  const total = (field: "inputTokens" | "outputTokens"): number | null =>
    !complete || turns.length === 0 || turns.some((turn) => turn[field] === null)
      ? null
      : turns.reduce((sum, turn) => sum + turn[field]!, 0)
  const input = total("inputTokens")
  const output = total("outputTokens")
  const rate = measured && elapsed > 0 && output !== null ? output * 1000 / elapsed : null
  const responses = items.filter((item): item is Extract<AgentItem, { _tag: "usage" }> => item._tag === "usage" && item.parentToolId === null)
  const cached = !complete || responses.length === 0 || responses.some((item) => item.cachedTokens === null)
    ? null
    : responses.reduce((sum, item) => sum + item.cachedTokens!, 0)
  const label = run.interruptedByRestart ? "Interrupted by restart" : run.status === "cancelled" ? "Stopped" : run.status === "failed" ? "Failed" : "Worked"
  return (
    <details className="group/run text-[11px] text-muted-foreground tabular-nums">
      <summary className="group/row flex w-fit cursor-pointer list-none items-center gap-2 rounded-sm text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/70 [&::-webkit-details-marker]:hidden">
        <span>
          {label}{measured ? ` for ${duration(elapsed)}` : ""}
          {run.endedAt !== null && <><span aria-hidden="true"> · </span><time dateTime={run.endedAt}>{formatMessageTime(run.endedAt)}</time></>}
        </span>
        <ChevronRight aria-hidden="true" className="size-3.5 shrink-0 opacity-0 transition group-hover/row:opacity-100 group-focus-visible/row:opacity-100 group-open/run:rotate-90 group-open/run:opacity-100" />
      </summary>
      <dl className="mt-2 grid w-fit grid-cols-[auto_auto] gap-x-5 gap-y-1">
        <dt>Elapsed (wall-clock)</dt><dd title="Includes queueing, startup, tools and waiting">{measured ? duration(elapsed) : "Not reported"}</dd>
        <dt>Input tokens (including cache)</dt><dd title={input === null ? undefined : EXACT.format(input)}>{count(input)}</dd>
        <dt>Cached input tokens</dt><dd title={cached === null ? undefined : EXACT.format(cached)}>{count(cached)}</dd>
        <dt>Output tokens</dt><dd title={output === null ? undefined : EXACT.format(output)}>{count(output)}</dd>
        <dt>Average output / elapsed</dt><dd>{rate !== null && Number.isFinite(rate) ? `${rate.toLocaleString("en-US", { maximumFractionDigits: 1 })} tok/s` : "Not reported"}</dd>
      </dl>
    </details>
  )
}
