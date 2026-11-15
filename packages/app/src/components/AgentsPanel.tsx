import { useLayoutEffect, useRef } from "react"
import { useQueries, useQuery } from "@tanstack/react-query"
import { ChevronLeft } from "lucide-react"
import { describeTool, type AgentItem, type Run, type ToolItem } from "@cloudagents/protocol"
import { Markdown } from "@cloudagents/ui/markdown"
import { SubagentTranscript } from "@cloudagents/ui/transcript/run"
import { isSubagentCall, subagentWork } from "@cloudagents/ui/transcript/subagents"
import { queries } from "@/api/queries"
import { StatusIcon } from "./StatusIcon"

/** A harness subagent: its call `toolId` in run `runId`. */
export interface SubagentRef {
  readonly runId: string
  readonly toolId: string
}

interface Agent {
  readonly run: Run
  readonly call: ToolItem
  /** The whole run's items, which hold the subagent's own under its call. */
  readonly items: readonly AgentItem[]
}

/** StatusIcon status: a call still running in a run that ended was stopped with it. */
function agentStatus({ run, call }: Agent): string {
  if (call.status === "error") return "failed"
  if (call.status === "ok") return "succeeded"
  return run.status === "running" ? "running" : "cancelled"
}

/** Within this distance of the bottom, keep following the subagent's new work. */
const STICK_PX = 80

/**
 * The thread's harness subagents (Claude's Task/Agent calls), newest first; one opens to its own work, which the
 * thread itself only sums up in a row. Live events keep the run items current, so a running subagent streams here.
 */
export function AgentsPanel({ taskId, selected, onSelect }: {
  taskId: string
  selected: SubagentRef | undefined
  onSelect: (ref: SubagentRef | undefined) => void
}) {
  const runs = [...(useQuery(queries.runs(taskId)).data ?? [])].sort((a, b) => a.startedAt.localeCompare(b.startedAt))
  const itemQueries = useQueries({ queries: runs.map((run) => queries.runItems(taskId, run.id)) })
  const agents: Agent[] = runs.flatMap((run, index) => {
    const items = itemQueries[index]?.data ?? []
    return items.filter((item) => isSubagentCall(item, taskId)).map((call) => ({ run, call, items }))
  }).reverse()
  const current = selected && agents.find((agent) => agent.run.id === selected.runId && agent.call.id === selected.toolId)

  if (current !== undefined) return <AgentDetail taskId={taskId} agent={current} onBack={() => onSelect(undefined)} />
  if (agents.length === 0) {
    return <p className="p-4 text-sm text-muted-foreground">No subagents in this thread yet. When the agent starts one, its work shows here.</p>
  }
  return (
    <ul className="flex min-h-0 flex-1 flex-col gap-0.5 overflow-auto p-2">
      {agents.map((agent) => {
        const work = subagentWork(agent.items, agent.call.id, taskId)
        const status = agentStatus(agent)
        return (
          <li key={`${agent.run.id}:${agent.call.id}`}>
            <button
              type="button"
              onClick={() => onSelect({ runId: agent.run.id, toolId: agent.call.id })}
              className="flex w-full min-w-0 flex-col gap-0.5 rounded-lg px-2.5 py-2 text-left text-sm hover:bg-white/[0.04]"
            >
              <span className="flex min-w-0 items-center gap-1.5 [&_svg]:size-3.5">
                <StatusIcon status={status} />
                <span className="min-w-0 flex-1 truncate">{describeTool(agent.call, taskId).label}</span>
                <span className="shrink-0 text-xs text-muted-foreground tabular-nums">
                  {work.calls} {work.calls === 1 ? "call" : "calls"}
                  {work.failed > 0 && <span className="text-destructive"> · {work.failed} failed</span>}
                </span>
              </span>
              {work.activity !== undefined && (
                <span className="truncate pl-5 text-xs text-muted-foreground">{work.activity}</span>
              )}
            </button>
          </li>
        )
      })}
    </ul>
  )
}

function AgentDetail({ taskId, agent, onBack }: { taskId: string; agent: Agent; onBack: () => void }) {
  const view = describeTool(agent.call, taskId)
  const status = agentStatus(agent)
  const running = status === "running"
  const scrollRef = useRef<HTMLDivElement>(null)
  const contentRef = useRef<HTMLDivElement>(null)
  const atEnd = useRef(true)

  // Opens at the newest work and follows it while the reader stays at the bottom.
  useLayoutEffect(() => {
    const el = scrollRef.current
    const content = contentRef.current
    if (!el || !content) return
    atEnd.current = true
    const follow = () => {
      if (atEnd.current) el.scrollTop = el.scrollHeight
    }
    follow()
    const observer = new ResizeObserver(follow)
    observer.observe(content)
    return () => observer.disconnect()
  }, [agent.call.id])

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex min-w-0 items-center gap-1.5 border-b border-border px-2 pb-2 text-sm [&_svg]:size-3.5">
        <button
          type="button"
          onClick={onBack}
          aria-label="All subagents"
          title="All subagents"
          className="rounded p-1 text-muted-foreground hover:text-foreground"
        >
          <ChevronLeft />
        </button>
        <StatusIcon status={status} />
        <span className="min-w-0 flex-1 truncate font-medium">{view.label}</span>
      </div>
      <div
        ref={scrollRef}
        onScroll={(event) => {
          const { scrollHeight, scrollTop, clientHeight } = event.currentTarget
          atEnd.current = scrollHeight - scrollTop - clientHeight <= STICK_PX
        }}
        className="min-h-0 flex-1 overflow-auto px-4 py-3"
      >
        <div ref={contentRef} className="flex min-w-0 flex-col gap-4">
          {view.note !== undefined && (
            <details className="group/prompt rounded-lg bg-white/[0.04] px-3 py-2 text-sm">
              <summary className="cursor-pointer text-muted-foreground select-none">Prompt</summary>
              <div className="mt-2 break-words whitespace-pre-wrap text-muted-foreground">{view.note}</div>
            </details>
          )}
          <SubagentTranscript
            taskId={taskId}
            runId={agent.run.id}
            items={agent.items}
            running={agent.run.status === "running"}
            toolId={agent.call.id}
          />
          {!running && agent.call.output !== null && agent.call.output !== "" && (
            <section className="flex flex-col gap-1.5 border-t border-border pt-3">
              <h3 className="text-xs font-medium text-muted-foreground">
                {status === "failed" ? "Failed" : "Report to the main agent"}
              </h3>
              <Markdown text={agent.call.output} />
            </section>
          )}
        </div>
      </div>
    </div>
  )
}
