import { useRef, useState, type KeyboardEvent, type PointerEvent } from "react"
import { AppWindow, FolderTree, GitCompare, GitPullRequest, Monitor, Plus, X, type LucideIcon } from "lucide-react"
import { Button } from "@cloudagents/ui/button"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { cn } from "@/lib/utils"

export type SidebarTabId = "desktop" | "preview" | "diff" | "files" | "pull-requests"

// Add a sidebar tab by adding an entry here and a case in ThreadView's SidebarBody.
export const SIDEBAR_TABS: readonly { id: SidebarTabId; label: string; icon: LucideIcon; shortcut: string }[] = [
  { id: "desktop", label: "Desktop", icon: Monitor, shortcut: "M" },
  { id: "preview", label: "Preview", icon: AppWindow, shortcut: "V" },
  { id: "diff", label: "Diff", icon: GitCompare, shortcut: "D" },
  { id: "files", label: "Files", icon: FolderTree, shortcut: "F" },
  { id: "pull-requests", label: "Pull requests", icon: GitPullRequest, shortcut: "P" },
]

const tabOf = (id: SidebarTabId) => SIDEBAR_TABS.find((t) => t.id === id) ?? SIDEBAR_TABS[0]!

/** What the thread's pull requests look like on their tab: "PR #12" for one, a count for several. */
export interface PullRequestTab {
  count: number
  label: string
}

/** A press on a tab turns into a drag once the pointer has moved this far, so plain clicks still select. */
const DRAG_THRESHOLD_PX = 4

/**
 * The open sidebar's header: its open tabs, each closable and draggable to reorder, then a + menu that opens another
 * (or focuses it).
 */
export function SidebarTabStrip({
  tabs,
  active,
  pullRequests,
  onSelect,
  onClose,
  onOpen,
  onReorder,
}: {
  tabs: readonly SidebarTabId[]
  active: SidebarTabId | undefined
  pullRequests: PullRequestTab
  onSelect: (id: SidebarTabId) => void
  onClose: (id: SidebarTabId) => void
  onOpen: (id: SidebarTabId) => void
  onReorder: (tabs: readonly SidebarTabId[]) => void
}) {
  const [menuOpen, setMenuOpen] = useState(false)
  const available = (id: SidebarTabId) => id !== "pull-requests" || pullRequests.count > 0
  const listRef = useRef<HTMLDivElement>(null)
  const press = useRef<{ id: SidebarTabId; pointerId: number; startX: number } | null>(null)
  const [dragging, setDragging] = useState<SidebarTabId | null>(null)

  function onTabPointerDown(e: PointerEvent<HTMLDivElement>, id: SidebarTabId) {
    if (e.button !== 0) return
    press.current = { id, pointerId: e.pointerId, startX: e.clientX }
  }

  // Capture starts only once the press becomes a drag: capturing earlier would retarget the click away from the tab.
  // While dragging, the tab moves live to the slot under the pointer, judged by the other tabs' midpoints.
  function onTabPointerMove(e: PointerEvent<HTMLDivElement>) {
    const current = press.current
    if (current === null || current.pointerId !== e.pointerId) return
    if (dragging === null) {
      if (Math.abs(e.clientX - current.startX) < DRAG_THRESHOLD_PX) return
      e.currentTarget.setPointerCapture(e.pointerId)
      setDragging(current.id)
      onSelect(current.id)
    }
    const list = listRef.current
    if (list === null) return
    const others = tabs.filter((t) => t !== current.id)
    const slot = tabs.reduce((count, t, i) => {
      if (t === current.id) return count
      const rect = list.children[i]?.getBoundingClientRect()
      return rect !== undefined && e.clientX > rect.left + rect.width / 2 ? count + 1 : count
    }, 0)
    const next = [...others.slice(0, slot), current.id, ...others.slice(slot)]
    if (next.some((t, i) => t !== tabs[i])) onReorder(next)
  }

  function onTabPointerEnd() {
    press.current = null
    setDragging(null)
  }

  // A tab's letter picks it while the menu is open; this runs before Radix's typeahead, which it replaces.
  function onMenuKey(e: KeyboardEvent<HTMLDivElement>) {
    if (e.metaKey || e.ctrlKey || e.altKey) return
    const picked = SIDEBAR_TABS.find((t) => t.shortcut.toLowerCase() === e.key.toLowerCase())
    if (picked === undefined || !available(picked.id)) return
    e.preventDefault()
    setMenuOpen(false)
    onOpen(picked.id)
  }

  return (
    <div className="flex min-w-0 items-center gap-1">
      <div ref={listRef} role="tablist" className="flex min-w-0 items-center gap-1 overflow-x-auto [scrollbar-width:none]">
        {tabs.map((id) => {
          const t = tabOf(id)
          const selected = id === active
          const label = id === "pull-requests" ? pullRequests.label : t.label
          return (
            <div
              key={id}
              className={cn(
                "group/tab flex h-7 shrink-0 items-center rounded-full text-xs font-medium transition-[color,background-color,box-shadow] duration-200 select-none",
                selected
                  ? "bg-white/[0.06] text-foreground shadow-soft"
                  : "text-muted-foreground hover:bg-white/[0.06] hover:text-foreground",
                dragging === id && "cursor-grabbing bg-white/10 shadow-glow",
              )}
              onPointerDown={(e) => onTabPointerDown(e, id)}
              onPointerMove={onTabPointerMove}
              onPointerUp={onTabPointerEnd}
              onPointerCancel={onTabPointerEnd}
            >
              <button
                type="button"
                role="tab"
                aria-selected={selected}
                title={label}
                className="flex h-full items-center gap-1.5 rounded-full pr-1 pl-3 outline-none focus-visible:shadow-glow [&_svg]:size-4 [&_svg]:shrink-0"
                onClick={() => onSelect(id)}
                // Middle-click closes, as in a browser.
                onAuxClick={(e) => {
                  if (e.button === 1) onClose(id)
                }}
              >
                <t.icon />
                {label}
                {id === "pull-requests" && pullRequests.count > 1 && (
                  <span className="rounded-full bg-white/10 px-1.5 text-[10px] tabular-nums">{pullRequests.count}</span>
                )}
              </button>
              <button
                type="button"
                aria-label={`Close ${label}`}
                title={`Close ${label}`}
                className={cn(
                  "mr-1 grid size-5 place-items-center rounded-full text-muted-foreground outline-none transition-opacity hover:bg-white/10 hover:text-foreground focus-visible:opacity-100 focus-visible:shadow-glow [&_svg]:size-3",
                  selected ? "opacity-100" : "opacity-0 group-hover/tab:opacity-100",
                )}
                onClick={() => onClose(id)}
              >
                <X />
              </button>
            </div>
          )
        })}
      </div>
      <DropdownMenu open={menuOpen} onOpenChange={setMenuOpen}>
        <DropdownMenuTrigger asChild>
          <Button
            variant="ghost"
            size="icon"
            aria-label="Open a tab"
            title="Open a tab"
            className="size-7 data-[state=open]:bg-white/[0.06] data-[state=open]:text-foreground"
          >
            <Plus />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="min-w-52" onKeyDown={onMenuKey}>
          {SIDEBAR_TABS.map((t) => (
            <DropdownMenuItem key={t.id} disabled={!available(t.id)} onSelect={() => onOpen(t.id)}>
              <t.icon />
              {t.label}
              <span className="ml-auto pl-6 text-xs text-muted-foreground">{t.shortcut}</span>
            </DropdownMenuItem>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  )
}
