import { useState } from "react"
import { Paths, type Attachment, type Message } from "@cloudagents/protocol"
import ArrowUp from "lucide-react/icons/arrow-up"
import ChevronDown from "lucide-react/icons/chevron-down"
import CircleAlert from "lucide-react/icons/circle-alert"
import Clock from "lucide-react/icons/clock"
import FileText from "lucide-react/icons/file-text"
import X from "lucide-react/icons/x"
import { Button } from "../button"
import { cn } from "../cn"
import { useTranscriptHost } from "./host"

/** Rows after which the strip folds; a longer one shows its first messages and a button for the rest. */
const VISIBLE_ROWS = 3

/**
 * Plain data and callbacks only, so the phone app can send it across Expo's DOM bridge; attachment URLs come from the
 * transcript host, as they do for the transcript itself.
 */
export interface PendingMessagesProps {
  readonly taskId: string
  /** The thread's messages whose `pending` is set, in any order. */
  readonly messages: readonly Message[]
  /** Removes one `inbox` or `held` message before the agent takes it; rejects when the box refused. */
  readonly onRemove: (messageId: string) => Promise<unknown>
  /** Sends every `held` message as one new message; rejects when the send failed. */
  readonly onSendHeld: () => Promise<unknown>
  /** Classes for the section, e.g. its width and spacing. */
  readonly className?: string
}

/**
 * The messages a running turn has not taken yet, above the composer: `inbox` and `agent` messages wait for the agent,
 * and `held` ones are sent or removed by the user once their run ended without taking them. Dashed and unfilled, since
 * none of them is in the transcript yet.
 */
export function PendingMessages({ taskId, messages, onRemove, onSendHeld, className }: PendingMessagesProps) {
  const [showAll, setShowAll] = useState(false)
  const [busy, setBusy] = useState(false)
  const [failure, setFailure] = useState<string | null>(null)

  // Oldest first: held messages are sent as one message in the order they were typed.
  const sorted = [...messages].filter((m) => m.pending !== undefined).sort((a, b) => a.createdAt.localeCompare(b.createdAt))
  if (sorted.length === 0) return null
  const held = sorted.filter((m) => m.pending === "held")
  const collapsible = sorted.length > VISIBLE_ROWS
  const visible = collapsible && !showAll ? sorted.slice(0, VISIBLE_ROWS - 1) : sorted

  const act = async (request: () => Promise<unknown>) => {
    setBusy(true)
    setFailure(null)
    try {
      await request()
    } catch (error) {
      setFailure(error instanceof Error ? error.message : String(error))
    } finally {
      setBusy(false)
    }
  }

  return (
    <section
      aria-label={`${sorted.length} pending message${sorted.length === 1 ? "" : "s"}`}
      className={cn("flex w-full flex-col gap-2", className)}
    >
      <span className="sr-only" aria-live="polite">
        {sorted.length} pending
      </span>
      {held.length > 0 && (
        <div className="flex items-center justify-end gap-2 text-xs text-muted-foreground">
          <span>{held.length === 1 ? "1 message was not sent" : `${held.length} messages were not sent`}</span>
          <Button
            size="sm"
            variant="soft"
            aria-label="Send held messages"
            disabled={busy}
            onClick={() => void act(onSendHeld)}
          >
            <ArrowUp aria-hidden />
            Send
          </Button>
        </div>
      )}
      {/* Bounded and scrolled here, so a long line never pushes the composer off-screen; the header and the toggle stay put. */}
      <ol className="flex max-h-56 flex-col items-end gap-3 overflow-y-auto overscroll-contain">
        {visible.map((message, position) => {
          // The agent's next step takes an `agent` message, so only what Kestrel still holds can be removed.
          const removable = message.pending === "inbox" || message.pending === "held"
          const attachments = message.attachments ?? []
          return (
            <li
              key={message.id}
              aria-label={`Pending message ${position + 1} of ${sorted.length}, not sent`}
              aria-posinset={position + 1}
              aria-setsize={sorted.length}
              className="flex w-full flex-col items-end gap-1"
            >
              <div className="flex min-w-0 max-w-[80%] flex-col gap-2 rounded-2xl border border-dashed border-muted-foreground/40 px-3 py-2 text-sm text-muted-foreground">
                {attachments.length > 0 && <PendingFiles taskId={taskId} attachments={attachments} />}
                {message.text !== "" && <p className="whitespace-pre-wrap wrap-anywhere">{message.text}</p>}
              </div>
              <div className="flex items-center gap-1 pe-1 text-xs text-muted-foreground">
                <span className="flex items-center gap-1 px-1">
                  {message.pending === "held" ? (
                    <>
                      <CircleAlert aria-hidden className="size-3" />
                      Not sent: the run ended first
                    </>
                  ) : (
                    <>
                      <Clock aria-hidden className="size-3" />
                      Waiting for the agent
                    </>
                  )}
                </span>
                {removable && (
                  <Button
                    size="icon"
                    variant="ghost"
                    aria-label="Remove pending message"
                    title="Remove pending message"
                    disabled={busy}
                    onClick={() => void act(() => onRemove(message.id))}
                    className="size-6 [&_svg]:size-3.5"
                  >
                    <X aria-hidden />
                  </Button>
                )}
              </div>
            </li>
          )
        })}
      </ol>
      {collapsible && (
        <div className="self-end">
          <Button
            size="sm"
            variant="ghost"
            aria-expanded={showAll}
            // Keep the composer focused; keyboard activation still works.
            onPointerDown={(event) => event.preventDefault()}
            onClick={() => setShowAll((value) => !value)}
            className="h-6 gap-1 px-2 text-xs"
          >
            {showAll ? "Show fewer" : `Show all ${sorted.length} pending`}
            <ChevronDown aria-hidden className={cn("transition-transform duration-150 motion-reduce:transition-none", showAll && "rotate-180")} />
          </Button>
        </div>
      )}
      {failure !== null && (
        <p role="alert" className="pe-1 text-right text-xs text-destructive">
          {failure}
        </p>
      )}
    </section>
  )
}

/** A pending message's files: images as thumbnails, other files as a named chip. */
function PendingFiles({ taskId, attachments }: { taskId: string; attachments: readonly Attachment[] }) {
  return (
    <span className="flex flex-wrap items-center gap-1">
      {attachments.map((attachment) => (
        <PendingFile key={attachment.id} taskId={taskId} attachment={attachment} />
      ))}
    </span>
  )
}

function PendingFile({ taskId, attachment }: { taskId: string; attachment: Attachment }) {
  const file = useTranscriptHost().useFileLink(taskId, Paths.taskAttachment(taskId, attachment.id))
  const label = attachment.name ?? (attachment.mimeType.startsWith("image/") ? "Image" : "File")
  if (attachment.mimeType.startsWith("image/")) {
    return (
      <span className="size-8 overflow-hidden rounded-md border border-border/70 bg-background">
        {file.url === undefined ? (
          <span aria-label={label} className="block size-full bg-muted/60" />
        ) : (
          <img src={file.url} alt={label} onError={file.onError} className="size-full object-cover" />
        )}
      </span>
    )
  }
  return (
    <span title={label} className="flex h-6 max-w-48 items-center gap-1 rounded-md bg-white/[0.06] px-1.5 text-xs">
      <FileText aria-hidden className="size-3 shrink-0" />
      <span className="truncate">{label}</span>
    </span>
  )
}
