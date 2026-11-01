import { useRef, useState, type KeyboardEvent, type PointerEvent } from "react"
import { Link } from "react-router-dom"
import { useQuery } from "@tanstack/react-query"
import { ChevronDown, FolderGit2, Lock, Plug } from "lucide-react"
import { ApiError } from "@/api/client"
import { queries } from "@/api/queries"
import { Button } from "@/components/ui/button"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { Input } from "@/components/ui/input"
import { errorText } from "@/util"

/** Hover highlights without moving focus, so the filter box keeps the keyboard while the pointer crosses the list. */
const keepFilterFocus = (e: PointerEvent) => e.preventDefault()
const HOVER_CLASS = "hover:bg-white/[0.07]"

/**
 * Menu of the GitHub repositories the user can read, with a filter box; `undefined` leaves the choice to the agent.
 * Without a GitHub connection it points to Connections instead.
 */
export function RepoPicker({
  value,
  onChange,
  disabled,
}: {
  value: string | undefined
  onChange: (repo: string | undefined) => void
  disabled?: boolean
}) {
  const repos = useQuery(queries.githubRepos())
  const [open, setOpen] = useState(false)
  const [filter, setFilter] = useState("")
  const list = useRef<HTMLDivElement>(null)

  const needle = filter.trim().toLowerCase()
  const matches = (repos.data ?? []).filter((repo) => repo.fullName.toLowerCase().includes(needle))
  const notConnected = repos.error instanceof ApiError && repos.error.status === 404

  function setMenuOpen(next: boolean) {
    setOpen(next)
    if (!next) setFilter("")
  }

  function pick(repo: string | undefined) {
    onChange(repo)
    setMenuOpen(false)
  }

  function onFilterKey(e: KeyboardEvent<HTMLInputElement>) {
    if (e.key === "Escape") return
    // Everything else stays in the box: the menu's typeahead would move focus to an item.
    e.stopPropagation()
    if (e.key === "ArrowDown") {
      e.preventDefault()
      list.current?.querySelector<HTMLElement>("[role=menuitemradio]")?.focus()
    } else if (e.key === "Enter" && needle !== "") {
      e.preventDefault()
      const first = matches[0]
      if (first) pick(first.fullName)
    }
  }

  return (
    <DropdownMenu open={open} onOpenChange={setMenuOpen}>
      <DropdownMenuTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          disabled={disabled}
          title={value ?? "The agent checks out the repositories it needs"}
          className="min-w-0 text-xs data-[state=open]:bg-white/[0.06]"
        >
          <FolderGit2 className="opacity-70" />
          <span className="truncate">{value ?? "No repository"}</span>
          <ChevronDown className="opacity-60" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="flex w-80 max-w-(--radix-dropdown-menu-content-available-width) flex-col">
        {notConnected ? (
          <>
            <DropdownMenuLabel>Connect GitHub to start in one of your repositories.</DropdownMenuLabel>
            <DropdownMenuItem asChild>
              <Link to="/settings/connections">
                <Plug />
                Connections
              </Link>
            </DropdownMenuItem>
          </>
        ) : (
          <>
            <Input
              autoFocus
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
              onKeyDown={onFilterKey}
              placeholder="Filter repositories"
              aria-label="Filter repositories"
              className="mb-1 h-8 shrink-0"
            />
            <div
              ref={list}
              className="max-h-[min(20rem,calc(var(--radix-dropdown-menu-content-available-height)-3.5rem))] overflow-y-auto"
            >
              <DropdownMenuRadioGroup value={value ?? ""} onValueChange={(v) => pick(v === "" ? undefined : v)}>
                {needle === "" && (
                  <>
                    <DropdownMenuRadioItem
                      value=""
                      className={HOVER_CLASS}
                      onPointerMove={keepFilterFocus}
                      onPointerLeave={keepFilterFocus}
                    >
                      <span className="flex flex-col">
                        No repository
                        <span className="text-xs text-muted-foreground">The agent checks out what it needs</span>
                      </span>
                    </DropdownMenuRadioItem>
                    <DropdownMenuSeparator />
                  </>
                )}
                {matches.map((repo) => (
                  <DropdownMenuRadioItem
                    key={repo.fullName}
                    value={repo.fullName}
                    className={HOVER_CLASS}
                    onPointerMove={keepFilterFocus}
                    onPointerLeave={keepFilterFocus}
                  >
                    <span className="min-w-0 flex-1 truncate">{repo.fullName}</span>
                    {repo.private && <Lock aria-label="Private" className="text-muted-foreground" />}
                  </DropdownMenuRadioItem>
                ))}
              </DropdownMenuRadioGroup>
              {repos.isPending && <DropdownMenuLabel>Loading repositories…</DropdownMenuLabel>}
              {repos.isError && <DropdownMenuLabel>{errorText(repos.error)}</DropdownMenuLabel>}
              {repos.isSuccess && matches.length === 0 && (
                <DropdownMenuLabel>
                  {needle === "" ? "GitHub lists no repositories." : `No repository matches “${filter.trim()}”.`}
                </DropdownMenuLabel>
              )}
            </div>
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
