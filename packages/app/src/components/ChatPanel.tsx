import { Fragment, useEffect, useRef, type ReactNode } from "react"
import { Link } from "react-router-dom"
import { useMutation, useQueries, useQueryClient } from "@tanstack/react-query"
import type { ContextUsage, Message, Run, SendMessageBody, Task, TaskStatus } from "@cloudagents/protocol"
import { api } from "@/api/client"
import { keys, queries, upsert } from "@/api/queries"
import { cn } from "@/lib/utils"
import { threadPath } from "@/routes"
import { formatClock } from "@/util"
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

/** Under a thread block: a spinner while the turn runs, and the time. Finished turns get no icon. */
function TurnFooter({ status, time }: { status: Run["status"] | undefined; time?: string }) {
  const running = status === "running"
  if (!running && !time) return null
  return (
    <div className="mt-1.5 flex items-center gap-1.5 text-[11px] text-muted-foreground [&_svg]:size-3.5">
      {running && <StatusIcon status="running" />}
      {time && <span>{time}</span>}
      {running && !time && <span>Working…</span>}
    </div>
  )
}

/** `children`: what hangs off a message (attachments), shown under its text. */
function ThreadItem({
  message,
  turn,
  hideText = false,
  children,
}: {
  message: Message
  /** The run transcript already renders this text; only what hangs off the message stays. */
  hideText?: boolean
  turn: Run["status"] | undefined
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
              {message.text}
            </div>
          )}
          {children}
          {/* No agent reply yet: the turn's status sits under the prompt, on the agent's side. */}
          {turn && (
            <div className="self-start">
              <TurnFooter status={turn} />
            </div>
          )}
        </div>
      )
    case "agent": {
      // A duplicated message still holds attachments, and its footer is the running indicator; only the clock
      // goes, since the transcript's turn footer covers the finished turn.
      if (hideText && (children === undefined || children === null)) return <TurnFooter status={turn} />
      return (
        <div className={ENTER_CLASS}>
          {!hideText && <Markdown text={message.text} />}
          {children}
          <TurnFooter status={turn} time={hideText ? undefined : formatClock(message.createdAt)} />
        </div>
      )
    }
    case "system":
      return (
        <div className={cn("self-center text-xs text-muted-foreground italic", ENTER_CLASS)}>
          {message.text}
          {children}
          <TurnFooter status={turn} />
        </div>
      )
  }
}

export function ChatPanel({ taskId, taskStatus, messages, runs, archivedTask, elements, onElementsChange, context }: Props) {
  const queryClient = useQueryClient()
  const threadRef = useRef<HTMLDivElement>(null)

  const sortedMessages = [...messages].sort((a, b) => a.createdAt.localeCompare(b.createdAt))
  const sortedRuns = [...runs].sort((a, b) => a.startedAt.localeCompare(b.startedAt))
  const runById = new Map(sortedRuns.map((r) => [r.id, r]))
  // Items of every run in the thread: their count says whether an agent message duplicates its transcript,
  // and each arrival bumps `dataUpdatedAt`, which is what re-runs the scroll effect.
  const runItemQueries = useQueries({ queries: sortedRuns.map((run) => queries.runItems(run.id)) })
  const itemCountByRun = new Map(
    sortedRuns.map((run, index) => [run.id, runItemQueries[index]?.data?.length ?? 0]),
  )
  const itemsRevision = runItemQueries.map((query) => query.dataUpdatedAt).join(",")
  // The last message of each run carries that turn's status.
  const lastMessageOfRun = new Map<string, string>()
  for (const m of sortedMessages) if (m.runId) lastMessageOfRun.set(m.runId, m.id)
  // `task_ask` questions are the messages with `options` (possibly none). The latest one, while the agent is blocked
  // on it, moves into the composer: its screenshot, question and options sit above the box until it is answered.
  const lastAsk = [...sortedMessages].reverse().find((m) => m.options !== undefined)
  const pendingAsk = taskStatus === "needs_input" ? lastAsk : undefined

  useEffect(() => {
    const el = threadRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [sortedMessages.length, itemsRevision])

  const send = useMutation({
    mutationFn: ({ body, files = [] }: { body: SendMessageBody; files?: readonly File[] }) =>
      api.sendMessage(taskId, body, files),
    onSuccess: (res) => {
      queryClient.setQueryData(keys.messages(taskId), (list: Message[] | undefined) => upsert(list, res.message))
      queryClient.setQueryData(keys.runs(taskId), (list: Run[] | undefined) => upsert(list, res.run))
    },
  })
  const cancel = useMutation({
    mutationFn: (runId: string) => api.cancelRun(runId),
    onSuccess: (run) => queryClient.setQueryData(keys.runs(taskId), (list: Run[] | undefined) => upsert(list, run)),
  })
  const latestRun = sortedRuns.at(-1)
  const activeRun = latestRun?.status === "running" ? latestRun : undefined

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="min-h-0 flex-1 overflow-auto px-5 py-4" ref={threadRef}>
        <div className="mx-auto flex min-h-full w-full max-w-3xl flex-col gap-5">
          {sortedMessages.length === 0 && (
            <div className="m-auto text-muted-foreground">No messages yet. Describe what to do.</div>
          )}
          {sortedMessages.map((m) => {
            // A user message starts its run: that run's transcript follows the prompt.
            const startedRunId = m.role === "user" ? m.runId : null
            const pending = m.id === pendingAsk?.id
            // A question's text is not in the transcript (only its collapsed tool call), so it is never a duplicate.
            const duplicate =
              m.role === "agent" && m.options === undefined && m.runId !== null && (itemCountByRun.get(m.runId) ?? 0) > 0
            const attachments = pending ? [] : (m.attachments ?? [])
            const turn = m.runId && lastMessageOfRun.get(m.runId) === m.id ? runById.get(m.runId)?.status : undefined
            // While the prompt is the run's last message, its status goes under the transcript once one exists.
            const turnBelowTranscript = startedRunId !== null && (itemCountByRun.get(startedRunId) ?? 0) > 0
            return (
              <Fragment key={m.id}>
                <ThreadItem message={m} turn={turnBelowTranscript ? undefined : turn} hideText={duplicate || pending}>
                  {attachments.length > 0 ? (
                    <MessageAttachments
                      taskId={taskId}
                      attachments={attachments}
                      className={m.role === "user" ? "max-w-[85%] justify-end" : undefined}
                    />
                  ) : null}
                </ThreadItem>
                {startedRunId !== null && <RunTranscript runId={startedRunId} />}
                {turnBelowTranscript && <TurnFooter status={turn} />}
              </Fragment>
            )
          })}
        </div>
      </div>
      <div className="relative flex justify-center px-5 pt-2 pb-5">
        {/*
          A short fade up from the dock's edge, ending just past the context bar's labels (which sit above the
          composer, over the thread), so text scrolling under them softens instead of clashing.
        */}
        <div
          aria-hidden
          className="pointer-events-none absolute inset-x-0 bottom-full h-5 bg-linear-to-t from-card to-transparent"
        />
        {archivedTask ? (
          <ArchivedNotice task={archivedTask} />
        ) : (
          <Composer
            taskId={taskId}
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
