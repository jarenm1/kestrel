import { useState, type KeyboardEvent } from "react"
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

/** The open sidebar's header: its open tabs, each closable, then a + menu that opens another (or focuses it). */
export function SidebarTabStrip({
  tabs,
  active,
  pullRequests,
  onSelect,
  onClose,
  onOpen,
}: {
  tabs: readonly SidebarTabId[]
  active: SidebarTabId | undefined
  pullRequests: PullRequestTab
  onSelect: (id: SidebarTabId) => void
  onClose: (id: SidebarTabId) => void
  onOpen: (id: SidebarTabId) => void
}) {
  const [menuOpen, setMenuOpen] = useState(false)
  const available = (id: SidebarTabId) => id !== "pull-requests" || pullRequests.count > 0

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
      <div role="tablist" className="flex min-w-0 items-center gap-1 overflow-x-auto [scrollbar-width:none]">
        {tabs.map((id) => {
          const t = tabOf(id)
          const selected = id === active
          const label = id === "pull-requests" ? pullRequests.label : t.label
          return (
            <div
              key={id}
              className={cn(
                "group/tab flex h-7 shrink-0 items-center rounded-full text-xs font-medium transition-[color,background-color,box-shadow] duration-200",
                selected
                  ? "bg-white/[0.06] text-foreground shadow-soft"
                  : "text-muted-foreground hover:bg-white/[0.06] hover:text-foreground",
              )}
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
