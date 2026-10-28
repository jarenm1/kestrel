import { useEffect, useRef, useState, type FormEvent, type KeyboardEvent } from "react"
import { useMutation, useQueryClient } from "@tanstack/react-query"
import { ChevronDown } from "lucide-react"
import type { AgentEffort, AgentModel, Message, Run } from "@cloudagents/protocol"
import { api } from "@/api/client"
import { keys, upsert } from "@/api/queries"
import { Alert } from "@/components/ui/alert"
import { Button } from "@/components/ui/button"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { Textarea } from "@/components/ui/textarea"
import { cn } from "@/lib/utils"
import { errorText, formatClock } from "@/util"
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

// `undefined` leaves the choice to the harness (the CLI's own default).
const MODEL_OPTIONS: readonly { value: AgentModel | undefined; label: string }[] = [
  { value: undefined, label: "Default" },
  { value: "opus", label: "Opus" },
  { value: "sonnet", label: "Sonnet" },
  { value: "haiku", label: "Haiku" },
]
const EFFORT_OPTIONS: readonly { value: AgentEffort | undefined; label: string }[] = [
  { value: undefined, label: "Default" },
  { value: "low", label: "Low" },
  { value: "medium", label: "Medium" },
  { value: "high", label: "High" },
  { value: "xhigh", label: "Extra high" },
  { value: "max", label: "Max" },
]

/** A pill that opens a single-choice menu; shows its label until something other than Default is picked. */
function PillPicker<T extends string>({
  label,
  value,
  options,
  onChange,
}: {
  label: string
  value: T | undefined
  options: readonly { value: T | undefined; label: string }[]
  onChange: (value: T | undefined) => void
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button type="button" variant="ghost" size="sm" className="data-[state=open]:bg-white/[0.06]">
          {value === undefined ? label : options.find((o) => o.value === value)?.label}
          <ChevronDown className="opacity-60" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" side="top">
        <DropdownMenuLabel>{label}</DropdownMenuLabel>
        <DropdownMenuRadioGroup
          value={value ?? ""}
          onValueChange={(v) => onChange(options.find((o) => (o.value ?? "") === v)?.value)}
        >
          {options.map((o) => (
            <DropdownMenuRadioItem key={o.label} value={o.value ?? ""}>
              {o.label}
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

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
  const [text, setText] = useState("")
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

  const [model, setModel] = useState<AgentModel | undefined>(undefined)
  const [effort, setEffort] = useState<AgentEffort | undefined>(undefined)

  const send = useMutation({
    mutationFn: (body: string) => api.sendMessage(taskId, { text: body, model, effort }),
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
      <div className="px-5 pt-2 pb-5">
        {send.error && <Alert className="mx-auto mb-2 max-w-3xl">{errorText(send.error)}</Alert>}
        <form
          className="mx-auto flex max-w-3xl flex-col gap-1 rounded-2xl bg-card p-2 shadow-soft transition-shadow duration-200 focus-within:shadow-glow"
          onSubmit={submit}
        >
          <Textarea
            className="min-h-12 resize-none bg-transparent shadow-none focus-visible:bg-transparent focus-visible:shadow-none"
            value={text}
            placeholder="Message the agent (Enter to send, Shift+Enter for newline)"
            rows={2}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={onComposerKey}
          />
          <div className="flex items-center gap-1">
            <PillPicker label="Model" value={model} options={MODEL_OPTIONS} onChange={setModel} />
            <PillPicker label="Thinking" value={effort} options={EFFORT_OPTIONS} onChange={setEffort} />
            <Button type="submit" className="ml-auto" disabled={send.isPending || text.trim() === ""}>
              {send.isPending ? "Sending…" : "Send"}
            </Button>
          </div>
        </form>
      </div>
    </div>
  )
}
