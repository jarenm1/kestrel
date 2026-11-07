import { useEffect, useRef, useState, type KeyboardEvent, type PointerEvent } from "react"
import {
  AppWindow,
  FolderTree,
  GitCompare,
  GitPullRequest,
  Monitor,
  PanelRightClose,
  PanelRightOpen,
  type LucideIcon,
} from "lucide-react"
import { threadPullRequestsOf } from "@cloudagents/protocol"
import { ChatPanel } from "@/components/ChatPanel"
import { DesktopViewer } from "@/components/DesktopViewer"
import { PreviewViewer } from "@/components/PreviewViewer"
import type { ElementContext } from "@/components/Composer"
import { DiffPanel } from "@/components/DiffPanel"
import { FilesPanel } from "@/components/FilesPanel"
import { PullRequestsPanel } from "@/components/pullRequests/PullRequestPanel"
import { ThreadBoxIndicator } from "@/components/ThreadBoxIndicator"
import { ThreadRepoButton } from "@/components/ThreadRepoButton"
import { FloatingNotice, FloatingNotices } from "@/components/FloatingNotice"
import { Button } from "@cloudagents/ui/button"
import { useTaskState } from "@/hooks/useTaskState"
import { cn } from "@/lib/utils"

type TabId = "desktop" | "preview" | "diff" | "files" | "pull-requests"

// Add a sidebar tab by adding an entry here and a case in SidebarBody.
const SIDEBAR_TABS: readonly { id: TabId; label: string; icon: LucideIcon }[] = [
  { id: "desktop", label: "Desktop", icon: Monitor },
  { id: "preview", label: "Preview", icon: AppWindow },
  { id: "diff", label: "Diff", icon: GitCompare },
  { id: "files", label: "Files", icon: FolderTree },
]

/** The open sidebar's share of the thread's width, remembered across threads and reloads. */
const SIDEBAR_SHARE_KEY = "kestrel.sidebarShare"
const DEFAULT_SIDEBAR_SHARE = 0.5
const MIN_SIDEBAR_SHARE = 0.2
const MAX_SIDEBAR_SHARE = 0.8
/** Arrow keys on the resize handle move it by this share. */
const SIDEBAR_SHARE_STEP = 0.02

const clampShare = (share: number) => Math.min(MAX_SIDEBAR_SHARE, Math.max(MIN_SIDEBAR_SHARE, share))

function storedSidebarShare(): number {
  const stored = Number(localStorage.getItem(SIDEBAR_SHARE_KEY) ?? Number.NaN)
  return Number.isFinite(stored) ? clampShare(stored) : DEFAULT_SIDEBAR_SHARE
}

/** One thread (task): chat, plus a collapsible Desktop/Preview/Diff/Files sidebar. Key it by taskId. */
export function ThreadView({ taskId }: { taskId: string }) {
  const state = useTaskState(taskId)
  // Sidebar starts collapsed: chat is full width, and tab content only mounts while expanded,
  // so the desktop stream does not connect until the user opens it.
  const [open, setOpen] = useState(false)
  const [tab, setTab] = useState<TabId>("desktop")
  // Elements picked in the preview, waiting in the composer to go with the next message.
  const [elements, setElements] = useState<readonly ElementContext[]>([])
  const gridRef = useRef<HTMLDivElement>(null)
  const [sidebarShare, setSidebarShare] = useState(storedSidebarShare)
  const [resizing, setResizing] = useState(false)
  useEffect(() => {
    localStorage.setItem(SIDEBAR_SHARE_KEY, String(sidebarShare))
  }, [sidebarShare])
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

  /** Dragging the handle: the sidebar spans from the pointer to the thread's right edge. */
  function onResizeMove(e: PointerEvent<HTMLDivElement>) {
    const grid = gridRef.current
    if (!e.currentTarget.hasPointerCapture(e.pointerId) || grid === null) return
    const rect = grid.getBoundingClientRect()
    if (rect.width > 0) setSidebarShare(clampShare((rect.right - e.clientX) / rect.width))
  }

  function onResizeKey(e: KeyboardEvent<HTMLDivElement>) {
    const delta = e.key === "ArrowLeft" ? SIDEBAR_SHARE_STEP : e.key === "ArrowRight" ? -SIDEBAR_SHARE_STEP : 0
    if (delta === 0) return
    e.preventDefault()
    setSidebarShare((share) => clampShare(share + delta))
  }

  // Every pull request the thread owns or manages lives behind one button; the repo button stays checkout-based.
  const checkouts = state.task?.checkouts ?? []
  const pullRequests = state.task === null ? [] : threadPullRequestsOf(state.task)
  const [onlyPullRequest] = pullRequests
  const pullRequestLabel =
    pullRequests.length === 1 && onlyPullRequest !== undefined ? `PR #${onlyPullRequest.number}` : "Pull requests"
  // Archived threads keep their history; their desktop was torn down, so it does not start again.
  const archivedTask = state.task?.archivedAt ? state.task : undefined

  return (
    <div
      ref={gridRef}
      className={cn("grid min-h-0 flex-1", !open && "grid-cols-[minmax(0,1fr)_3.25rem]", resizing && "select-none")}
      // Both columns keep at least 320px; between those, the sidebar takes its share.
      style={
        open
          ? { gridTemplateColumns: `minmax(320px,1fr) clamp(320px, ${sidebarShare * 100}%, calc(100% - 320px))` }
          : undefined
      }
    >
      <section className="relative flex min-h-0 min-w-0 flex-col">
        <ThreadBoxIndicator taskId={taskId} />
        {state.error && (
          <FloatingNotices>
            <FloatingNotice>{state.error}</FloatingNotice>
          </FloatingNotices>
        )}
        <ChatPanel
          taskId={taskId}
          taskStatus={state.task?.status}
          messages={state.messages}
          runs={state.runs}
          loadError={state.loadError}
          archivedTask={archivedTask}
          elements={elements}
          onElementsChange={setElements}
          context={state.task?.context}
        />
      </section>
      {open ? (
        <div className="relative flex min-h-0 min-w-0">
          {/* Drag (or arrow keys) to resize; double-click resets. Pointer capture keeps the drag over the preview iframe. */}
          <div
            role="separator"
            aria-orientation="vertical"
            aria-label="Resize sidebar"
            aria-valuemin={MIN_SIDEBAR_SHARE * 100}
            aria-valuemax={MAX_SIDEBAR_SHARE * 100}
            aria-valuenow={Math.round(sidebarShare * 100)}
            tabIndex={0}
            className="group absolute inset-y-2 -left-1.5 z-10 flex w-3 cursor-col-resize touch-none justify-center outline-none"
            onPointerDown={(e) => {
              e.currentTarget.setPointerCapture(e.pointerId)
              setResizing(true)
            }}
            onPointerMove={onResizeMove}
            onPointerUp={() => setResizing(false)}
            onPointerCancel={() => setResizing(false)}
            onKeyDown={onResizeKey}
            onDoubleClick={() => setSidebarShare(DEFAULT_SIDEBAR_SHARE)}
          >
            <div
              className={cn(
                "h-full w-0.5 rounded-full transition-colors group-hover:bg-white/20 group-focus-visible:bg-ring",
                resizing && "bg-white/30",
              )}
            />
          </div>
          <aside className="m-2 ml-0 flex min-h-0 min-w-0 flex-1 animate-in flex-col overflow-hidden rounded-xl bg-background/60 shadow-well duration-300 fade-in slide-in-from-right-4">
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
                {pullRequests.length > 0 && (
                  <Button
                    variant={tab === "pull-requests" ? "soft" : "ghost"}
                    size="sm"
                    aria-pressed={tab === "pull-requests"}
                    title={pullRequestLabel}
                    onClick={() => setTab("pull-requests")}
                  >
                    <GitPullRequest />
                    {pullRequests.length === 1 ? pullRequestLabel : "Pull requests"}
                    {pullRequests.length > 1 && (
                      <span className="rounded-full bg-white/10 px-1.5 text-[10px] tabular-nums">
                        {pullRequests.length}
                      </span>
                    )}
                  </Button>
                )}
              </div>
              <ThreadRepoButton checkouts={checkouts} />
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
              previewPort={state.task?.previewPort}
              onSelectElement={(element) => setElements((current) => [...current, element])}
            />
          </aside>
        </div>
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
          {pullRequests.length > 0 && (
            <Button
              variant="ghost"
              size="icon"
              aria-label={pullRequestLabel}
              title={pullRequestLabel}
              onClick={() => openTab("pull-requests")}
            >
              <span className="relative inline-flex">
                <GitPullRequest />
                {pullRequests.length > 1 && (
                  <span className="absolute -top-1.5 -right-2 rounded-full bg-white/15 px-1 text-[9px] leading-4 tabular-nums">
                    {pullRequests.length}
                  </span>
                )}
              </span>
            </Button>
          )}
          {/* Bottom of the rail, under the tabs and pull requests. */}
          <div className="mt-auto">
            <ThreadRepoButton checkouts={checkouts} />
          </div>
        </aside>
      )}
    </div>
  )
}

function SidebarBody({
  tab,
  taskId,
  archived,
  previewPort,
  onSelectElement,
}: {
  tab: TabId
  taskId: string
  archived: boolean
  previewPort: number | undefined
  onSelectElement: (element: ElementContext) => void
}) {
  switch (tab) {
    case "desktop":
      if (archived) {
        return <p className="p-4 text-sm text-muted-foreground">The desktop is off while this thread is archived.</p>
      }
      return <DesktopViewer taskId={taskId} />
    case "preview":
      if (archived) {
        return <p className="p-4 text-sm text-muted-foreground">The preview is off while this thread is archived.</p>
      }
      return <PreviewViewer taskId={taskId} port={previewPort} onSelect={onSelectElement} />
    case "diff":
      return <DiffPanel taskId={taskId} />
    case "files":
      return <FilesPanel taskId={taskId} />
    case "pull-requests":
      return <PullRequestsPanel taskId={taskId} />
  }
}
