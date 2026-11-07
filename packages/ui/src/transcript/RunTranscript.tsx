import { useMemo } from "react"
import { describeTool, liveItemIds, summarizeTools, type AgentItem, type ToolItem } from "@cloudagents/protocol"
import { Alert } from "../alert"
import { Markdown } from "./Markdown"
import { ThinkingBlock, ToolGroup, ToolRow, type RunSource } from "./WorkLog"
import { formatMessageTime } from "./time"

interface Props {
  taskId: string
  runId: string
  /** The run's items in arrival order, as far as they have loaded. */
  items: readonly AgentItem[]
  /** The run is still going: its last item may still be streaming. */
  running: boolean
  /** The part of the run's items to show: positions `from` up to `to` (null: the end). A tool keeps its subagent items. */
  from: number
  to: number | null
  /** Completion time for saved turns that predate per-item timestamps. */
  fallbackTimestamp: string
}

interface Tree {
  roots: readonly AgentItem[]
  children: ReadonlyMap<string, readonly AgentItem[]>
}

interface Ctx {
  readonly source: RunSource
  readonly tree: Tree
  readonly liveIds: ReadonlySet<string>
  readonly turnTotals: ReadonlySet<string>
  readonly running: boolean
  readonly fallbackTimestamp: string
}

/** Items in arrival order; a tool's subagent items (`parentToolId`) hang under it instead of the top level. */
function buildTree(items: readonly AgentItem[]): Tree {
  const toolIds = new Set(items.filter((item) => item._tag === "tool").map((item) => item.id))
  const roots: AgentItem[] = []
  const children = new Map<string, AgentItem[]>()
  for (const item of items) {
    const parentToolId = item._tag === "turn" || item._tag === "error" ? null : item.parentToolId
    if (parentToolId !== null && toolIds.has(parentToolId)) {
      const list = children.get(parentToolId) ?? []
      list.push(item)
      children.set(parentToolId, list)
    } else {
      roots.push(item)
    }
  }
  return { roots, children }
}

const COMPACT_TOKENS = new Intl.NumberFormat("en", { notation: "compact", maximumFractionDigits: 1 })
const EXACT_TOKENS = new Intl.NumberFormat("en")

/** A token count in the response strip; its exact value is the title when compacted, `?` when not reported. */
function TokenCount({ value, label }: { value: number | null; label: string }) {
  if (value === null) return <span title={`${label} not reported`}>? {label}</span>
  const text = COMPACT_TOKENS.format(value)
  const exact = EXACT_TOKENS.format(value)
  return <span title={text === exact ? undefined : exact}>{text} {label}</span>
}

/**
 * Output tokens per second over a measured duration. A response's rate covers that response; a turn's covers the
 * whole turn, tool execution included, so it says so.
 */
function Throughput({ output, durationMs, turn = false }: { output: number | null; durationMs: number | null | undefined; turn?: boolean }) {
  const rate = output !== null && durationMs != null && durationMs > 0
    ? output * 1000 / durationMs
    : null
  return (
    <span title={turn ? "Output tokens per second over the whole turn, including tool execution" : "Output tokens per second of this response"}>
      {turn && "turn "}
      {rate !== null && Number.isFinite(rate) ? rate.toLocaleString("en-US", { maximumFractionDigits: 1 }) : "?"} tok/s
    </span>
  )
}

/** One response's usage: when it finished, and its own tokens — never the run's totals. */
function UsageStrip({ item }: { item: Extract<AgentItem, { _tag: "usage" }> }) {
  return (
    <div className="flex flex-wrap items-center gap-1.5 text-[11px] text-muted-foreground tabular-nums">
      <time dateTime={item.timestamp}>{formatMessageTime(item.timestamp)}</time>
      <span aria-hidden="true">·</span>
      <TokenCount value={item.inputTokens} label="in" />
      <span aria-hidden="true">·</span>
      <TokenCount value={item.outputTokens} label="out" />
      <span aria-hidden="true">·</span>
      <TokenCount value={item.cachedTokens} label="cached" />
      <span aria-hidden="true">·</span>
      <Throughput output={item.outputTokens} durationMs={item.durationMs} />
    </div>
  )
}

/** A run of consecutive tool calls under one group, which shows a summary line once there are two or more. */
function Tools({ items, ctx }: { items: readonly ToolItem[]; ctx: Ctx }) {
  const views = items.map((item) => describeTool(item, ctx.source.taskId))
  const rows = items.map((item, index) => {
    const nested = ctx.tree.children.get(item.id)
    return (
      <ToolRow
        key={item.id}
        item={item}
        view={views[index]!}
        source={ctx.source}
        running={ctx.running}
        nested={nested !== undefined && <Items items={nested} ctx={ctx} />}
      />
    )
  })
  const last = items[items.length - 1]!
  const live = ctx.running && (ctx.liveIds.has(last.id) || items.some((item) => item.status === "running"))
  return (
    <ToolGroup
      single={items.length === 1}
      summary={summarizeTools(views)}
      kinds={new Set(views.map((view) => view.kind))}
      live={live}
      failed={items.some((item) => item.status === "error")}
    >
      {rows}
    </ToolGroup>
  )
}

function ItemView({ item, ctx }: { item: Exclude<AgentItem, ToolItem>; ctx: Ctx }) {
  switch (item._tag) {
    case "text":
      return <Markdown text={item.text} />
    case "thinking":
      return <ThinkingBlock text={item.text} live={ctx.liveIds.has(item.id)} />
    case "usage":
      return <UsageStrip item={item} />
    case "turn":
      return (
        <>
          {ctx.turnTotals.has(item.id) && (
            <div className="flex flex-wrap items-center gap-1.5 text-[11px] text-muted-foreground tabular-nums">
              <time dateTime={item.timestamp ?? ctx.fallbackTimestamp}>{formatMessageTime(item.timestamp ?? ctx.fallbackTimestamp)}</time>
              {(item.inputTokens !== null || item.outputTokens !== null) && (
                <>
                  <span aria-hidden="true">·</span>
                  <TokenCount value={item.inputTokens} label="in" />
                  <span aria-hidden="true">·</span>
                  <TokenCount value={item.outputTokens} label="out" />
                  <span aria-hidden="true">·</span>
                  <Throughput output={item.outputTokens} durationMs={item.durationMs} turn />
                </>
              )}
            </div>
          )}
          {item.isError && <div className="text-[11px] text-destructive">failed</div>}
        </>
      )
    case "error":
      return <Alert>{item.text}</Alert>
  }
}

/** Items in order, with each run of consecutive tool calls gathered into one `Tools` block. */
function Items({ items, ctx }: { items: readonly AgentItem[]; ctx: Ctx }) {
  const blocks: Array<Exclude<AgentItem, ToolItem> | ToolItem[]> = []
  for (const item of items) {
    const last = blocks[blocks.length - 1]
    if (item._tag !== "tool") blocks.push(item)
    else if (Array.isArray(last)) last.push(item)
    else blocks.push([item])
  }
  return (
    <div className="flex min-w-0 flex-col gap-2">
      {blocks.map((block) =>
        Array.isArray(block) ? (
          <Tools key={block[0]!.id} items={block} ctx={ctx} />
        ) : (
          <ItemView key={block.id} item={block} ctx={ctx} />
        ),
      )}
    </div>
  )
}

/** One run's normalized items, in order: the agent's reply as markdown, with thinking and tools collapsed. */
export function RunTranscript({ taskId, runId, items, running, from, to, fallbackTimestamp }: Props) {
  const tree = useMemo(() => buildTree(items), [items])
  const liveIds = useMemo(() => liveItemIds(items, running), [items, running])
  // Inspect the whole run before slicing: a response strip can live in an earlier message segment.
  const turnTotals = useMemo(() => {
    const totals = new Set<string>()
    let hasResponseUsage = false
    for (const item of items) {
      if (item._tag === "usage" && item.parentToolId === null) hasResponseUsage = true
      if (item._tag !== "turn") continue
      if (!hasResponseUsage) totals.add(item.id)
      hasResponseUsage = false
    }
    return totals
  }, [items])
  const source = useMemo(() => ({ taskId, runId }), [taskId, runId])
  const roots = useMemo(() => {
    const position = new Map(items.map((item, index) => [item.id, index]))
    return tree.roots.filter((item) => {
      const at = position.get(item.id)!
      return at >= from && (to === null || at < to)
    })
  }, [items, tree, from, to])

  if (roots.length === 0) return null

  return <Items items={roots} ctx={{ source, tree, liveIds, turnTotals, running, fallbackTimestamp }} />
}
