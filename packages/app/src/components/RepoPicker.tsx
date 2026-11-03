import { Link } from "react-router-dom"
import { useQuery } from "@tanstack/react-query"
import { Schema } from "effect"
import { BranchName } from "@cloudagents/protocol"
import { ChevronDown, FolderGit2, GitBranch, Lock, Plug } from "lucide-react"
import { ApiError } from "@/api/client"
import { queries } from "@/api/queries"
import { Button } from "@cloudagents/ui/button"
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
import { filterItemProps, useFilterMenu } from "@/hooks/useFilterMenu"
import { errorText } from "@/util"

/** Trigger of the pickers in the new-thread bar. */
export const BAR_TRIGGER_CLASS = "min-w-0 text-xs data-[state=open]:bg-white/[0.06]"
/** Content of a filtered menu: the filter box on top, the list scrolling under it. */
const FILTER_MENU_CLASS = "flex w-80 max-w-(--radix-dropdown-menu-content-available-width) flex-col"
const FILTER_LIST_CLASS =
  "max-h-[min(20rem,calc(var(--radix-dropdown-menu-content-available-height)-3.5rem))] overflow-y-auto"

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
  const menu = useFilterMenu(repos.data ?? [], (repo) => repo.fullName, (repo) => onChange(repo.fullName))
  const notConnected = repos.error instanceof ApiError && repos.error.status === 404

  return (
    <DropdownMenu open={menu.open} onOpenChange={menu.setOpen}>
      <DropdownMenuTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          disabled={disabled}
          title={value ?? "The agent checks out the repositories it needs"}
          className={BAR_TRIGGER_CLASS}
        >
          <FolderGit2 className="opacity-70" />
          <span className="truncate">{value ?? "No repository"}</span>
          <ChevronDown className="opacity-60" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className={FILTER_MENU_CLASS}>
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
              {...menu.inputProps}
              placeholder="Filter repositories"
              aria-label="Filter repositories"
              className="mb-1 h-8 shrink-0"
            />
            <div ref={menu.listRef} className={FILTER_LIST_CLASS}>
              <DropdownMenuRadioGroup value={value ?? ""} onValueChange={(v) => onChange(v === "" ? undefined : v)}>
                {menu.query === "" && (
                  <>
                    <DropdownMenuRadioItem value="" {...filterItemProps}>
                      <span className="flex flex-col">
                        No repository
                        <span className="text-xs text-muted-foreground">The agent checks out what it needs</span>
                      </span>
                    </DropdownMenuRadioItem>
                    <DropdownMenuSeparator />
                  </>
                )}
                {menu.matches.map((repo) => (
                  <DropdownMenuRadioItem key={repo.fullName} value={repo.fullName} {...filterItemProps}>
                    <span className="min-w-0 flex-1 truncate">{repo.fullName}</span>
                    {repo.private && <Lock aria-label="Private" className="text-muted-foreground" />}
                  </DropdownMenuRadioItem>
                ))}
              </DropdownMenuRadioGroup>
              {repos.isPending && <DropdownMenuLabel>Loading repositories…</DropdownMenuLabel>}
              {repos.isError && <DropdownMenuLabel>{errorText(repos.error)}</DropdownMenuLabel>}
              {repos.isSuccess && menu.matches.length === 0 && (
                <DropdownMenuLabel>
                  {menu.query === "" ? "GitHub lists no repositories." : `No repository matches “${menu.query}”.`}
                </DropdownMenuLabel>
              )}
            </div>
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

/**
 * Menu of `repo`'s branches to start from, with a filter box; `undefined` is the repository's default branch, which
 * the box resolves. Branch names a checkout cannot take (see `BranchName`) are left out.
 */
export function BranchPicker({
  repo,
  value,
  onChange,
  disabled,
}: {
  repo: string
  value: string | undefined
  onChange: (branch: string | undefined) => void
  disabled?: boolean
}) {
  const branches = useQuery(queries.githubBranches(repo))
  const listed = useQuery(queries.githubRepos()).data?.find((r) => r.fullName === repo)?.defaultBranch
  const names = (branches.data ?? []).filter(Schema.is(BranchName))
  // The listing puts the default branch first; before it loads, the repository list knows it.
  const defaultBranch = branches.data?.[0] ?? listed ?? "main"
  const menu = useFilterMenu(names, (name) => name, (name) => onChange(name === defaultBranch ? undefined : name))

  return (
    <DropdownMenu open={menu.open} onOpenChange={menu.setOpen}>
      <DropdownMenuTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          disabled={disabled}
          title="Branch the thread starts from"
          className={BAR_TRIGGER_CLASS}
        >
          <GitBranch className="opacity-70" />
          <span className="truncate">{value ?? defaultBranch}</span>
          <ChevronDown className="opacity-60" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className={FILTER_MENU_CLASS}>
        <Input {...menu.inputProps} placeholder="Filter branches" aria-label="Filter branches" className="mb-1 h-8 shrink-0" />
        <div ref={menu.listRef} className={FILTER_LIST_CLASS}>
          <DropdownMenuRadioGroup
            value={value ?? defaultBranch}
            onValueChange={(v) => onChange(v === defaultBranch ? undefined : v)}
          >
            {menu.matches.map((name) => (
              <DropdownMenuRadioItem key={name} value={name} {...filterItemProps}>
                <span className="min-w-0 flex-1 truncate">{name}</span>
                {name === defaultBranch && <span className="text-xs text-muted-foreground">default</span>}
              </DropdownMenuRadioItem>
            ))}
          </DropdownMenuRadioGroup>
          {branches.isPending && <DropdownMenuLabel>Loading branches…</DropdownMenuLabel>}
          {branches.isError && <DropdownMenuLabel>{errorText(branches.error)}</DropdownMenuLabel>}
          {branches.isSuccess && menu.matches.length === 0 && (
            <DropdownMenuLabel>No branch matches “{menu.query}”.</DropdownMenuLabel>
          )}
        </div>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
