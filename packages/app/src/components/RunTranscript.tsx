import { useLayoutEffect, useMemo, useRef, useState } from "react"
import { useQuery } from "@tanstack/react-query"
import { Brain, ChevronRight } from "lucide-react"
import { toolDisplayName, type AgentItem } from "@cloudagents/protocol"
import { queries } from "@/api/queries"
import { cn } from "@/lib/utils"
import { liveItemIds } from "@/lib/live-items"
import { Alert } from "@/components/ui/alert"
import { Markdown } from "./Markdown"

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

const PRE_CLASS = "m-0 max-h-72 overflow-auto rounded-lg bg-code px-3 py-2 font-mono text-[11px] break-all whitespace-pre-wrap shadow-well"

const SHIMMER_CLASS =
  "motion-safe:animate-title-shimmer motion-safe:bg-[linear-gradient(90deg,var(--color-muted-foreground)_40%,var(--color-foreground)_50%,var(--color-muted-foreground)_60%)] motion-safe:bg-[length:250%_100%] motion-safe:bg-clip-text motion-safe:text-transparent"

/** How close to the bottom (px) still counts as following the stream. */
const LIVE_EDGE_PX = 16

/**
 * Open while the model is thinking (the item is the run's newest and the run is going), then folds to a "Thought"
 * line once anything follows it. A click takes over: after that the block stays the way the user left it.
 */
function ThinkingBlock({ text, live }: { text: string; live: boolean }) {
  const [userOpen, setUserOpen] = useState<boolean | null>(null)
  const open = userOpen ?? live
  const scrollerRef = useRef<HTMLDivElement>(null)
  const atLiveEdgeRef = useRef(true)

  // Follows the streaming text, unless the user scrolled up to read.
  useLayoutEffect(() => {
    const el = scrollerRef.current
    if (live && atLiveEdgeRef.current && el) el.scrollTop = el.scrollHeight
  }, [live, open, text])

  return (
    <div className="text-muted-foreground">
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setUserOpen(!open)}
        className="flex cursor-pointer items-center gap-1.5 rounded-md text-xs select-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/70 focus-visible:outline-none"
      >
        <Brain className="size-3.5 shrink-0" />
        <span className={cn(live && SHIMMER_CLASS)}>{live ? "Thinking" : "Thought"}</span>
        <ChevronRight className={cn("size-3.5 shrink-0 transition-transform", open && "rotate-90")} />
      </button>
      {open && (
        <div
          ref={scrollerRef}
          onScroll={(event) => {
            const { scrollHeight, scrollTop, clientHeight } = event.currentTarget
            atLiveEdgeRef.current = scrollHeight - scrollTop - clientHeight <= LIVE_EDGE_PX
          }}
          className="mt-1.5 max-h-60 overflow-auto border-l-2 border-border pl-3 text-sm break-words whitespace-pre-wrap italic"
        >
          {text}
        </div>
      )}
    </div>
  )
}

function ItemView({ item, tree, liveIds }: { item: AgentItem; tree: Tree; liveIds: ReadonlySet<string> }) {
  switch (item._tag) {
    case "text":
      return <Markdown text={item.text} />
    case "thinking":
      return <ThinkingBlock text={item.text} live={liveIds.has(item.id)} />
    case "tool":
      return (
        <details className="rounded-xl border border-border bg-card/40 px-3.5 py-2 shadow-soft">
          <summary
            className={cn(
              "cursor-pointer text-xs select-none",
              item.status === "error" && "text-destructive",
            )}
          >
            {toolDisplayName(item.name)} · {item.status}
          </summary>
          <div className="mt-2 flex flex-col gap-2">
            <div className="font-mono text-[11px] break-all text-muted-foreground">{item.name}</div>
            <pre className={PRE_CLASS}>{JSON.stringify(item.input, null, 2)}</pre>
            {item.output !== null && <pre className={PRE_CLASS}>{item.output}</pre>}
            {(tree.children.get(item.id) ?? []).map((child) => (
              <ItemView key={child.id} item={child} tree={tree} liveIds={liveIds} />
            ))}
          </div>
        </details>
      )
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

/** One run's normalized items, in order: the agent's reply as markdown, with thinking and tools collapsed. */
export function RunTranscript({ taskId, runId, running }: Props) {
  const { data } = useQuery(queries.runItems(taskId, runId))
  const tree = useMemo(() => buildTree(data ?? []), [data])
  const liveIds = useMemo(() => liveItemIds(data ?? [], running), [data, running])

  if (data === undefined || data.length === 0) return null

  return (
    <div className="flex flex-col gap-3">
      {tree.roots.map((item) => (
        <ItemView key={item.id} item={item} tree={tree} liveIds={liveIds} />
      ))}
    </div>
  )
}
