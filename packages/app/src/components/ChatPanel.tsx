import { Fragment, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react"
import { Link } from "react-router-dom"
import { useMutation, useQueries, useQuery, useQueryClient } from "@tanstack/react-query"
import { transcriptSegments, type ContextUsage, type Message, type Run, type SendMessageBody, type Task, type TaskStatus } from "@cloudagents/protocol"
import { CircleDot, GitPullRequest } from "lucide-react"
import { api } from "@/api/client"
import { keys, queries, upsert } from "@/api/queries"
import { githubReferenceLabel, githubReferenceUrl, parseGithubReferenceDraft } from "@cloudagents/composer/reference"
import { cn } from "@/lib/utils"
import { threadPath } from "@/routes"
import { formatClock, formatElapsed } from "@/util"
import { ArchivedNotice } from "./ArchivedNotice"
import { Composer, type ElementContext } from "./Composer"
import { Markdown } from "./Markdown"
import { MessageAttachments } from "./MessageAttachments"
import { RunTranscript } from "./RunTranscript"
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

const ENTER_CLASS = "animate-in duration-300 fade-in slide-in-from-bottom-1"

/** How often the running turn's elapsed time is redrawn. */
const ELAPSED_TICK_MS = 1000

/** Within this distance of the bottom, keep following new content. */
const STICK_PX = 80

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

/** Under an agent reply: the time it was sent. */
function MessageTime({ iso }: { iso: string }) {
  return <div className="mt-1.5 text-[11px] text-muted-foreground">{formatClock(iso)}</div>
}

/** A sent message keeps its text as written; only exact reference Markdown becomes the same inline chip the editor showed. */
function UserMessageText({ text }: { text: string }) {
  const segments = parseGithubReferenceDraft(text)
  if (!segments.some((segment) => segment.type === "reference")) return <>{text}</>
  return (
    <>
      {segments.map((segment, index) =>
        segment.type === "text" ? (
          <Fragment key={index}>{segment.text}</Fragment>
        ) : (
          <a
            key={index}
            href={githubReferenceUrl(segment.reference)}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-baseline gap-1 whitespace-nowrap font-semibold underline underline-offset-4"
          >
            {segment.reference.kind === "pr" ? (
              <GitPullRequest aria-hidden="true" className="relative top-0.5 size-3.5 shrink-0 self-center" />
            ) : (
              <CircleDot aria-hidden="true" className="relative top-0.5 size-3.5 shrink-0 self-center" />
            )}
            {githubReferenceLabel(segment.reference.kind, segment.reference.number)}
          </a>
        ),
      )}
    </>
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

/** `children`: what hangs off a message (attachments), shown under its text. */
function ThreadItem({
  message,
  hideText = false,
  children,
}: {
  message: Message
  /** The run transcript already renders this text; only what hangs off the message stays. */
  hideText?: boolean
  children?: ReactNode
}) {
  switch (message.role) {
    case "user":
      return (
        <div className={cn("flex flex-col items-end", ENTER_CLASS)}>
          {/* Sent by the agent of another of the user's threads (thread_send), not typed by the user. */}
          {message.fromThread && (
            <div className="mb-1 max-w-[85%] truncate text-[11px] text-muted-foreground">
              From the agent of{" "}
              <Link to={threadPath(message.fromThread.id)} className="font-medium hover:underline">
                {message.fromThread.title}
              </Link>
            </div>
          )}
          {/* A message of only attachments has no text bubble. */}
          {message.text !== "" && (
            <div className="max-w-[85%] rounded-2xl bg-white/[0.08] px-4 py-2.5 break-words whitespace-pre-wrap shadow-soft">
              <UserMessageText text={message.text} />
            </div>
          )}
          {children}
        </div>
      )
    case "agent": {
      // A duplicated message only keeps its attachments: the transcript already shows its text.
      if (hideText && (children === undefined || children === null)) return null
      return (
        <div className={ENTER_CLASS}>
          {!hideText && <Markdown text={message.text} />}
          {children}
          {!hideText && <MessageTime iso={message.createdAt} />}
        </div>
      )
    }
    case "system":
      return (
        <div className={cn("self-center text-xs text-muted-foreground italic", ENTER_CLASS)}>
          {message.text}
          {children}
        </div>
      )
  }
}

export function ChatPanel({ taskId, taskStatus, messages, runs, archivedTask, elements, onElementsChange, context }: Props) {
  const queryClient = useQueryClient()
  // The thread query is already the page's baseline; reading it here gives `#` references the checked-out repositories.
  const task = useQuery(queries.task(taskId))
  const checkoutRepos = (task.data?.checkouts ?? []).map((checkout) => checkout.repo)
  const threadRef = useRef<HTMLDivElement>(null)
  const contentRef = useRef<HTMLDivElement>(null)
  const atEnd = useRef(true)

  const sortedMessages = [...messages].sort((a, b) => a.createdAt.localeCompare(b.createdAt))
  // After each user message a run took comes what the run showed until its next one, so a message that steered the run
  // (or waited in its inbox) reads at the point of the transcript where it was sent.
  const segments = transcriptSegments(sortedMessages)
  const sortedRuns = [...runs].sort((a, b) => a.startedAt.localeCompare(b.startedAt))
  // Items of every run in the thread: their count says whether an agent message duplicates its transcript.
  const runItemQueries = useQueries({ queries: sortedRuns.map((run) => queries.runItems(taskId, run.id)) })
  const itemCountByRun = new Map(
    sortedRuns.map((run, index) => [run.id, runItemQueries[index]?.data?.length ?? 0]),
  )
  // `task_ask` questions are the messages with `options` (possibly none). The latest one, while the agent is blocked
  // on it, moves into the composer: its screenshot, question and options sit above the box until it is answered.
  const lastAsk = [...sortedMessages].reverse().find((m) => m.options !== undefined)
  const pendingAsk = taskStatus === "needs_input" ? lastAsk : undefined

  useLayoutEffect(() => {
    const el = threadRef.current
    const content = contentRef.current
    if (!el || !content) return

    // A newly opened thread starts at the bottom, even if the previous thread was paused.
    atEnd.current = true
    const follow = () => {
      if (atEnd.current) el.scrollTop = el.scrollHeight
    }
    follow()
    // Also follow late layout changes, such as images loading and transcript expansion.
    const observer = new ResizeObserver(follow)
    observer.observe(content)
    observer.observe(el)
    return () => observer.disconnect()
  }, [taskId])

  function onThreadScroll() {
    const el = threadRef.current
    if (el) atEnd.current = el.scrollHeight - el.scrollTop - el.clientHeight <= STICK_PX
  }

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
      <div className={cn("min-h-0 flex-1 overflow-auto px-5 pt-4", activeRun ? "pb-14" : "pb-4")} ref={threadRef} onScroll={onThreadScroll}>
        <div ref={contentRef} className="mx-auto flex min-h-full w-full max-w-3xl flex-col gap-5">
          {sortedMessages.length === 0 && (
            <div className="m-auto text-muted-foreground">No messages yet. Describe what to do.</div>
          )}
          {sortedMessages.map((m) => {
            const segment = segments.get(m.id)
            const pending = m.id === pendingAsk?.id
            // A question's text is not in the transcript (only its collapsed tool call), so it is never a duplicate.
            const duplicate =
              m.role === "agent" && m.options === undefined && m.runId !== null && (itemCountByRun.get(m.runId) ?? 0) > 0
            const attachments = pending ? [] : (m.attachments ?? [])
            return (
              <Fragment key={m.id}>
                <ThreadItem message={m} hideText={duplicate || pending}>
                  {attachments.length > 0 ? (
                    <MessageAttachments
                      taskId={taskId}
                      attachments={attachments}
                      className={m.role === "user" ? "max-w-[85%] justify-end" : undefined}
                    />
                  ) : null}
                </ThreadItem>
                {segment !== undefined && (
                  <RunTranscript
                    taskId={taskId}
                    runId={segment.runId}
                    running={runs.some((run) => run.id === segment.runId && run.status === "running")}
                    from={segment.from}
                    to={segment.to}
                  />
                )}
              </Fragment>
            )
          })}
        </div>
      </div>
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
            taskId={taskId}
            draftKey={taskId}
            repos={checkoutRepos}
            activeRunId={activeRun?.id}
            activeRunProvider={activeRun?.provider}
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
