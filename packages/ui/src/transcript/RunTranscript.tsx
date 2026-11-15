import { useMemo } from "react"
import {
  describeTool,
  itemParent,
  liveItemIds,
  summarizeTools,
  withSubagentItems,
  type AgentItem,
  type SubagentItem,
  type ToolItem,
  type ToolView,
} from "@cloudagents/protocol"
import { Alert } from "../alert"
import { Markdown } from "./Markdown"
import { SubagentRow, ThinkingBlock, ToolGroup, ToolRow, type RunSource } from "./WorkLog"

interface Props {
  taskId: string
  runId: string
  /**
   * The run's items in arrival order, as far as they have loaded: all of them, or only the main agent's (each subagent
   * as its `subagent` item, `Paths.runItems` scope `main`).
   */
  items: readonly AgentItem[]
  /** The run is still going: its last item may still be streaming. */
  running: boolean
  /** The main agent's items to show: positions `from` up to `to` (null: the end), see `TranscriptSegment`. */
  from: number
  to: number | null
}

/** A tool call or a subagent: consecutive ones gather under one summary line. */
type Step = ToolItem | SubagentItem

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

/** Items in arrival order; a subagent's items (`parentToolId`) hang under it instead of the top level. */
function buildTree(items: readonly AgentItem[]): Tree {
  const roots: AgentItem[] = []
  const children = new Map<string, AgentItem[]>()
  for (const item of items) {
    const parent = itemParent(item)
    if (parent === null) {
      roots.push(item)
      continue
    }
    const list = children.get(parent) ?? []
    list.push(item)
    children.set(parent, list)
  }
  return { roots, children }
}

const subagentView = (item: SubagentItem): ToolView => ({ kind: "agent", label: `Subagent: ${item.title}`, code: false, paths: [] })

/** A run of consecutive steps under one group, which shows a summary line once there are two or more. */
function Steps({ items, ctx }: { items: readonly Step[]; ctx: Ctx }) {
  const views = items.map((item) => (item._tag === "tool" ? describeTool(item, ctx.source.taskId) : subagentView(item)))
  const rows = items.map((item, index) => {
    if (item._tag === "tool") return <ToolRow key={item.id} item={item} view={views[index]!} source={ctx.source} running={ctx.running} />
    const own = ctx.tree.children.get(item.id)
    return (
      <SubagentRow
        key={item.id}
        item={item}
        source={ctx.source}
        running={ctx.running}
        nested={own !== undefined && <Items items={own} ctx={ctx} />}
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
      failedCount={items.reduce((count, item) => count + (item.status === "error" || item.status === "failed" ? 1 : 0), 0)}
    >
      {rows}
    </ToolGroup>
  )
}

function ItemView({ item, ctx }: { item: Exclude<AgentItem, Step>; ctx: Ctx }) {
  switch (item._tag) {
    case "text":
      return <Markdown text={item.text} />
    case "thinking":
      return <ThinkingBlock text={item.text} live={ctx.liveIds.has(item.id)} />
    case "usage":
      return null
    case "turn":
      return item.isError ? <div className="text-[11px] text-destructive">failed</div> : null
    case "error":
      return <Alert>{item.text}</Alert>
  }
}

/** Items in order, with each run of consecutive tool calls and subagents gathered into one `Steps` block. */
function Items({ items, ctx }: { items: readonly AgentItem[]; ctx: Ctx }) {
  const blocks: Array<Exclude<AgentItem, Step> | Step[]> = []
  for (const item of items) {
    // Metadata must not split otherwise consecutive steps or add empty layout rows.
    if (item._tag === "usage" || (item._tag === "turn" && !item.isError)) continue
    const last = blocks[blocks.length - 1]
    if (item._tag !== "tool" && item._tag !== "subagent") blocks.push(item)
    else if (Array.isArray(last)) last.push(item)
    else blocks.push([item])
  }
  return (
    <div className="flex min-w-0 flex-col gap-2">
      {blocks.map((block) =>
        Array.isArray(block) ? (
          <Steps key={block[0]!.id} items={block} ctx={ctx} />
        ) : (
          <ItemView key={block.id} item={block} ctx={ctx} />
        ),
      )}
    </div>
  )
}

function useCtx(taskId: string, runId: string, items: readonly AgentItem[], running: boolean): Ctx {
  const tree = useMemo(() => buildTree(items), [items])
  const liveIds = useMemo(() => liveItemIds(items, running), [items, running])
  return useMemo(() => ({ source: { taskId, runId }, tree, liveIds, running }), [taskId, runId, tree, liveIds, running])
}

/** One run's normalized items, in order: the agent's reply as markdown, with thinking, tools and subagents collapsed. */
export function RunTranscript({ taskId, runId, items, running, from, to }: Props) {
  // Runs recorded before subagent items have only the calls that started them.
  const shown = useMemo(() => withSubagentItems(items, taskId, running), [items, taskId, running])
  const ctx = useCtx(taskId, runId, shown, running)
  const roots = ctx.tree.roots.slice(from, to ?? undefined)
  if (roots.length === 0) return null
  return <Items items={roots} ctx={ctx} />
}

/**
 * A subagent's own work: its items, laid out as the thread lays out the main agent's. `items` holds what the run's
 * subagents did (`Paths.runItems` scope `subagents`), or all of the run's items.
 */
export function SubagentTranscript({ taskId, runId, items, running, subagentId }: {
  taskId: string
  runId: string
  items: readonly AgentItem[]
  running: boolean
  subagentId: string
}) {
  const ctx = useCtx(taskId, runId, items, running)
  const own = ctx.tree.children.get(subagentId)
  if (own === undefined) return null
  return <Items items={own} ctx={ctx} />
}
