import { useEffect, useState } from "react"
import { GitCompare, GitPullRequest, Monitor, PanelRightClose, PanelRightOpen, type LucideIcon } from "lucide-react"
import { ChatPanel } from "@/components/ChatPanel"
import { DesktopViewer } from "@/components/DesktopViewer"
import { DiffPanel } from "@/components/DiffPanel"
import { Alert } from "@/components/ui/alert"
import { Button } from "@/components/ui/button"
import { useTaskState } from "@/hooks/useTaskState"
import { cn } from "@/lib/utils"
import { repoShortName } from "@/util"

type TabId = "desktop" | "diff"

// Add a sidebar tab by adding an entry here and a case in SidebarBody.
const SIDEBAR_TABS: readonly { id: TabId; label: string; icon: LucideIcon }[] = [
  { id: "desktop", label: "Desktop", icon: Monitor },
  { id: "diff", label: "Diff", icon: GitCompare },
]

/** One thread (task): chat, plus a collapsible Desktop/Diff sidebar. Key it by taskId. */
export function ThreadView({ taskId }: { taskId: string }) {
  const state = useTaskState(taskId)
  // Sidebar starts collapsed: chat is full width, and tab content only mounts while expanded,
  // so the desktop stream does not connect until the user opens it.
  const [open, setOpen] = useState(false)
  const [tab, setTab] = useState<TabId>("desktop")
  // The agent opened the desktop: show it. Only a new count reopens, so a reconnect with a running desktop does not.
  useEffect(() => {
    if (state.desktopOpens === 0) return
    setTab("desktop")
    setOpen(true)
  }, [state.desktopOpens])

  function openTab(next: TabId) {
    setTab(next)
    setOpen(true)
  }

  // A checkout with a pull request gets its own link; with several repos checked out, the link names its repo.
  const checkouts = state.task?.checkouts ?? []
  const pullRequests = checkouts.flatMap((checkout) => {
    if (!checkout.pullRequest) return []
    const repo = checkouts.length > 1 ? `${repoShortName(checkout.repo)} ` : ""
    return [{ id: checkout.id, url: checkout.pullRequest.url, label: `${repo}PR #${checkout.pullRequest.number}` }]
  })
  // Archived threads keep their history; their desktop was torn down, so it does not start again.
  const archivedTask = state.task?.archivedAt ? state.task : undefined

  return (
    <div
      className={cn(
        "grid min-h-0 flex-1",
        open ? "grid-cols-[minmax(320px,1fr)_minmax(320px,1fr)]" : "grid-cols-[minmax(0,1fr)_3.25rem]",
      )}
    >
      <section className="flex min-h-0 min-w-0 flex-col">
        {state.error && <Alert className="mx-5 mt-3 w-auto">{state.error}</Alert>}
        <ChatPanel
          taskId={taskId}
          taskStatus={state.task?.status}
          messages={state.messages}
          runs={state.runs}
          output={state.output}
          archivedTask={archivedTask}
        />
      </section>
      {open ? (
        <aside className="m-2 ml-0 flex min-h-0 min-w-0 animate-in flex-col overflow-hidden rounded-xl bg-background/60 shadow-well duration-300 fade-in slide-in-from-right-4">
          <div className="flex items-center gap-1.5 p-2">
            {SIDEBAR_TABS.map((t) => (
              <Button
                key={t.id}
                variant={tab === t.id ? "soft" : "ghost"}
                size="sm"
                aria-pressed={tab === t.id}
                onClick={() => setTab(t.id)}
              >
                <t.icon />
                {t.label}
              </Button>
            ))}
            <div className="ml-auto flex min-w-0 items-center gap-1">
              {pullRequests.map((pr) => (
                <Button key={pr.id} asChild variant="ghost" size="sm">
                  <a href={pr.url} target="_blank" rel="noreferrer">
                    <GitPullRequest />
                    {pr.label}
                  </a>
                </Button>
              ))}
            </div>
            <Button
              variant="ghost"
              size="icon"
              aria-label="Collapse sidebar"
              onClick={() => setOpen(false)}
            >
              <PanelRightClose />
            </Button>
          </div>
          <SidebarBody
            tab={tab}
            taskId={taskId}
            archived={archivedTask !== undefined}
            running={state.task?.status === "running"}
          />
        </aside>
      ) : (
        <aside className="flex flex-col items-center gap-1 py-2">
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
          {pullRequests.map((pr) => (
            <Button key={pr.id} asChild variant="ghost" size="icon" title={pr.label}>
              <a href={pr.url} target="_blank" rel="noreferrer" aria-label={pr.label}>
                <GitPullRequest />
              </a>
            </Button>
          ))}
        </aside>
      )}
    </div>
  )
}

function SidebarBody({
  tab,
  taskId,
  archived,
  running,
}: {
  tab: TabId
  taskId: string
  archived: boolean
  running: boolean
}) {
  switch (tab) {
    case "desktop":
      if (archived) {
        return <p className="p-4 text-sm text-muted-foreground">The desktop is off while this thread is archived.</p>
      }
      return <DesktopViewer taskId={taskId} />
    case "diff":
      return <DiffPanel taskId={taskId} running={running} />
  }
}
