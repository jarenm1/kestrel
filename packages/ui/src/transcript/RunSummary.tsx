import { useState } from "react"
import type { AgentItem, Run, RunClip } from "@cloudagents/protocol"
import { Paths } from "@cloudagents/protocol"
import { cn } from "../cn"
import { Collapse } from "./Collapse"
import { formatMessageTime } from "./time"
import { useTranscriptHost } from "./host"
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

/** One saved clip: its poster while paused, playback after, and the caption the recorder was given. */
function EvidenceClip({ run, clip }: { run: Run; clip: RunClip }) {
  const host = useTranscriptHost()
  const media = host.useFileLink(run.taskId, Paths.taskRunClip(run.taskId, run.id, clip.id))
  // Called unconditionally: a clip with no poster still resolves the MP4 path, which is simply unused.
  const poster = host.useFileLink(run.taskId, Paths.taskRunClip(run.taskId, run.id, clip.poster ?? clip.id))
  const [failedUrl, setFailedUrl] = useState<string | null>(null)
  const url = media.url
  const failed = url !== undefined && failedUrl === url
  return (
    <figure className="max-w-md">
      {url === undefined ? (
        // The host is still minting the URL: a skeleton, not a failure.
        <div aria-label="Loading clip" className="h-40 w-full animate-pulse rounded-lg border border-border bg-muted" />
      ) : failed ? (
        <div className="flex h-40 w-full items-center justify-center rounded-lg border border-border bg-muted text-sm text-muted-foreground">
          Video unavailable
        </div>
      ) : (
        <video
          controls
          preload="metadata"
          src={url}
          poster={clip.poster === null ? undefined : poster.url}
          onError={() => {
            setFailedUrl(url)
            media.onError()
          }}
          className="w-full rounded-lg border border-border bg-black"
        />
      )}
      <figcaption className="mt-1.5 text-sm text-muted-foreground">
        {clip.caption}
        <span aria-hidden="true"> · </span>
        <span>{duration(clip.durationMs)}</span>
      </figcaption>
    </figure>
  )
}

/** The run's wall-clock work time; NaN when it has no trustworthy end (still going, unparseable, or a restart). */
function workedMs(run: Run): number {
  const elapsed = run.endedAt === null ? NaN : Date.parse(run.endedAt) - Date.parse(run.startedAt)
  return !run.interruptedByRestart && Number.isFinite(elapsed) && elapsed >= 0 ? elapsed : NaN
}

/** A finished run's token totals and rate, behind its summary line. */
export function RunUsage({ run, items }: { run: Run; items: readonly AgentItem[] }) {
  const elapsed = workedMs(run)
  // A failed/stopped invocation can end without a final usage report. Do not call a completed prefix its total.
  const complete = run.status === "succeeded" && items.at(-1)?._tag === "turn"
  const { input, output, cached } = complete ? tokenTotals(items) : { input: null, output: null, cached: null }
  const rate = elapsed > 0 && output !== null ? output * 1000 / elapsed : null
  return (
    <dl className="grid w-fit grid-cols-[auto_auto] gap-x-5 gap-y-1 text-sm text-muted-foreground">
      <dt>Input tokens</dt><dd title={input === null ? undefined : EXACT.format(input)}>{count(input)}</dd>
      <dt>Output tokens</dt><dd title={output === null ? undefined : EXACT.format(output)}>{count(output)}</dd>
      <dt>Cached tokens</dt><dd title={cached === null ? undefined : EXACT.format(cached)}>{count(cached)}</dd>
      <dt>Avg TPS</dt><dd title="Output tokens per second over the run's wall-clock time, including tools and waiting">{rate !== null && Number.isFinite(rate) ? `${rate.toLocaleString("en-US", { maximumFractionDigits: 1 })} tok/s` : "Not reported"}</dd>
    </dl>
  )
}

/** One summary per harness invocation, using Kestrel's lifecycle clock for every harness. */
export function RunSummary({ run, items }: { run: Run; items: readonly AgentItem[] }) {
  const [open, setOpen] = useState(false)
  if (run.status === "running") return null
  const clips = run.evidence?.clips ?? []
  const elapsed = workedMs(run)
  const label = run.interruptedByRestart ? "Interrupted by restart" : run.status === "cancelled" ? "Stopped" : run.status === "failed" ? "Failed" : "Worked"
  return (
    <div className="flex flex-col gap-2 tabular-nums">
      {clips.length > 0 && (
        <div className="flex flex-col gap-3">
          <h4 className="text-xs font-medium tracking-wide text-muted-foreground uppercase">Saved evidence</h4>
          {clips.map((clip) => <EvidenceClip key={clip.id} run={run} clip={clip} />)}
        </div>
      )}
      <button type="button" aria-expanded={open} onClick={() => setOpen(!open)} className={cn(ROW_CLASS, "w-fit")}>
        <span>
          {label}{Number.isNaN(elapsed) ? "" : ` for ${duration(elapsed)}`}
          {run.endedAt !== null && <><span aria-hidden="true"> · </span><time dateTime={run.endedAt}>{formatMessageTime(run.endedAt)}</time></>}
        </span>
        <Chevron open={open} />
      </button>
      <Collapse open={open} className={DETAILS_CLASS}>
        <RunUsage run={run} items={items} />
      </Collapse>
    </div>
  )
}
