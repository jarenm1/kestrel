import { useState } from "react"
import { useParams } from "react-router-dom"
import { PanelRightClose } from "lucide-react"
import { BoxOfflineBanner } from "@/components/BoxStatus"
import { ChatPanel } from "@/components/ChatPanel"
import { DesktopViewer } from "@/components/DesktopViewer"
import { DiffPanel } from "@/components/DiffPanel"
import { StatusBadge } from "@/components/StatusBadge"
import { Alert } from "@/components/ui/alert"
import { Button } from "@/components/ui/button"
import { useTaskState } from "@/hooks/useTaskState"
import { cn } from "@/lib/utils"

type Panel = "desktop" | "diff"

const PANELS: readonly Panel[] = ["desktop", "diff"]
const PANEL_LABEL: Record<Panel, string> = { desktop: "Desktop", diff: "Diff" }

export function TaskPage() {
  const { taskId = "" } = useParams()
  // Keyed so switching tasks discards all per-task state.
  return <TaskView key={taskId} taskId={taskId} />
}

function TaskView({ taskId }: { taskId: string }) {
  const state = useTaskState(taskId)
  const { task } = state
  // Collapsed by default: chat gets the full width. The panel's contents only mount while open,
  // so the desktop stream does not connect until the user opens it.
  const [panel, setPanel] = useState<Panel | null>(null)

  function togglePanel(next: Panel) {
    setPanel((current) => (current === next ? null : next))
  }

  return (
    <>
      <BoxOfflineBanner />
      <div
        className={cn(
          "grid min-h-0 flex-1",
          panel ? "grid-cols-[minmax(320px,1fr)_minmax(320px,1fr)]" : "grid-cols-1",
        )}
      >
        <section className="flex min-h-0 min-w-0 flex-col">
          <header className="flex min-w-0 items-center gap-2 border-b bg-card px-4 py-2.5">
            <strong className="truncate">{task?.title ?? "Loading…"}</strong>
            {task && <StatusBadge status={task.status} />}
            {task && <span className="truncate font-mono text-xs text-muted-foreground">{task.branch}</span>}
            <div className="ml-auto flex shrink-0 items-center gap-1.5">
              {PANELS.map((p) => (
                <Button
                  key={p}
                  variant={panel === p ? "secondary" : "outline"}
                  size="sm"
                  aria-pressed={panel === p}
                  onClick={() => togglePanel(p)}
                >
                  {PANEL_LABEL[p]}
                </Button>
              ))}
            </div>
          </header>
          {state.error && <Alert className="rounded-none border-x-0 border-t-0">{state.error}</Alert>}
          <ChatPanel taskId={taskId} messages={state.messages} runs={state.runs} output={state.output} />
        </section>
        {panel && (
          <aside className="flex min-h-0 min-w-0 flex-col border-l">
            <div className="flex items-center gap-2 border-b bg-card px-3 py-1.5">
              <strong className="text-sm font-medium">{PANEL_LABEL[panel]}</strong>
              <Button
                variant="ghost"
                size="icon"
                className="ml-auto"
                aria-label="Collapse panel"
                onClick={() => setPanel(null)}
              >
                <PanelRightClose />
              </Button>
            </div>
            {panel === "desktop" ? <DesktopViewer taskId={taskId} /> : <DiffPanel taskId={taskId} />}
          </aside>
        )}
      </div>
    </>
  )
}
