import { useEffect, useRef } from "react"
import { useMutation, useQueryClient } from "@tanstack/react-query"
import type { Message, Run, SendMessageBody } from "@cloudagents/protocol"
import { api } from "@/api/client"
import { keys, upsert } from "@/api/queries"
import { cn } from "@/lib/utils"
import { formatClock } from "@/util"
import { Composer } from "./Composer"
import { Markdown } from "./Markdown"
import { RunPanel } from "./RunPanel"
import { StatusIcon } from "./StatusIcon"

interface Props {
  taskId: string
  messages: readonly Message[]
  runs: readonly Run[]
  output: Record<string, string[]>
}

const ENTER_CLASS = "animate-in duration-300 fade-in slide-in-from-bottom-1"

/** A turn's status icon (spinner while running, check when done) plus an optional time, under a thread block. */
function TurnFooter({ status, time }: { status: Run["status"] | undefined; time?: string }) {
  if (!status && !time) return null
  return (
    <div className="mt-1.5 flex items-center gap-1.5 text-[11px] text-muted-foreground [&_svg]:size-3.5">
      {status && <StatusIcon status={status} />}
      {time && <span>{time}</span>}
      {status === "running" && !time && <span>Working…</span>}
    </div>
  )
}

function ThreadItem({ message, turn }: { message: Message; turn: Run["status"] | undefined }) {
  switch (message.role) {
    case "user":
      return (
        <div className={cn("flex flex-col items-end", ENTER_CLASS)}>
          <div className="max-w-[85%] rounded-2xl bg-white/[0.08] px-4 py-2.5 break-words whitespace-pre-wrap shadow-soft">
            {message.text}
          </div>
          {/* No agent reply yet: the turn's status sits under the prompt, on the agent's side. */}
          {turn && (
            <div className="self-start">
              <TurnFooter status={turn} />
            </div>
          )}
        </div>
      )
    case "agent":
      return (
        <div className={ENTER_CLASS}>
          <Markdown text={message.text} />
          <TurnFooter status={turn} time={formatClock(message.createdAt)} />
        </div>
      )
    case "system":
      return (
        <div className={cn("self-center text-xs text-muted-foreground italic", ENTER_CLASS)}>
          {message.text}
          <TurnFooter status={turn} />
        </div>
      )
  }
}

export function ChatPanel({ taskId, messages, runs, output }: Props) {
  const queryClient = useQueryClient()
  const threadRef = useRef<HTMLDivElement>(null)

  const sortedMessages = [...messages].sort((a, b) => a.createdAt.localeCompare(b.createdAt))
  const sortedRuns = [...runs].sort((a, b) => a.startedAt.localeCompare(b.startedAt))
  const runById = new Map(sortedRuns.map((r) => [r.id, r]))
  // The last message of each run carries that turn's status.
  const lastMessageOfRun = new Map<string, string>()
  for (const m of sortedMessages) if (m.runId) lastMessageOfRun.set(m.runId, m.id)

  useEffect(() => {
    const el = threadRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [sortedMessages.length])

  const send = useMutation({
    mutationFn: (body: SendMessageBody) => api.sendMessage(taskId, body),
    onSuccess: (res) => {
      queryClient.setQueryData(keys.messages(taskId), (list: Message[] | undefined) => upsert(list, res.message))
      queryClient.setQueryData(keys.runs(taskId), (list: Run[] | undefined) => upsert(list, res.run))
    },
  })

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="min-h-0 flex-1 overflow-auto px-5 py-4" ref={threadRef}>
        <div className="mx-auto flex min-h-full w-full max-w-3xl flex-col gap-5">
          {sortedMessages.length === 0 && (
            <div className="m-auto text-muted-foreground">No messages yet. Describe what to do.</div>
          )}
          {sortedMessages.map((m) => (
            <ThreadItem
              key={m.id}
              message={m}
              turn={m.runId && lastMessageOfRun.get(m.runId) === m.id ? runById.get(m.runId)?.status : undefined}
            />
          ))}
        </div>
      </div>
      <RunPanel taskId={taskId} runs={sortedRuns} output={output} />
      <div className="flex justify-center px-5 pt-2 pb-5">
        <Composer onSend={send.mutateAsync} pending={send.isPending} error={send.error} />
      </div>
    </div>
  )
}
