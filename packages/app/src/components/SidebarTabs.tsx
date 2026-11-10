import { useLayoutEffect, useRef, useState, type KeyboardEvent, type PointerEvent } from "react"
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
  const tabEls = useRef(new Map<SidebarTabId, HTMLDivElement>())
  /** The press on a tab: where it started, where in the tab it grabbed, and where the pointer is now. */
  const press = useRef<{ id: SidebarTabId; pointerId: number; startX: number; grabX: number; x: number } | null>(
    null,
  )
  const [dragging, setDragging] = useState<SidebarTabId | null>(null)
  /** The other tabs' on-screen positions just before a reorder, so they can slide from there to their new slots. */
  const slideFrom = useRef<Map<SidebarTabId, number> | null>(null)

  /** A position in the tab list's scrolled content, the space `offsetLeft` measures in. */
  const contentX = (list: HTMLElement, clientX: number) => clientX - list.getBoundingClientRect().left + list.scrollLeft

  /** Where the dragged tab's left edge belongs: under the pointer as grabbed, kept inside the tab list. */
  function draggedLeft(list: HTMLElement, el: HTMLElement): number {
    const current = press.current!
    return Math.min(Math.max(contentX(list, current.x) - current.grabX, 0), list.scrollWidth - el.offsetWidth)
  }

  /** Moves the dragged tab off its slot to follow the pointer; inline, so it does not wait for a render. */
  function placeDragged() {
    const list = listRef.current
    const el = press.current && tabEls.current.get(press.current.id)
    if (!list || !el) return
    el.style.transition = "none"
    el.style.transform = `translateX(${draggedLeft(list, el) - el.offsetLeft}px)`
  }

  // After a reorder: the other tabs jump to their new slots, are moved back to where they were, and transition home.
  // Then the dragged tab, whose slot moved too, is placed back under the pointer.
  useLayoutEffect(() => {
    const from = slideFrom.current
    slideFrom.current = null
    for (const [id, left] of from ?? []) {
      const el = tabEls.current.get(id)
      if (!el || left === el.offsetLeft) continue
      el.style.transition = "none"
      el.style.transform = `translateX(${left - el.offsetLeft}px)`
      void el.offsetWidth
      el.style.transition = ""
      el.style.transform = ""
    }
    if (dragging !== null) placeDragged()
  }, [tabs])

  function onTabPointerDown(e: PointerEvent<HTMLDivElement>, id: SidebarTabId) {
    if (e.button !== 0) return
    const grabX = e.clientX - e.currentTarget.getBoundingClientRect().left
    press.current = { id, pointerId: e.pointerId, startX: e.clientX, grabX, x: e.clientX }
  }

  // Capture starts only once the press becomes a drag: capturing earlier would retarget the click away from the tab.
  // While dragging, the tab follows the pointer and takes the slot its centre is over, judged by the other tabs'
  // midpoints in layout (`offsetLeft`), which ignores their slide transforms.
  function onTabPointerMove(e: PointerEvent<HTMLDivElement>) {
    const current = press.current
    if (current === null || current.pointerId !== e.pointerId) return
    current.x = e.clientX
    if (dragging === null) {
      if (Math.abs(e.clientX - current.startX) < DRAG_THRESHOLD_PX) return
      e.currentTarget.setPointerCapture(e.pointerId)
      setDragging(current.id)
      onSelect(current.id)
    }
    placeDragged()
    const list = listRef.current
    const el = tabEls.current.get(current.id)
    if (!list || !el) return
    const centre = draggedLeft(list, el) + el.offsetWidth / 2
    const others = tabs.filter((t) => t !== current.id)
    const slot = others.filter((t) => {
      const other = tabEls.current.get(t)
      return other !== undefined && other.offsetLeft + other.offsetWidth / 2 < centre
    }).length
    const next = [...others.slice(0, slot), current.id, ...others.slice(slot)]
    if (next.every((t, i) => t === tabs[i])) return
    slideFrom.current = new Map(
      others.flatMap((t) => {
        const other = tabEls.current.get(t)
        return other ? [[t, contentX(list, other.getBoundingClientRect().left)] as const] : []
      }),
    )
    onReorder(next)
  }

  // On release the dragged tab transitions from under the pointer into its slot.
  function onTabPointerEnd() {
    const el = press.current && tabEls.current.get(press.current.id)
    if (el) {
      el.style.transition = ""
      el.style.transform = ""
    }
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
      {/* Positioned so it is the tabs' offsetParent; the padding gives a lifted tab's shadow room inside the scroller. */}
      <div
        ref={listRef}
        role="tablist"
        className="relative -m-1 flex min-w-0 items-center gap-1 overflow-x-auto p-1 [scrollbar-width:none]"
      >
        {tabs.map((id) => {
          const t = tabOf(id)
          const selected = id === active
          const label = id === "pull-requests" ? pullRequests.label : t.label
          return (
            <div
              key={id}
              ref={(el) => {
                if (el) tabEls.current.set(id, el)
                else tabEls.current.delete(id)
              }}
              className={cn(
                "group/tab flex h-7 shrink-0 items-center rounded-full text-xs font-medium transition-[color,background-color,box-shadow,transform] duration-200 ease-out select-none motion-reduce:transition-none",
                selected
                  ? "bg-white/[0.06] text-foreground shadow-soft"
                  : "text-muted-foreground hover:bg-white/[0.06] hover:text-foreground",
                dragging === id &&
                  "relative z-10 cursor-grabbing bg-secondary shadow-[0_8px_24px_-6px_rgb(0_0_0/0.8),inset_0_1px_0_0_rgb(255_255_255/0.08)]",
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
                className="flex h-full items-center gap-1.5 rounded-full pr-1 pl-3 outline-none transition-shadow duration-200 ease-out focus-visible:shadow-glow [&_svg]:size-4 [&_svg]:shrink-0"
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
                  "mr-1 grid size-5 place-items-center rounded-full text-muted-foreground outline-none transition-[opacity,box-shadow] duration-200 ease-out hover:bg-white/10 hover:text-foreground focus-visible:opacity-100 focus-visible:shadow-glow [&_svg]:size-3",
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
