import { useState } from "react"
import { useParams } from "react-router-dom"
import { GitCompare, Monitor, PanelRightClose, PanelRightOpen, type LucideIcon } from "lucide-react"
import { BoxOfflineBanner } from "@/components/BoxStatus"
import { ChatPanel } from "@/components/ChatPanel"
import { DesktopViewer } from "@/components/DesktopViewer"
import { DiffPanel } from "@/components/DiffPanel"
import { StatusBadge } from "@/components/StatusBadge"
import { Alert } from "@/components/ui/alert"
import { Button } from "@/components/ui/button"
import { useTaskState } from "@/hooks/useTaskState"
import { cn } from "@/lib/utils"

type TabId = "desktop" | "diff"

// Add a sidebar tab by adding an entry here and a case in SidebarBody.
const SIDEBAR_TABS: readonly { id: TabId; label: string; icon: LucideIcon }[] = [
  { id: "desktop", label: "Desktop", icon: Monitor },
  { id: "diff", label: "Diff", icon: GitCompare },
]

export function TaskPage() {
  const { taskId = "" } = useParams()
  // Keyed so switching tasks discards all per-task state.
  return <TaskView key={taskId} taskId={taskId} />
}

function TaskView({ taskId }: { taskId: string }) {
  const state = useTaskState(taskId)
  const { task } = state
  // Sidebar starts collapsed: chat is full width, and tab content only mounts while expanded,
  // so the desktop stream does not connect until the user opens it.
  const [open, setOpen] = useState(false)
  const [tab, setTab] = useState<TabId>("desktop")

  function openTab(next: TabId) {
    setTab(next)
    setOpen(true)
  }

  return (
    <>
      <BoxOfflineBanner />
      <div
        className={cn(
          "grid min-h-0 flex-1",
          open ? "grid-cols-[minmax(320px,1fr)_minmax(320px,1fr)]" : "grid-cols-[minmax(0,1fr)_2.75rem]",
        )}
      >
        <section className="flex min-h-0 min-w-0 flex-col">
          <header className="flex min-w-0 items-center gap-2 border-b bg-card px-4 py-2.5">
            <strong className="truncate">{task?.title ?? "Loading…"}</strong>
            {task && <StatusBadge status={task.status} />}
            {task && <span className="truncate font-mono text-xs text-muted-foreground">{task.branch}</span>}
          </header>
          {state.error && <Alert className="rounded-none border-x-0 border-t-0">{state.error}</Alert>}
          <ChatPanel taskId={taskId} messages={state.messages} runs={state.runs} output={state.output} />
        </section>
        {open ? (
          <aside className="flex min-h-0 min-w-0 flex-col border-l">
            <div className="flex items-center gap-1.5 border-b bg-card px-2 py-1.5">
              {SIDEBAR_TABS.map((t) => (
                <Button
                  key={t.id}
                  variant={tab === t.id ? "secondary" : "ghost"}
                  size="sm"
                  aria-pressed={tab === t.id}
                  onClick={() => setTab(t.id)}
                >
                  <t.icon />
                  {t.label}
                </Button>
              ))}
              <Button
                variant="ghost"
                size="icon"
                className="ml-auto"
                aria-label="Collapse sidebar"
                onClick={() => setOpen(false)}
              >
                <PanelRightClose />
              </Button>
            </div>
            <SidebarBody tab={tab} taskId={taskId} />
          </aside>
        ) : (
          <aside className="flex flex-col items-center gap-1 border-l bg-card py-2">
            <Button variant="ghost" size="icon" aria-label="Expand sidebar" onClick={() => setOpen(true)}>
              <PanelRightOpen />
            </Button>
            {SIDEBAR_TABS.map((t) => (
              <Button
                key={t.id}
                variant="ghost"
                size="icon"
                aria-label={t.label}
                title={t.label}
                onClick={() => openTab(t.id)}
              >
                <t.icon />
              </Button>
            ))}
          </aside>
        )}
      </div>
    </>
  )
}

function SidebarBody({ tab, taskId }: { tab: TabId; taskId: string }) {
  switch (tab) {
    case "desktop":
      return <DesktopViewer taskId={taskId} />
    case "diff":
      return <DiffPanel taskId={taskId} />
  }
}
