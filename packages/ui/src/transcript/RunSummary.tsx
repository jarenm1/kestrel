import type { AgentItem, Run } from "@cloudagents/protocol"
import { cn } from "../cn"
import { formatMessageTime } from "./time"
import { Chevron, DETAILS_CLASS, ROW_CLASS } from "./WorkLog"

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

type Usage = Extract<AgentItem, { _tag: "usage" }>

interface Totals {
  readonly input: number | null
  readonly output: number | null
  readonly cached: number | null
}

/** Sum only when every part is known: a partial total is not the run's total. */
function sum(values: readonly (number | null)[]): number | null {
  return values.some((value) => value === null)
    ? null
    : values.reduce<number>((total, value) => total + (value ?? 0), 0)
}

/**
 * Token totals from each completed turn: main-agent response usage when the harness reported it, so input excludes
 * cache reads and they stay a separate bucket. A turn aggregate folds cache reads into its input and carries no
 * cache split, so its cache-free input stays unknown; its output remains the authoritative total.
 */
function tokenTotals(items: readonly AgentItem[]): Totals {
  const turns: Totals[] = []
  let responses: Usage[] = []
  for (const item of items) {
    if (item._tag === "usage") {
      if (item.parentToolId === null) responses.push(item)
      continue
    }
    if (item._tag !== "turn") continue
    turns.push({
      input: responses.length === 0 ? null : sum(responses.map((response) => response.inputTokens)),
      output: item.outputTokens,
      cached: responses.length === 0 ? null : sum(responses.map((response) => response.cachedTokens)),
    })
    responses = []
  }
  return {
    input: sum(turns.map((turn) => turn.input)),
    output: sum(turns.map((turn) => turn.output)),
    cached: sum(turns.map((turn) => turn.cached)),
  }
}

/** One summary per harness invocation, using Kestrel's lifecycle clock for every harness. */
export function RunSummary({ run, items }: { run: Run; items: readonly AgentItem[] }) {
  if (run.status === "running") return null
  const elapsed = run.endedAt === null ? NaN : Date.parse(run.endedAt) - Date.parse(run.startedAt)
  const measured = !run.interruptedByRestart && Number.isFinite(elapsed) && elapsed >= 0
  // A failed/stopped invocation can end without a final usage report. Do not call a completed prefix its total.
  const complete = run.status === "succeeded" && items.at(-1)?._tag === "turn"
  const { input, output, cached } = complete ? tokenTotals(items) : { input: null, output: null, cached: null }
  const rate = measured && elapsed > 0 && output !== null ? output * 1000 / elapsed : null
  const label = run.interruptedByRestart ? "Interrupted by restart" : run.status === "cancelled" ? "Stopped" : run.status === "failed" ? "Failed" : "Worked"
  return (
    <details className="group/run tabular-nums">
      <summary className={cn(ROW_CLASS, "w-fit list-none [&::-webkit-details-marker]:hidden")}>
        <span>
          {label}{measured ? ` for ${duration(elapsed)}` : ""}
          {run.endedAt !== null && <><span aria-hidden="true"> · </span><time dateTime={run.endedAt}>{formatMessageTime(run.endedAt)}</time></>}
        </span>
        <Chevron className="group-open/run:rotate-90 group-open/run:opacity-100" />
      </summary>
      <dl className={cn(DETAILS_CLASS, "grid w-fit grid-cols-[auto_auto] gap-x-5 gap-y-1 text-sm text-muted-foreground")}>
        <dt>Input tokens</dt><dd title={input === null ? undefined : EXACT.format(input)}>{count(input)}</dd>
        <dt>Output tokens</dt><dd title={output === null ? undefined : EXACT.format(output)}>{count(output)}</dd>
        <dt>Cached tokens</dt><dd title={cached === null ? undefined : EXACT.format(cached)}>{count(cached)}</dd>
        <dt>Avg TPS</dt><dd title="Output tokens per second over the run's wall-clock time, including tools and waiting">{rate !== null && Number.isFinite(rate) ? `${rate.toLocaleString("en-US", { maximumFractionDigits: 1 })} tok/s` : "Not reported"}</dd>
      </dl>
    </details>
  )
}
