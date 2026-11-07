import { useEffect, useState } from "react"
import { Link } from "react-router-dom"
import { useMutation, useQueries, useQuery, useQueryClient } from "@tanstack/react-query"
import { ChevronRight, X } from "lucide-react"
import { describeTool, threadChoiceRun, type AgentItem, type ContextUsage, type Message, type Run, type SendMessageBody, type Task, type TaskStatus } from "@cloudagents/protocol"
import { Transcript } from "@cloudagents/ui/transcript"
import { api } from "@/api/client"
import { keys, queries, upsert } from "@/api/queries"
import { cn } from "@/lib/utils"
import { threadPath } from "@/routes"
import { formatElapsed } from "@/util"
import { ArchivedNotice } from "./ArchivedNotice"
import { Composer, type ElementContext } from "./Composer"
import { StatusIcon } from "./StatusIcon"
import { UsageLimitNotice } from "./UsageLimitNotice"

interface Props {
  taskId: string
  taskStatus: TaskStatus | undefined
  messages: readonly Message[]
  runs: readonly Run[]
  /** Failed initial snapshots replace the empty transcript, not the composer or its draft. */
  loadError: string | null
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
/** How often an active delegated thread's runs and latest activity are refetched: its events stream only to its own view. */
const DELEGATION_POLL_MS = 5000

/** The run's time so far, redrawn every second; a finished run's fixed duration. */
function Elapsed({ startedAt, endedAt }: { startedAt: string; endedAt?: string | null }) {
  const [now, setNow] = useState(Date.now)
  const ended = endedAt ?? undefined
  useEffect(() => {
    if (ended !== undefined) return
    const id = window.setInterval(() => setNow(Date.now()), ELAPSED_TICK_MS)
    return () => window.clearInterval(id)
  }, [ended])
  return <span className="tabular-nums">{formatElapsed(Date.parse(startedAt), ended === undefined ? now : Date.parse(ended))}</span>
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

/** One line of what a delegated run is doing: its latest report, tool call, or the last line of its prose. */
function latestActivity(items: readonly AgentItem[] | undefined, taskId: string): string | undefined {
  for (const item of [...(items ?? [])].reverse()) {
    if (item._tag === "tool") {
      const view = describeTool(item, taskId)
      return view.icon === "message" ? view.note ?? view.label : view.label
    }
    if (item._tag === "text" && item.parentToolId === null) {
      const line = item.text.split("\n").map((l) => l.replace(/^[\s#>*-]+/, "").replaceAll("**", "").replaceAll("`", "").trim()).filter((l) => l !== "").at(-1)
      if (line !== undefined) return line
    }
  }
  return undefined
}

interface ChildView {
  task: Task
  /** The thread's newest run: a follow-up after the delegated run continues the same work. */
  run: Run | undefined
  /** StatusIcon status. */
  icon: string
  label: string
  active: boolean
  activity: string | undefined
}

function DelegatedCard({ child, onCancel, cancelling }: { child: ChildView; onCancel: () => void; cancelling: boolean }) {
  return (
    <div className="flex min-w-0 flex-col gap-1 rounded-lg bg-white/[0.04] px-2.5 py-2">
      <div className="flex items-center gap-1.5 [&_svg]:size-3.5">
        <StatusIcon status={child.icon} />
        <Link to={threadPath(child.task.id)} className="min-w-0 flex-1 truncate font-medium hover:underline">{child.task.title}</Link>
        {child.run && <span className="font-mono text-[11px] text-muted-foreground"><Elapsed startedAt={child.run.startedAt} endedAt={child.run.endedAt} /></span>}
        <button type="button" aria-label={`Cancel ${child.task.title}`} title="Cancel" className="rounded text-muted-foreground hover:text-foreground disabled:opacity-50" disabled={cancelling} onClick={onCancel}>
          <X />
        </button>
      </div>
      <div className="line-clamp-2 text-muted-foreground">{child.activity ?? child.label}</div>
    </div>
  )
}

/**
 * Delegated threads are independent conversations; their original run stays linked even after follow-ups. One header
 * line sums them up; open, active ones show as cards with their latest activity and finished ones as compact rows. It
 * opens by itself while any is active and closes when all finish, until the user toggles it.
 */
function DelegatedTasks({ taskId }: { taskId: string }) {
  const tasks = useQuery(queries.tasks()).data ?? []
  const children = tasks.filter((task) => task.delegation?.parentTaskId === taskId)
  const runs = useQueries({
    queries: children.map((task) => ({
      ...queries.runs(task.id),
      refetchInterval: (query: { state: { data: readonly Run[] | undefined } }) =>
        task.status === "running" || task.status === "needs_input" || query.state.data?.some((r) => r.status === "running") ? DELEGATION_POLL_MS : false,
    })),
  })
  const latestRuns = runs.map((query) => query.data?.reduce<Run | undefined>((latest, r) => (latest === undefined || r.startedAt > latest.startedAt ? r : latest), undefined))
  const items = useQueries({
    queries: children.map((task, index) => {
      const run = latestRuns[index]
      return { ...queries.runItems(task.id, run?.id ?? ""), enabled: run?.status === "running", refetchInterval: DELEGATION_POLL_MS }
    }),
  })
  const queryClient = useQueryClient()
  const cancel = useMutation({
    mutationFn: (childId: string) => api.cancelDelegation(taskId, childId),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: keys.tasks }),
  })
  const [toggled, setToggled] = useState<boolean>()
  if (children.length === 0) return null

  const views: ChildView[] = children.map((child, index) => {
    const delegated = runs[index]?.data?.find((r) => r.id === child.delegation?.runId)
    const latest = latestRuns[index]
    const cancelled = child.delegation?.cancelledAt !== undefined
    const nestedActive = tasks.some((task) => task.delegation?.parentRunId === delegated?.id && task.delegation?.cancelledAt === undefined && (task.status === "running" || task.status === "needs_input"))
    const continuing = delegated?.status === "succeeded" && child.status === "running"
    const label = cancelled ? "Cancelled" : child.status === "needs_input" ? "Needs input" : delegated?.status === "succeeded" && nestedActive ? "Waiting for children" : continuing ? "Continuing" : delegated?.status ?? (child.status === "failed" ? "Failed to start" : "Starting")
    const active = !cancelled && (delegated === undefined ? child.status !== "failed" : delegated.status === "running" || nestedActive || continuing || child.status === "needs_input")
    const icon = cancelled ? "cancelled" : child.status === "needs_input" ? "needs_input" : active ? "running" : delegated?.status ?? "failed"
    const activity = latest?.status === "running" ? latestActivity(items[index]?.data, child.id) : undefined
    return { task: child, run: latest, icon, label, active, activity }
  })
  const active = views.filter((v) => v.active)
  const finished = views.filter((v) => !v.active)
  const open = toggled ?? active.length > 0
  const counts = new Map<string, number>()
  for (const v of finished) counts.set(v.label, (counts.get(v.label) ?? 0) + 1)
  const summary = [...counts].map(([label, n]) => `${n} ${label.toLowerCase()}`).join(" · ")

  return (
    <section aria-label="Delegated tasks" className="mb-5 w-full max-w-3xl rounded-xl border border-white/10 text-xs">
      <button type="button" aria-expanded={open} className="flex w-full items-center gap-1.5 px-3 py-1.5 text-left text-muted-foreground hover:text-foreground [&_svg]:size-3.5" onClick={() => setToggled(!open)}>
        <ChevronRight className={cn("shrink-0 transition-transform", open && "rotate-90")} />
        {active.length > 0 && <StatusIcon status="running" />}
        <span className="font-medium text-foreground">{active.length > 0 ? `Waiting on ${active.length} delegated ${active.length === 1 ? "task" : "tasks"}` : "Delegated tasks"}</span>
        <span className="min-w-0 flex-1 truncate text-right">{summary}</span>
      </button>
      {open && (
        <div className="space-y-2 px-2 pb-2">
          {active.length > 0 && (
            <div className="grid max-h-40 grid-cols-[repeat(auto-fill,minmax(14rem,1fr))] gap-1.5 overflow-y-auto">
              {active.map((v) => <DelegatedCard key={v.task.id} child={v} cancelling={cancel.isPending} onCancel={() => cancel.mutate(v.task.id)} />)}
            </div>
          )}
          {finished.length > 0 && (
            <div className="max-h-32 space-y-0.5 overflow-y-auto px-1">
              {finished.map((v) => (
                <div key={v.task.id} className="flex items-center gap-1.5 [&_svg]:size-3">
                  <StatusIcon status={v.icon} />
                  <Link to={threadPath(v.task.id)} className="min-w-0 flex-1 truncate text-muted-foreground hover:text-foreground hover:underline">{v.task.title}</Link>
                  {v.run && <span className="font-mono text-[11px] text-muted-foreground"><Elapsed startedAt={v.run.startedAt} endedAt={v.run.endedAt} /></span>}
                </div>
              ))}
            </div>
          )}
          {cancel.isError && <div role="alert" className="px-1 text-destructive">Could not cancel the task.</div>}
        </div>
      )}
    </section>
  )
}

export function ChatPanel({ taskId, taskStatus, messages, runs, loadError, archivedTask, elements, onElementsChange, context }: Props) {
  const queryClient = useQueryClient()
  // Keep `#` references scoped to the selected repository before the agent makes its first checkout.
  const task = useQuery(queries.task(taskId))
  const checkoutRepos = (task.data?.checkouts ?? []).map((checkout) => checkout.repo)
  const referenceRepos = checkoutRepos.length === 0 && task.data?.pickedRepo
    ? [task.data.pickedRepo]
    : checkoutRepos

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
      {task.data?.usageLimitResume !== undefined && (
        <div className="px-5 pt-10">
          <UsageLimitNotice task={task.data} />
        </div>
      )}
      {/* While the working indicator is up it covers the thread's last lines; the extra padding keeps them clear of it. */}
      {loadError ? (
        <div role="alert" className="flex min-h-0 flex-1 items-center justify-center p-8 text-center text-sm text-muted-foreground">
          {loadError}
        </div>
      ) : (
        <Transcript
          taskId={taskId}
          messages={messages}
          runs={runs}
          runItems={runItems}
          pendingAskId={pendingAsk?.id}
          className={cn("px-5 pt-4", activeRun ? "pb-14" : "pb-4")}
        />
      )}
      <div className="relative flex flex-col items-center px-5 pt-2 pb-5">
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
        {/*
          Above the composer, clear of the context bar's labels on its top edge. No key: ThreadPage remounts the panel
          per thread, and the Composer sibling already uses `taskId` as its key; a duplicate key makes React leave
          stale copies of the strip behind each time the working indicator comes and goes.
        */}
        <DelegatedTasks taskId={taskId} />
        {archivedTask ? (
          <ArchivedNotice task={archivedTask} />
        ) : (
          <Composer
            key={taskId}
            taskId={taskId}
            draftKey={taskId}
            repos={referenceRepos}
            activeRunId={activeRun?.id}
            activeRunProvider={activeRun?.provider}
            activeRunModel={activeRun?.model}
            activeRunHarness={activeRun?.harness}
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
