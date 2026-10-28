import { useEffect, useRef, useState, type FormEvent, type KeyboardEvent } from "react"
import { useMutation, useQueryClient } from "@tanstack/react-query"
import type { Message, Run, TaskStatus } from "@cloudagents/protocol"
import { api, taskAttachmentUrl } from "@/api/client"
import { keys, upsert } from "@/api/queries"
import { Alert } from "@/components/ui/alert"
import { Button } from "@/components/ui/button"
import { Textarea } from "@/components/ui/textarea"
import { cn } from "@/lib/utils"
import { errorText, formatTime } from "@/util"
import { RunPanel } from "./RunPanel"

interface Props {
  taskId: string
  taskStatus: TaskStatus | undefined
  messages: readonly Message[]
  runs: readonly Run[]
  output: Record<string, string[]>
}

const MESSAGE_CLASS_BY_ROLE: Record<string, string> = {
  user: "self-end border-primary/50 bg-primary/10",
  agent: "self-start bg-card",
  system: "self-center bg-transparent italic text-muted-foreground",
}

export function ChatPanel({ taskId, taskStatus, messages, runs, output }: Props) {
  const queryClient = useQueryClient()
  const [text, setText] = useState("")
  const threadRef = useRef<HTMLDivElement>(null)

  const sortedMessages = [...messages].sort((a, b) => a.createdAt.localeCompare(b.createdAt))
  const sortedRuns = [...runs].sort((a, b) => a.startedAt.localeCompare(b.startedAt))

  // The latest question with options gets answer buttons, but only while the agent is blocked waiting for one.
  const lastAsk = [...sortedMessages].reverse().find((m) => (m.options ?? []).length > 0)
  const pendingAsk = taskStatus === "needs_input" ? lastAsk : undefined

  useEffect(() => {
    const el = threadRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [sortedMessages.length])

  const send = useMutation({
    mutationFn: (body: string) => api.sendMessage(taskId, body),
    onSuccess: (res) => {
      queryClient.setQueryData(keys.messages(taskId), (list: Message[] | undefined) => upsert(list, res.message))
      queryClient.setQueryData(keys.runs(taskId), (list: Run[] | undefined) => upsert(list, res.run))
    },
  })

  function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault()
    const body = text.trim()
    if (body) send.mutate(body, { onSuccess: () => setText("") })
  }

  function onComposerKey(e: KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault()
      e.currentTarget.form?.requestSubmit()
    }
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex min-h-0 flex-1 flex-col gap-2.5 overflow-auto px-4 py-3" ref={threadRef}>
        {sortedMessages.length === 0 && (
          <div className="m-auto text-muted-foreground">No messages yet. Describe what to do.</div>
        )}
        {sortedMessages.map((m) => (
          <div key={m.id} className={cn("max-w-[92%] rounded-lg border px-3 py-2", MESSAGE_CLASS_BY_ROLE[m.role])}>
            <div className="mb-0.5 text-[11px] text-muted-foreground capitalize">
              {m.role} · {formatTime(m.createdAt)}
            </div>
            <div className="break-words whitespace-pre-wrap">{m.text}</div>
            {(m.attachments ?? []).map((a) => (
              <img key={a.id} src={taskAttachmentUrl(taskId, a.id)} alt="Attachment" className="mt-2 max-h-80 rounded border" />
            ))}
            {m.id === pendingAsk?.id && (
              <div className="mt-2 flex flex-wrap gap-2">
                {(m.options ?? []).map((option, i) => (
                  <Button key={i} variant="outline" size="sm" disabled={send.isPending} onClick={() => send.mutate(option)}>
                    {option}
                  </Button>
                ))}
              </div>
            )}
          </div>
        ))}
      </div>
      <RunPanel taskId={taskId} runs={sortedRuns} output={output} />
      {send.error && <Alert className="rounded-none border-x-0">{errorText(send.error)}</Alert>}
      <form className="flex items-end gap-2 border-t bg-card px-4 py-3" onSubmit={submit}>
        <Textarea
          className="flex-1 resize-y"
          value={text}
          placeholder="Message the agent (Enter to send, Shift+Enter for newline)"
          rows={3}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={onComposerKey}
        />
        <Button type="submit" disabled={send.isPending || text.trim() === ""}>
          {send.isPending ? "Sending…" : "Send"}
        </Button>
      </form>
    </div>
  )
}
