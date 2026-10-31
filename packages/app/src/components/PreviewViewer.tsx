import { useEffect, useRef, useState } from "react"
import { MousePointer2, RefreshCw } from "lucide-react"
import { Alert } from "@/components/ui/alert"
import { Button } from "@/components/ui/button"
import { api } from "@/api/client"

import type { ElementContext } from "@/components/Composer"

const MAX_SELECTION_TEXT = 500
const MAX_SELECTION_HTML = 2001

/** Sandboxed browser view for a dev server opened by the task's MCP preview tool. */
export function PreviewViewer({
  taskId,
  port,
  onSelect,
}: {
  taskId: string
  port: number | undefined
  /** Receives the picked element; the thread puts it in the composer as context. */
  onSelect: (element: ElementContext) => void
}) {
  const [frameSrc, setFrameSrc] = useState<string>()
  const [sessionError, setSessionError] = useState<string>()
  const frameRef = useRef<HTMLIFrameElement>(null)
  const [selecting, setSelecting] = useState(false)
  const onSelectRef = useRef(onSelect)
  onSelectRef.current = onSelect
  const [generation, setGeneration] = useState(0)

  useEffect(() => {
    setSelecting(false)
    setFrameSrc(undefined)
    setSessionError(undefined)
    if (port === undefined) return
    let active = true
    void api.previewFrame(taskId).then(
      (src) => {
        if (active) setFrameSrc(src)
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
      onSelectRef.current({
        label: data.label.slice(0, MAX_SELECTION_TEXT),
        selector: data.selector.slice(0, MAX_SELECTION_TEXT),
        html: typeof data.html === "string" ? data.html.slice(0, MAX_SELECTION_HTML) : "",
        page: typeof data.page === "string" ? data.page.slice(0, MAX_SELECTION_TEXT) : undefined,
      })
      setSelecting(false)
    }
    window.addEventListener("message", receive)
    return () => window.removeEventListener("message", receive)
  }, [])

  function toggleSelection() {
    const enabled = !selecting
    setSelecting(enabled)
    frameRef.current?.contentWindow?.postMessage({ type: "kestrel-preview-select-mode", enabled }, "*")
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
        <Button variant={selecting ? "soft" : "ghost"} size="sm" aria-pressed={selecting} disabled={!frameSrc} onClick={toggleSelection}>
          <MousePointer2 />
          {selecting ? "Click an element…" : "Select element"}
        </Button>
        <Button variant="ghost" size="sm" onClick={() => setGeneration((value) => value + 1)}>
          <RefreshCw />
          Reload
        </Button>
        <span className="ml-auto text-xs text-muted-foreground">Port {port}</span>
      </div>
      <iframe
        key={`${taskId}:${port}:${generation}`}
        ref={frameRef}
        title="Thread browser preview"
        src={frameSrc}
        sandbox="allow-scripts allow-forms"
        referrerPolicy="strict-origin-when-cross-origin"
        className="min-h-0 flex-1 rounded-lg border border-border bg-white"
      />
    </div>
  )
}
