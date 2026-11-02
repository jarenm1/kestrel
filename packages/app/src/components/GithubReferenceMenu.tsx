import { useEffect, useRef } from "react"
import { CircleDot, GitPullRequest, type LucideIcon } from "lucide-react"
import type { GithubReferenceKind } from "@/lib/githubReference"
import { cn } from "@/lib/utils"
import { RepoPicker } from "@/components/RepoPicker"
import { AUTOCOMPLETE_MENU_CLASS, slashListboxId, slashOptionId } from "@/components/SlashCommands"

interface Option {
  readonly kind: GithubReferenceKind
  readonly detail: string
  readonly Icon: LucideIcon
}

const OPTIONS: readonly Option[] = [
  { kind: "pr", detail: "Reference the pull request", Icon: GitPullRequest },
  { kind: "issue", detail: "Reference the issue", Icon: CircleDot },
]

/**
 * The `#` menu above the composer: the same PR / Issue pair for the number being typed. Without one unambiguous
 * repository it embeds the repository picker; both choices stay listed but disabled until one is chosen. Nothing is
 * fetched here: the reader checks that the reference exists when the agent follows it.
 */
export function GithubReferenceMenu({
  id,
  number,
  repo,
  onRepoChange,
  activeIndex,
  onActiveIndexChange,
  onSelect,
}: {
  /** Stable base for the listbox and option ids. */
  id: string
  number: number
  /** The repository the reference will name; undefined until the composer (or this picker) resolves one. */
  repo: string | undefined
  onRepoChange: (repo: string | undefined) => void
  activeIndex: number
  onActiveIndexChange: (index: number) => void
  onSelect: (kind: GithubReferenceKind) => void
}) {
  const listboxId = slashListboxId(id)
  const selectedIndex = Math.min(activeIndex, OPTIONS.length - 1)
  const activeOption = useRef<HTMLDivElement>(null)

  // Keyboard navigation past the fold must bring the active option into the menu's view.
  useEffect(() => {
    activeOption.current?.scrollIntoView({ block: "nearest" })
  }, [selectedIndex])

  return (
    <div className={AUTOCOMPLETE_MENU_CLASS}>
      {repo === undefined && (
        <div className="flex flex-wrap items-center gap-2 border-b border-white/[0.06] px-2 pb-2 pt-1">
          <span className="text-xs text-muted-foreground">Repository for #{number}</span>
          <RepoPicker value={repo} onChange={onRepoChange} />
        </div>
      )}
      <div id={listboxId} role="listbox" aria-label={`Reference #${number}`} className="max-h-72 overflow-y-auto">
        {OPTIONS.map((option, index) => {
          const selected = index === selectedIndex
          const Icon = option.Icon
          return (
            <div
              key={option.kind}
              id={slashOptionId(id, index)}
              ref={selected ? activeOption : undefined}
              role="option"
              aria-selected={selected}
              aria-disabled={repo === undefined}
              onPointerDown={(event) => {
                // Pointer down, not click: the editor must not blur (which closes this menu) before a pick.
                if (event.button !== 0) return
                event.preventDefault()
                if (repo === undefined) return
                onSelect(option.kind)
              }}
              onMouseEnter={() => onActiveIndexChange(index)}
              className={cn(
                "flex cursor-pointer items-center gap-2.5 rounded-xl px-2.5 py-2 transition-colors duration-150 select-none",
                selected ? "bg-white/[0.07]" : "hover:bg-white/[0.04]",
                repo === undefined && "cursor-not-allowed opacity-50",
              )}
            >
              <Icon aria-hidden="true" className="size-4 shrink-0" />
              <span className="min-w-0 flex-1">
                <span className="flex min-w-0 items-baseline gap-2">
                  <span className="shrink-0 font-semibold underline underline-offset-4">
                    {option.kind === "pr" ? "PR" : "Issue"} #{number}
                  </span>
                  <span className="truncate text-xs text-muted-foreground">{repo ?? "Repository needed"}</span>
                </span>
                <span className="block text-xs leading-relaxed text-muted-foreground">{option.detail}</span>
              </span>
            </div>
          )
        })}
      </div>
      {repo === undefined && (
        <div role="status" className="flex items-center gap-2 px-2.5 py-2 text-xs text-muted-foreground">
          Choose a repository to add this reference.
        </div>
      )}
    </div>
  )
}
