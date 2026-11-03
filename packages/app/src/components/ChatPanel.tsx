import { useEffect, useState } from "react"
import { Link } from "react-router-dom"
import { useMutation, useQueries, useQuery, useQueryClient } from "@tanstack/react-query"
import { threadChoiceRun, type AgentItem, type ContextUsage, type Message, type Run, type SendMessageBody, type Task, type TaskStatus } from "@cloudagents/protocol"
import { Transcript } from "@cloudagents/ui/transcript"
import { api } from "@/api/client"
import { keys, queries, upsert } from "@/api/queries"
import { cn } from "@/lib/utils"
import { threadPath } from "@/routes"
import { formatElapsed } from "@/util"
import { ArchivedNotice } from "./ArchivedNotice"
import { Composer, type ElementContext } from "./Composer"
import { StatusIcon } from "./StatusIcon"

interface Props {
  taskId: string
  taskStatus: TaskStatus | undefined
  messages: readonly Message[]
  runs: readonly Run[]
  /** Set while the thread is archived: the composer is replaced by an unarchive notice. */
  archivedTask: Task | undefined
  /** Preview elements attached to the composer as context. */
  elements: readonly ElementContext[]
  onElementsChange: (elements: readonly ElementContext[]) => void
  /** How full the thread's agent session is, shown on the composer. */
  context: ContextUsage | undefined
}

/** How often the running turn's elapsed time is redrawn. */
const ELAPSED_TICK_MS = 1000

/** The run's time so far, redrawn every second. */
function Elapsed({ startedAt }: { startedAt: string }) {
  const [now, setNow] = useState(Date.now)
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), ELAPSED_TICK_MS)
    return () => window.clearInterval(id)
  }, [])
  return <span className="tabular-nums">{formatElapsed(Date.parse(startedAt), now)}</span>
}

/**
 * The running turn's spinner and time so far, anchored just above the composer whatever the thread's scroll position.
 * It sits a row above the context bar's labels (which ride the composer's top edge), so the two never overlap.
 */
function WorkingIndicator({ run }: { run: Run }) {
  return (
    <div className="pointer-events-none absolute inset-x-5 bottom-full z-10 flex justify-center">
      <div className="mb-3 flex w-full max-w-3xl items-center gap-1.5 pl-2 text-[11px] text-muted-foreground [&_svg]:size-3.5">
        <StatusIcon status="running" />
        <span>Working</span>
        <Elapsed startedAt={run.startedAt} />
      </div>
    </div>
  )
}

/** Delegated threads are independent conversations; their original run stays linked even after follow-ups. */
function DelegatedTasks({ taskId }: { taskId: string }) {
  const tasks = useQuery(queries.tasks()).data ?? []
  const children = tasks.filter((task) => task.delegation?.parentTaskId === taskId)
  const runs = useQueries({ queries: children.map((task) => queries.runs(task.id)) })
  const queryClient = useQueryClient()
  const cancel = useMutation({
    mutationFn: (childId: string) => api.cancelDelegation(taskId, childId),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: keys.tasks }),
  })
  if (children.length === 0) return null
  return (
    <section aria-label="Delegated tasks" className="mx-auto mb-3 w-full max-w-3xl rounded-xl border border-white/10 px-3 py-2 text-xs">
      <div className="mb-1.5 font-medium text-muted-foreground">Delegated tasks</div>
      <div className="space-y-1.5">
        {children.map((child, index) => {
          const run = runs[index]?.data?.find((r) => r.id === child.delegation?.runId)
          const nestedActive = tasks.some((task) => task.delegation?.parentRunId === run?.id && task.delegation?.cancelledAt === undefined && (task.status === "running" || task.status === "needs_input"))
          const status = child.delegation?.cancelledAt ? "Cancelled" : child.status === "needs_input" ? "Needs input" : run?.status === "succeeded" && nestedActive ? "Waiting for children" : run?.status === "succeeded" && child.status === "running" ? "Continuing" : run?.status ?? (child.status === "failed" ? "Failed to start" : "Starting")
          return <div key={child.id} className="flex items-center gap-2">
            <Link to={threadPath(child.id)} className="min-w-0 flex-1 truncate hover:underline">{child.title}</Link>
            <span className="text-muted-foreground">{status}</span>
            {!child.delegation?.cancelledAt && (run?.status === "running" || nestedActive || (run?.status === "succeeded" && child.status === "running")) && <button type="button" className="text-muted-foreground hover:text-foreground" disabled={cancel.isPending} onClick={() => cancel.mutate(child.id)}>Cancel</button>}
          </div>
        })}
      </div>
      {cancel.isError && <div role="alert" className="mt-1 text-destructive">Could not cancel the task.</div>}
    </section>
  )
}

export function ChatPanel({ taskId, taskStatus, messages, runs, archivedTask, elements, onElementsChange, context }: Props) {
  const queryClient = useQueryClient()
  // The thread query is already the page's baseline; reading it here gives `#` references the checked-out repositories.
  const task = useQuery(queries.task(taskId))
  const checkoutRepos = (task.data?.checkouts ?? []).map((checkout) => checkout.repo)

  const sortedRuns = [...runs].sort((a, b) => a.startedAt.localeCompare(b.startedAt))
  // Items of every run in the thread; live events keep these cache entries current.
  const runItemQueries = useQueries({ queries: sortedRuns.map((run) => queries.runItems(taskId, run.id)) })
  const runItems: Record<string, readonly AgentItem[]> = {}
  sortedRuns.forEach((run, index) => {
    const items = runItemQueries[index]?.data
    if (items !== undefined) runItems[run.id] = items
  })
  // `task_ask` questions are the messages with `options` (possibly none). The latest one, while the agent is blocked
  // on it, moves into the composer: its screenshot, question and options sit above the box until it is answered.
  const lastAsk = [...messages].sort((a, b) => a.createdAt.localeCompare(b.createdAt)).reverse().find((m) => m.options !== undefined)
  const pendingAsk = taskStatus === "needs_input" ? lastAsk : undefined

  const send = useMutation({
    mutationFn: ({ body, files = [] }: { body: SendMessageBody; files?: readonly File[] }) =>
      api.sendMessage(taskId, body, files),
    onSuccess: (res) => {
      queryClient.setQueryData(keys.messages(taskId), (list: Message[] | undefined) => upsert(list, res.message))
      queryClient.setQueryData(keys.runs(taskId), (list: Run[] | undefined) => upsert(list, res.run))
    },
  })
  const cancel = useMutation({
    mutationFn: (runId: string) => api.cancelRun(taskId, runId),
    onSuccess: (run) => queryClient.setQueryData(keys.runs(taskId), (list: Run[] | undefined) => upsert(list, run)),
  })
  const latestRun = sortedRuns.at(-1)
  const activeRun = latestRun?.status === "running" ? latestRun : undefined

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <DelegatedTasks taskId={taskId} />
      {/* While the working indicator is up it covers the thread's last lines; the extra padding keeps them clear of it. */}
      <Transcript
        taskId={taskId}
        messages={messages}
        runs={runs}
        runItems={runItems}
        pendingAskId={pendingAsk?.id}
        className={cn("px-5 pt-4", activeRun ? "pb-14" : "pb-4")}
      />
      <div className="relative flex justify-center px-5 pt-2 pb-5">
        {activeRun && <WorkingIndicator run={activeRun} />}
        {/*
          A short fade up from the dock's edge, ending just past the context bar's labels (which sit above the
          composer, over the thread), so text scrolling under them softens instead of clashing. While a turn runs it
          is a taller band, solid behind the working indicator and fading out above it, so the thread never shows
          through the indicator's text.
        */}
        <div
          aria-hidden
          className={cn(
            "pointer-events-none absolute inset-x-0 bottom-full bg-linear-to-t from-card to-transparent",
            activeRun ? "h-14 from-60%" : "h-5",
          )}
        />
        {archivedTask ? (
          <ArchivedNotice task={archivedTask} />
        ) : (
          <Composer
            key={taskId}
            taskId={taskId}
            draftKey={taskId}
            repos={checkoutRepos}
            activeRunId={activeRun?.id}
            activeRunProvider={activeRun?.provider}
            lastRun={threadChoiceRun(sortedRuns, messages)}
            onSend={(body, files) => send.mutateAsync({ body, files })}
            pending={send.isPending}
            ask={pendingAsk}
            error={send.error ?? cancel.error}
            onStop={activeRun && (() => cancel.mutate(activeRun.id))}
            stopping={cancel.isPending}
            elements={elements}
            onElementsChange={onElementsChange}
            context={context}
          />
        )}
      </div>
    </div>
  )
}
