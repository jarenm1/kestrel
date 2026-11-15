import { useLayoutEffect, useRef } from "react"
import { useQueries, useQuery } from "@tanstack/react-query"
import { ChevronLeft } from "lucide-react"
import type { Run, SubagentItem } from "@cloudagents/protocol"
import { Markdown } from "@cloudagents/ui/markdown"
import { SubagentTranscript } from "@cloudagents/ui/transcript/run"
import { queries } from "@/api/queries"
import { StatusIcon } from "./StatusIcon"

/** A harness subagent: its `subagent` item `subagentId` in run `runId`. */
export interface SubagentRef {
  readonly runId: string
  readonly subagentId: string
}

interface Agent {
  readonly run: Run
  readonly subagent: SubagentItem
}

/** StatusIcon status: a subagent still running in a run that ended was stopped with it. */
function agentStatus({ run, subagent }: Agent): string {
  switch (subagent.status) {
    case "completed":
      return "succeeded"
    case "failed":
      return "failed"
    case "stopped":
      return "cancelled"
    case "running":
      return run.status === "running" ? "running" : "cancelled"
  }
}

const calls = (subagent: SubagentItem) => `${subagent.calls} ${subagent.calls === 1 ? "call" : "calls"}`

/** Within this distance of the bottom, keep following the subagent's new work. */
const STICK_PX = 80

/**
 * The thread's harness subagents (Claude Code's Agent calls, Codex's subagents), newest first; one opens to its own
 * work, which the thread itself only sums up in a row. The thread's run items hold each subagent's item; what it did
 * loads only when it is opened, and live events keep both current.
 */
export function AgentsPanel({ taskId, selected, onSelect }: {
  taskId: string
  selected: SubagentRef | undefined
  onSelect: (ref: SubagentRef | undefined) => void
}) {
  const runs = [...(useQuery(queries.runs(taskId)).data ?? [])].sort((a, b) => a.startedAt.localeCompare(b.startedAt))
  const itemQueries = useQueries({ queries: runs.map((run) => queries.runItems(taskId, run.id)) })
  const agents: Agent[] = runs.flatMap((run, index) =>
    (itemQueries[index]?.data ?? []).flatMap((item) => (item._tag === "subagent" ? [{ run, subagent: item }] : [])),
  ).reverse()
  const current = selected && agents.find((agent) => agent.run.id === selected.runId && agent.subagent.id === selected.subagentId)

  if (current !== undefined) return <AgentDetail taskId={taskId} agent={current} onBack={() => onSelect(undefined)} />
  if (agents.length === 0) {
    return <p className="p-4 text-sm text-muted-foreground">No subagents in this thread yet. When the agent starts one, its work shows here.</p>
  }
  return (
    <ul className="flex min-h-0 flex-1 flex-col gap-0.5 overflow-auto p-2">
      {agents.map((agent) => (
        <li key={`${agent.run.id}:${agent.subagent.id}`}>
          <button
            type="button"
            onClick={() => onSelect({ runId: agent.run.id, subagentId: agent.subagent.id })}
            className="flex w-full min-w-0 flex-col gap-0.5 rounded-lg px-2.5 py-2 text-left text-sm hover:bg-white/[0.04]"
          >
            <span className="flex min-w-0 items-center gap-1.5 [&_svg]:size-3.5">
              <StatusIcon status={agentStatus(agent)} />
              <span className="min-w-0 flex-1 truncate">Subagent: {agent.subagent.title}</span>
              <span className="shrink-0 text-xs text-muted-foreground tabular-nums">
                {calls(agent.subagent)}
                {agent.subagent.failedCalls > 0 && <span className="text-destructive"> · {agent.subagent.failedCalls} failed</span>}
              </span>
            </span>
            {agent.subagent.activity !== null && (
              <span className="truncate pl-5 text-xs text-muted-foreground">{agent.subagent.activity}</span>
            )}
          </button>
        </li>
      ))}
    </ul>
  )
}

function AgentDetail({ taskId, agent, onBack }: { taskId: string; agent: Agent; onBack: () => void }) {
  const { run, subagent } = agent
  const status = agentStatus(agent)
  const items = useQuery(queries.subagentItems(taskId, run.id))
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
  }, [subagent.id])

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
        <span className="min-w-0 flex-1 truncate font-medium">Subagent: {subagent.title}</span>
        {(subagent.agentType !== null || subagent.model !== null) && (
          <span className="shrink-0 text-xs text-muted-foreground">{[subagent.agentType, subagent.model].filter((part) => part !== null).join(" · ")}</span>
        )}
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
          {subagent.prompt !== null && (
            <details className="group/prompt rounded-lg bg-white/[0.04] px-3 py-2 text-sm">
              <summary className="cursor-pointer text-muted-foreground select-none">Prompt</summary>
              <div className="mt-2 break-words whitespace-pre-wrap text-muted-foreground">{subagent.prompt}</div>
            </details>
          )}
          {items.isPending ? (
            <p className="text-sm text-muted-foreground">Loading its work…</p>
          ) : items.isError ? (
            <p role="alert" className="text-sm text-destructive">Could not load its work.</p>
          ) : (
            <SubagentTranscript
              taskId={taskId}
              runId={run.id}
              items={items.data}
              running={run.status === "running"}
              subagentId={subagent.id}
            />
          )}
          {subagent.result !== null && status !== "running" && (
            <section className="flex flex-col gap-1.5 border-t border-border pt-3">
              <h3 className="text-xs font-medium text-muted-foreground">
                {status === "failed" ? "Failed" : "Report to the main agent"}
              </h3>
              <Markdown text={subagent.result} />
            </section>
          )}
        </div>
      </div>
    </div>
  )
}
