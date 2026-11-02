import { useMemo } from "react"
import { useQuery } from "@tanstack/react-query"
import { describeTool, liveItemIds, summarizeTools, type AgentItem, type ToolItem } from "@cloudagents/protocol"
import { queries } from "@/api/queries"
import { cn } from "@/lib/utils"
import { Alert } from "@/components/ui/alert"
import { Markdown } from "./Markdown"
import { ThinkingBlock, ToolGroup, ToolRow, type RunSource } from "./WorkLog"

interface Props {
  taskId: string
  runId: string
  /** The run is still going: its last item may still be streaming. */
  running: boolean
}

interface Tree {
  roots: readonly AgentItem[]
  children: ReadonlyMap<string, readonly AgentItem[]>
}

interface Ctx {
  readonly source: RunSource
  readonly tree: Tree
  readonly liveIds: ReadonlySet<string>
  readonly running: boolean
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

function turnSummary(item: Extract<AgentItem, { _tag: "turn" }>): string {
  const parts: string[] = []
  if (item.durationMs !== null) parts.push(`${(item.durationMs / 1000).toFixed(1)}s`)
  if (item.inputTokens !== null || item.outputTokens !== null) {
    parts.push(`${item.inputTokens ?? "?"} in · ${item.outputTokens ?? "?"} out`)
  }
  if (item.costUsd !== null) parts.push(`$${item.costUsd.toFixed(4)}`)
  if (item.isError) parts.push("failed")
  return parts.join(" · ")
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
    case "turn": {
      const summary = turnSummary(item)
      if (summary === "") return null
      return (
        <div
          className={cn(
            "flex items-center gap-1.5 text-[11px] text-muted-foreground",
            item.isError && "text-destructive",
          )}
        >
          {summary}
        </div>
      )
    }
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
export function RunTranscript({ taskId, runId, running }: Props) {
  const { data } = useQuery(queries.runItems(taskId, runId))
  const tree = useMemo(() => buildTree(data ?? []), [data])
  const liveIds = useMemo(() => liveItemIds(data ?? [], running), [data, running])
  const source = useMemo(() => ({ taskId, runId }), [taskId, runId])

  if (data === undefined || data.length === 0) return null

  return <Items items={tree.roots} ctx={{ source, tree, liveIds, running }} />
}
