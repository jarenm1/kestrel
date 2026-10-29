import { Loader2 } from "lucide-react"
import { useEffect, useRef, type ReactNode } from "react"
import type { HarnessCommand, ModelProvider } from "@cloudagents/protocol"
import { cn } from "@/lib/utils"
import { errorText } from "@/util"

/** Id of the listbox the composer's textarea points its `aria-controls` at. */
export const slashListboxId = (baseId: string) => `${baseId}-listbox`

/** Id of one option; the active one goes in the textarea's `aria-activedescendant`. */
export const slashOptionId = (baseId: string, index: number) => `${baseId}-option-${index}`

const PROVIDER_LABELS: Record<ModelProvider, string> = {
  anthropic: "Claude Code",
  openai: "Codex",
}

function StateLine({ children }: { children: ReactNode }) {
  return (
    <div role="status" className="flex items-center gap-2 px-2.5 py-2.5 text-xs text-muted-foreground">
      {children}
    </div>
  )
}

/**
 * The slash-command menu above the composer. The page behind it owns the filtered `matches`, the active index and
 * the selection; this only renders the states and forwards pointer picks. Keeping focus on the textarea is the
 * caller's job; options never take a click that would blur it away.
 */
export function SlashCommands({
  id,
  query,
  trigger,
  provider,
  matches,
  chosenModel,
  pending,
  error,
  activeIndex,
  onActiveIndexChange,
  onSelect,
}: {
  /** Stable base for the listbox and option ids. */
  id: string
  /** Character that opened the menu: `/` for Claude, `/` or native `$` for Codex. */
  trigger: "/" | "$"
  /** Text after the leading trigger, used in the empty state. */
  query: string
  /** Harness of the loaded list; shown so the provider in use is visible. */
  provider: ModelProvider | undefined
  matches: readonly HarnessCommand[]
  /** False before a model is on offer: no harness exists to ask. */
  chosenModel: boolean
  pending: boolean
  error: unknown
  activeIndex: number
  onActiveIndexChange: (index: number) => void
  onSelect: (command: HarnessCommand) => void
}) {
  const listboxId = slashListboxId(id)
  const selectedIndex = matches.length === 0 ? -1 : Math.min(activeIndex, matches.length - 1)
  const activeOption = useRef<HTMLDivElement>(null)
  // Codex resolves `$skill-name`; Claude Code resolves `/name`. The slash menu itself triggers either list.
  const prefix = provider === "openai" ? "$" : "/"
  const noun = provider === "openai" ? "skills" : "slash commands"
  const title = provider === "openai" ? "Skills" : "Slash commands"

  // Keyboard navigation past the fold must bring the active option into the menu's view.
  useEffect(() => {
    if (selectedIndex === -1) return
    activeOption.current?.scrollIntoView({ block: "nearest" })
  }, [selectedIndex])

  return (
    <div
      className={cn(
        "absolute bottom-full left-0 z-20 mb-2 w-full overflow-hidden rounded-2xl bg-popover p-1.5 text-sm text-popover-foreground ring-1 ring-white/[0.06]",
        "shadow-[0_16px_40px_-12px_rgb(0_0_0/0.85),inset_0_1px_0_0_rgb(255_255_255/0.05)]",
        "animate-in duration-150 fade-in slide-in-from-bottom-1",
      )}
    >
      <div className="flex items-center gap-2 px-2.5 pt-0.5 pb-1.5 text-[11px] text-muted-foreground">
        <span className="font-medium text-foreground/80">{title}</span>
        {provider !== undefined && <span className="ml-auto uppercase tracking-[0.08em]">{PROVIDER_LABELS[provider]}</span>}
      </div>
      {!chosenModel ? (
        <StateLine>Choose a model to see its commands.</StateLine>
      ) : pending ? (
        <StateLine>
          <Loader2 className="size-3.5 animate-spin" />
          Loading commands…
        </StateLine>
      ) : error !== undefined && error !== null ? (
        <StateLine>
          <span className="line-clamp-2">Couldn’t load commands: {errorText(error)}</span>
        </StateLine>
      ) : matches.length === 0 ? (
        <StateLine>
          {query === ""
            ? `No ${noun} available for this harness.`
            : `No ${noun} match “${trigger}${query}”.`}
        </StateLine>
      ) : (
        <div
          id={listboxId}
          role="listbox"
          aria-label={provider === undefined ? "Slash commands" : `${PROVIDER_LABELS[provider]} ${noun}`}
          className="max-h-72 overflow-y-auto"
        >
          {matches.map((command, index) => {
            const selected = index === selectedIndex
            return (
              <div
                key={command.name}
                id={slashOptionId(id, index)}
                ref={selected ? activeOption : undefined}
                role="option"
                aria-selected={selected}
                onPointerDown={(e) => {
                  // Pointer down, not click: the textarea must not blur (which closes this menu) before a pick.
                  if (e.button !== 0) return
                  e.preventDefault()
                  onSelect(command)
                }}
                onMouseEnter={() => onActiveIndexChange(index)}
                className={cn(
                  "flex cursor-pointer flex-col gap-0.5 rounded-xl px-2.5 py-2 transition-colors duration-150 select-none",
                  selected ? "bg-white/[0.07]" : "hover:bg-white/[0.04]",
                )}
              >
                <span className="flex min-w-0 items-baseline gap-2">
                  <span className="shrink-0 font-medium">{prefix}{command.name}</span>
                  {command.argumentHint !== undefined && command.argumentHint !== "" && (
                    <span className="truncate text-xs text-muted-foreground">{command.argumentHint}</span>
                  )}
                </span>
                <span className="line-clamp-2 text-xs leading-relaxed text-muted-foreground">{command.description}</span>
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}
