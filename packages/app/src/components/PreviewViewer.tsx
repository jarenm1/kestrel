import { useEffect, useRef, useState } from "react"
import { Check, Copy, MousePointer2, RefreshCw } from "lucide-react"
import { Paths } from "@cloudagents/protocol"
import { Alert } from "@/components/ui/alert"
import { Button } from "@/components/ui/button"
import { api } from "@/api/client"

interface PreviewSelection {
  readonly label: string
  readonly selector: string
}

const MAX_SELECTION_TEXT = 500

/** Sandboxed browser view for a dev server opened by the task's MCP preview tool. */
export function PreviewViewer({ taskId, port }: { taskId: string; port: number | undefined }) {
  const [previewToken, setPreviewToken] = useState<string>()
  const [sessionError, setSessionError] = useState<string>()
  const frameRef = useRef<HTMLIFrameElement>(null)
  const [selecting, setSelecting] = useState(false)
  const [selection, setSelection] = useState<PreviewSelection | null>(null)
  const [copied, setCopied] = useState(false)
  const [generation, setGeneration] = useState(0)

  useEffect(() => {
    setSelecting(false)
    setSelection(null)
    setPreviewToken(undefined)
    setSessionError(undefined)
    if (port === undefined) return
    let active = true
    void api.previewSession(taskId).then(
      ({ token }) => {
        if (active) setPreviewToken(token)
      },
      (error: unknown) => {
        if (active) setSessionError(error instanceof Error ? error.message : String(error))
      },
    )
    return () => {
      active = false
    }
  }, [taskId, port, generation])

  useEffect(() => {
    const receive = (event: MessageEvent<unknown>) => {
      if (event.source !== frameRef.current?.contentWindow) return
      if (typeof event.data !== "object" || event.data === null) return
      const data = event.data as Record<string, unknown>
      if (
        data.type !== "kestrel-preview-selection" ||
        typeof data.label !== "string" ||
        typeof data.selector !== "string"
      ) return
      setSelection({
        label: data.label.slice(0, MAX_SELECTION_TEXT),
        selector: data.selector.slice(0, MAX_SELECTION_TEXT),
      })
      setSelecting(false)
      setCopied(false)
    }
    window.addEventListener("message", receive)
    return () => window.removeEventListener("message", receive)
  }, [])

  function toggleSelection() {
    const enabled = !selecting
    setSelecting(enabled)
    frameRef.current?.contentWindow?.postMessage({ type: "kestrel-preview-select-mode", enabled }, "*")
  }

  async function copySelection() {
    if (!selection) return
    await navigator.clipboard.writeText(`Selected UI element: ${selection.label}\nSelector: ${selection.selector}`)
    setCopied(true)
  }

  if (port === undefined) {
    return (
      <div className="flex min-h-0 flex-1 items-center justify-center p-6 text-center text-sm text-muted-foreground">
        Start the app in this thread and have the agent open its preview to see it here.
      </div>
    )
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-2 p-2">
      {sessionError && <Alert className="mx-1">{sessionError}</Alert>}
      <div className="flex flex-wrap items-center gap-2">
        <Button variant={selecting ? "soft" : "ghost"} size="sm" aria-pressed={selecting} disabled={!previewToken} onClick={toggleSelection}>
          <MousePointer2 />
          {selecting ? "Click an element…" : "Select element"}
        </Button>
        <Button variant="ghost" size="sm" onClick={() => setGeneration((value) => value + 1)}>
          <RefreshCw />
          Reload
        </Button>
        <span className="ml-auto text-xs text-muted-foreground">Port {port}</span>
      </div>
      {selection && (
        <div className="flex min-w-0 items-center gap-2 rounded-lg border border-border bg-background/80 p-2 text-xs">
          <div className="min-w-0 flex-1">
            <div className="truncate font-medium">{selection.label}</div>
            <code className="block truncate text-muted-foreground">{selection.selector}</code>
          </div>
          <Button variant="ghost" size="sm" onClick={() => void copySelection()}>
            {copied ? <Check /> : <Copy />}
            {copied ? "Copied" : "Copy"}
          </Button>
        </div>
      )}
      <iframe
        key={`${taskId}:${port}:${generation}`}
        ref={frameRef}
        title="Thread browser preview"
        src={previewToken ? Paths.taskPreviewFrame(previewToken, taskId) : undefined}
        sandbox="allow-scripts allow-forms"
        referrerPolicy="strict-origin-when-cross-origin"
        className="min-h-0 flex-1 rounded-lg border border-border bg-white"
      />
    </div>
  )
}
