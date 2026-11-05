import { useEffect, useRef } from "react"
import type { ModelInfo } from "@cloudagents/protocol"
import { modelMentionOf } from "@cloudagents/composer/models"
import { HarnessLogo } from "@/components/HarnessLogo"
import { AUTOCOMPLETE_MENU_CLASS, slashListboxId, slashOptionId } from "@/components/SlashCommands"
import { harnessOf } from "@/lib/harnesses"
import { cn } from "@/lib/utils"

/** Model mentions share the command menu's focus, pointer and keyboard-selection conventions. */
export function ModelMentions({ id, matches, query, pending, failed, activeIndex, onActiveIndexChange, onSelect }: {
  id: string
  matches: readonly ModelInfo[]
  query: string
  pending: boolean
  failed: boolean
  activeIndex: number
  onActiveIndexChange: (index: number) => void
  onSelect: (model: ModelInfo) => void
}) {
  const activeOption = useRef<HTMLDivElement>(null)
  useEffect(() => {
    activeOption.current?.scrollIntoView({ block: "nearest" })
  }, [activeIndex, query])

  return (
    <div className={AUTOCOMPLETE_MENU_CLASS}>
      <div id={slashListboxId(id)} role="listbox" aria-label="Models to mention" className="max-h-72 overflow-y-auto">
        {matches.map((model, index) => {
          const mention = modelMentionOf(model)
          const selected = index === activeIndex
          return (
            <div
              key={model.id}
              id={slashOptionId(id, index)}
              ref={selected ? activeOption : undefined}
              role="option"
              aria-label={`${mention.name}, ${mention.harnessName}, ${mention.slug}`}
              aria-selected={selected}
              title={`${mention.harnessName} · Usage: ${mention.provider}`}
              onPointerDown={(event) => {
                if (event.button !== 0) return
                event.preventDefault()
                onSelect(model)
              }}
              onMouseEnter={() => onActiveIndexChange(index)}
              className={cn(
                "flex cursor-pointer items-center gap-2.5 rounded-xl px-2.5 py-2 transition-colors duration-150 select-none",
                selected ? "bg-white/[0.07]" : "hover:bg-white/[0.04]",
              )}
            >
              <HarnessLogo harness={harnessOf(model.provider)} className="size-4" />
              <span className="flex min-w-0 flex-col gap-0.5">
                <span className="truncate font-medium">{mention.name}</span>
                <span className="truncate text-xs text-muted-foreground">{mention.slug}</span>
              </span>
            </div>
          )
        })}
      </div>
      {matches.length === 0 && (
        <div role="status" className="px-2.5 py-2.5 text-xs text-muted-foreground">
          {pending ? "Loading models…" : failed ? "Couldn’t load connected models." : query === "" ? "No connected models available. Manage models in Connections." : `No models match “@${query}”.`}
        </div>
      )}
    </div>
  )
}
