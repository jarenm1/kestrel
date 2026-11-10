import { useEffect, useRef, useState } from "react"
import type { Message } from "@cloudagents/protocol"
import Check from "lucide-react/icons/check"
import Copy from "lucide-react/icons/copy"
import GitFork from "lucide-react/icons/git-fork"
import { Button } from "../button"
import { cn } from "../cn"
import { useTranscriptHost } from "./host"

/** How long a button shows the outcome of its click. */
const FEEDBACK_MS = 1500

/**
 * Hidden until the pointer is over the response (`group/response`) or a button has focus; always shown where nothing
 * hovers (touch screens).
 */
const REVEAL =
  "opacity-0 transition-opacity duration-200 focus-within:opacity-100 group-hover/response:opacity-100 pointer-coarse:opacity-100"

const ICON_BUTTON = "size-6 rounded-md [&_svg]:size-3.5"

/** The Clipboard API, or a selection copy where it is missing or refused (an insecure origin, a WebView). */
async function writeClipboard(text: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text)
    return
  } catch {
    // Fall through to the selection copy.
  }
  const area = document.createElement("textarea")
  area.value = text
  area.setAttribute("readonly", "")
  area.style.position = "fixed"
  area.style.opacity = "0"
  document.body.append(area)
  area.select()
  const copied = document.execCommand("copy")
  area.remove()
  if (!copied) throw new Error("the browser refused to copy")
}

/** A click's outcome, shown for `FEEDBACK_MS`; a newer outcome replaces it. */
function useFeedback<T>() {
  const [shown, setShown] = useState<T | null>(null)
  const timer = useRef<number>(undefined)
  useEffect(() => () => window.clearTimeout(timer.current), [])
  const show = (value: T) => {
    window.clearTimeout(timer.current)
    setShown(value)
    timer.current = window.setTimeout(() => setShown(null), FEEDBACK_MS)
  }
  return [shown, show] as const
}

/** Copy and fork buttons under an agent reply: the reply's Markdown source, and a new thread forked at it. */
export function ResponseActions({ message, className }: { message: Message; className?: string }) {
  const host = useTranscriptHost()
  const [copied, showCopied] = useFeedback<"copied" | "failed">()
  const [forkError, showForkError] = useFeedback<string>()
  const [forking, setForking] = useState(false)
  const { forkThread } = host

  const copyLabel = copied === "copied" ? "Copied" : copied === "failed" ? "Could not copy" : "Copy message"
  const forkLabel = forkError === null ? "Fork from this response" : `Fork failed: ${forkError}`

  return (
    <div className={cn("flex items-center gap-0.5", REVEAL, className)}>
      {message.text.trim() !== "" && (
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className={ICON_BUTTON}
          aria-label={copyLabel}
          title={copyLabel}
          onClick={() => {
            writeClipboard(message.text).then(
              () => showCopied("copied"),
              () => showCopied("failed"),
            )
          }}
        >
          {copied === "copied" ? <Check className="text-primary" /> : <Copy className={cn(copied === "failed" && "text-destructive")} />}
        </Button>
      )}
      {forkThread !== undefined && (
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className={ICON_BUTTON}
          aria-label={forkLabel}
          title={forkLabel}
          disabled={forking}
          onClick={() => {
            setForking(true)
            forkThread(message.taskId, message.id)
              .catch((error: unknown) => showForkError(error instanceof Error ? error.message : String(error)))
              .finally(() => setForking(false))
          }}
        >
          <GitFork className={cn(forking && "animate-pulse", forkError !== null && "text-destructive")} />
        </Button>
      )}
    </div>
  )
}
