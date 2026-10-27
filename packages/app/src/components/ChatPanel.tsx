import { useEffect, useRef, useState, type FormEvent, type KeyboardEvent } from "react"
import type { Message, Run } from "@cloudagents/protocol"
import { api } from "../api/client"
import { errorText, formatTime } from "../util"
import { RunPanel } from "./RunPanel"

interface Props {
  taskId: string
  messages: readonly Message[]
  runs: readonly Run[]
  output: Record<string, string[]>
  onMessage: (message: Message) => void
  onRun: (run: Run) => void
}

export function ChatPanel({ taskId, messages, runs, output, onMessage, onRun }: Props) {
  const [text, setText] = useState("")
  const [sending, setSending] = useState(false)
  const [sendError, setSendError] = useState<string | null>(null)
  const threadRef = useRef<HTMLDivElement>(null)

  const sortedMessages = [...messages].sort((a, b) => a.createdAt.localeCompare(b.createdAt))
  const sortedRuns = [...runs].sort((a, b) => a.startedAt.localeCompare(b.startedAt))

  useEffect(() => {
    const el = threadRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [sortedMessages.length])

  async function send(e: FormEvent<HTMLFormElement>) {
    e.preventDefault()
    const body = text.trim()
    if (!body) return
    setSending(true)
    setSendError(null)
    try {
      const res = await api.sendMessage(taskId, body)
      onMessage(res.message)
      onRun(res.run)
      setText("")
    } catch (err) {
      setSendError(errorText(err))
    } finally {
      setSending(false)
    }
  }

  function onComposerKey(e: KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault()
      e.currentTarget.form?.requestSubmit()
    }
  }

  return (
    <div className="chat">
      <div className="thread" ref={threadRef}>
        {sortedMessages.length === 0 && <div className="muted empty">No messages yet. Describe what to do.</div>}
        {sortedMessages.map((m) => (
          <div key={m.id} className={`msg msg-${m.role}`}>
            <div className="msg-meta">
              {m.role} · {formatTime(m.createdAt)}
            </div>
            <div className="msg-text">{m.text}</div>
          </div>
        ))}
      </div>
      <RunPanel runs={sortedRuns} output={output} onRun={onRun} />
      {sendError && <div className="error">{sendError}</div>}
      <form className="composer" onSubmit={(e) => void send(e)}>
        <textarea
          value={text}
          placeholder="Message the agent (Enter to send, Shift+Enter for newline)"
          rows={3}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={onComposerKey}
        />
        <button type="submit" disabled={sending || text.trim() === ""}>
          {sending ? "Sending…" : "Send"}
        </button>
      </form>
    </div>
  )
}
