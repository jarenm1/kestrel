import { useEffect, useRef, useState, type FormEvent, type KeyboardEvent } from "react"
import { useMutation, useQueryClient } from "@tanstack/react-query"
import type { Message, Run } from "@cloudagents/protocol"
import { api } from "@/api/client"
import { keys, upsert } from "@/api/queries"
import { Alert } from "@/components/ui/alert"
import { Button } from "@/components/ui/button"
import { Textarea } from "@/components/ui/textarea"
import { cn } from "@/lib/utils"
import { errorText, formatTime } from "@/util"
import { RunPanel } from "./RunPanel"

interface Props {
  taskId: string
  messages: readonly Message[]
  runs: readonly Run[]
  output: Record<string, string[]>
}

const MESSAGE_CLASS_BY_ROLE: Record<string, string> = {
  user: "self-end bg-white/[0.08] shadow-soft",
  agent: "self-start bg-card shadow-soft",
  system: "self-center px-0 italic text-muted-foreground",
}

export function ChatPanel({ taskId, messages, runs, output }: Props) {
  const queryClient = useQueryClient()
  const [text, setText] = useState("")
  const threadRef = useRef<HTMLDivElement>(null)

  const sortedMessages = [...messages].sort((a, b) => a.createdAt.localeCompare(b.createdAt))
  const sortedRuns = [...runs].sort((a, b) => a.startedAt.localeCompare(b.startedAt))

  useEffect(() => {
    const el = threadRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [sortedMessages.length])

  const send = useMutation({
    mutationFn: (body: string) => api.sendMessage(taskId, body),
    onSuccess: (res) => {
      queryClient.setQueryData(keys.messages(taskId), (list: Message[] | undefined) => upsert(list, res.message))
      queryClient.setQueryData(keys.runs(taskId), (list: Run[] | undefined) => upsert(list, res.run))
      setText("")
    },
  })

  function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault()
    const body = text.trim()
    if (body) send.mutate(body)
  }

  function onComposerKey(e: KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault()
      e.currentTarget.form?.requestSubmit()
    }
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="min-h-0 flex-1 overflow-auto px-5 py-4" ref={threadRef}>
        <div className="mx-auto flex min-h-full w-full max-w-3xl flex-col gap-3">
          {sortedMessages.length === 0 && (
            <div className="m-auto text-muted-foreground">No messages yet. Describe what to do.</div>
          )}
          {sortedMessages.map((m) => (
            <div
              key={m.id}
              className={cn(
                "max-w-[85%] animate-in rounded-2xl px-4 py-2.5 duration-300 fade-in slide-in-from-bottom-1",
                MESSAGE_CLASS_BY_ROLE[m.role],
              )}
            >
              <div className="mb-0.5 text-[11px] text-muted-foreground capitalize">
                {m.role} · {formatTime(m.createdAt)}
              </div>
              <div className="break-words whitespace-pre-wrap">{m.text}</div>
            </div>
          ))}
        </div>
      </div>
      <RunPanel taskId={taskId} runs={sortedRuns} output={output} />
      <div className="px-5 pt-2 pb-5">
        {send.error && <Alert className="mx-auto mb-2 max-w-3xl">{errorText(send.error)}</Alert>}
        <form
          className="mx-auto flex max-w-3xl items-end gap-2 rounded-2xl bg-card p-2 shadow-soft transition-shadow duration-200 focus-within:shadow-glow"
          onSubmit={submit}
        >
          <Textarea
            className="min-h-12 flex-1 resize-none bg-transparent shadow-none focus-visible:bg-transparent focus-visible:shadow-none"
            value={text}
            placeholder="Message the agent (Enter to send, Shift+Enter for newline)"
            rows={2}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={onComposerKey}
          />
          <Button type="submit" disabled={send.isPending || text.trim() === ""}>
            {send.isPending ? "Sending…" : "Send"}
          </Button>
        </form>
      </div>
    </div>
  )
}
