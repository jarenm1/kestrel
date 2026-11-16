import { useLayoutEffect, useRef } from "react"
import { useQuery } from "@tanstack/react-query"
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

/** Within this distance of the bottom, keep following the subagent's new work. */
const STICK_PX = 80

/**
 * One harness subagent's work (Claude Code's Agent call, a Codex subagent), opened from its row in the thread or its
 * card in the dock above the composer, which list them. Its item comes with the run's items; what it did loads only
 * when it is opened, and live events keep both current.
 */
export function AgentsPanel({ taskId, selected }: { taskId: string; selected: SubagentRef | undefined }) {
  const run = useQuery(queries.runs(taskId)).data?.find((candidate) => candidate.id === selected?.runId)
  const items = useQuery({ ...queries.runItems(taskId, selected?.runId ?? ""), enabled: selected !== undefined }).data
  const subagent = items?.find((item): item is SubagentItem => item._tag === "subagent" && item.id === selected?.subagentId)
  if (run === undefined || subagent === undefined) {
    return <p className="p-4 text-sm text-muted-foreground">Open a subagent from its row in the thread, or from the list above the composer, to see its work here.</p>
  }
  return <AgentDetail taskId={taskId} agent={{ run, subagent }} />
}

function AgentDetail({ taskId, agent }: { taskId: string; agent: Agent }) {
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
      <div className="flex min-w-0 items-center gap-1.5 border-b border-border px-3 pb-2 text-sm [&_svg]:size-3.5">
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
