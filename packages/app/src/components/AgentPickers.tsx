import { Fragment, useState, type KeyboardEvent } from "react"
import { Link } from "react-router-dom"
import { Schema } from "effect"
import { ChevronDown, Settings2 } from "lucide-react"
import { Popover } from "radix-ui"
import {
  AgentModel,
  EFFORT_LABELS,
  type AgentEffort,
  type ModelInfo,
} from "@cloudagents/protocol"
import { modelDisplayName, type ModelSection } from "@cloudagents/composer/models"
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
import { HarnessLogo } from "@/components/HarnessLogo"
import { filterItemProps, useFilterMenu } from "@/hooks/useFilterMenu"
import { HARNESSES, harnessForModel, type Harness, type HarnessId } from "@/lib/harnesses"
import { cn } from "@/lib/utils"

export type { ModelSection } from "@cloudagents/composer/models"

// Keep each level's visual weight consistent across models with different supported levels.
const EFFORT_RING_FILL: Record<AgentEffort, number> = {
  none: 0,
  low: 25,
  medium: 50,
  high: 75,
  xhigh: 87.5,
  max: 100,
}

/** The thinking levels a model supports, labelled the way the composer labels them. */
export const effortOptions = (model: ModelInfo | undefined): readonly { value: AgentEffort; label: string }[] =>
  (model?.efforts ?? []).map((effort) => ({
    value: effort,
    label: effort === "none" ? "Off" : EFFORT_LABELS[effort],
  }))

/** A stepped slider containing only the selected model's supported thinking levels. */
export function ThinkingPicker({
  value,
  options,
  onChange,
}: {
  value: AgentEffort | undefined
  options: readonly { value: AgentEffort; label: string }[]
  onChange: (value: AgentEffort) => void
}) {
  const selectedIndex = Math.max(0, options.findIndex((option) => option.value === value))
  const selected = options[selectedIndex]!
  const ringFill = EFFORT_RING_FILL[selected.value]
  // Keep the stops aligned with the native range's 2rem thumb, including at both ends.
  const offset = (index: number) => `calc(1rem + (100% - 2rem) * ${index / (options.length - 1)})`
  return (
    <Popover.Root>
      <Popover.Trigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          aria-label={`Thinking level: ${selected.label}`}
          className="data-[state=open]:bg-white/[0.06]"
        >
          <svg aria-hidden="true" viewBox="0 0 24 24" fill="none" strokeWidth="3">
            <circle cx="12" cy="12" r="9" stroke="currentColor" className="text-muted-foreground/30" />
            {ringFill > 0 && (
              <circle
                cx="12"
                cy="12"
                r="9"
                pathLength="100"
                stroke="currentColor"
                strokeDasharray={`${ringFill} 100`}
                strokeLinecap="round"
                transform="rotate(-90 12 12)"
              />
            )}
          </svg>
          {selected.label}
        </Button>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content
          align="start"
          side="top"
          sideOffset={8}
          collisionPadding={12}
          aria-label="Thinking level"
          className="z-50 w-72 max-w-[calc(100vw-1.5rem)] rounded-xl bg-popover p-4 text-popover-foreground shadow-soft outline-none data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=open]:zoom-in-95 data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=closed]:zoom-out-95"
        >
          <div className="mb-3 flex items-center justify-between gap-3">
            <span className="text-xs font-medium text-muted-foreground">Thinking</span>
            <span className="text-sm font-semibold">{selected.label}</span>
          </div>
          <div className="relative flex h-8 items-center rounded-full bg-input transition-shadow duration-200 ease-out has-focus-visible:shadow-glow">
            <div
              className="pointer-events-none absolute left-1 h-6 rounded-full bg-primary/20"
              style={{ width: `calc(${offset(selectedIndex)} + 0.5rem)` }}
            />
            {options.map((option, index) => (
              <span
                key={option.label}
                aria-hidden="true"
                className={cn(
                  "pointer-events-none absolute size-1 -translate-x-1/2 rounded-full",
                  index <= selectedIndex ? "bg-primary/60" : "bg-muted-foreground/40",
                )}
                style={{ left: offset(index) }}
              />
            ))}
            <span
              aria-hidden="true"
              className="pointer-events-none absolute size-6 -translate-x-1/2 rounded-full bg-primary shadow-soft"
              style={{ left: offset(selectedIndex) }}
            />
            <input
              type="range"
              aria-label="Thinking level"
              aria-valuetext={selected.label}
              min={0}
              max={options.length - 1}
              step={1}
              value={selectedIndex}
              onChange={(event) => onChange(options[Number(event.target.value)]!.value)}
              className="absolute inset-0 h-full w-full cursor-pointer appearance-none rounded-full bg-transparent opacity-0 [&::-moz-range-thumb]:size-8 [&::-moz-range-thumb]:border-0 [&::-webkit-slider-thumb]:size-8 [&::-webkit-slider-thumb]:appearance-none"
            />
          </div>
          <div aria-hidden="true" className="mt-1.5 flex justify-between text-[11px] text-muted-foreground">
            <span>{options[0]!.label}</span>
            <span>{options[options.length - 1]!.label}</span>
          </div>
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  )
}

/** A connected harness with the providers it runs that have models in the picker. */
interface HarnessTab {
  readonly harness: Harness
  readonly sections: readonly ModelSection[]
}

/** A provider's models under its label in the menu's list. */
interface ModelGroup {
  readonly harness: Harness
  readonly section: ModelSection
  readonly models: readonly ModelInfo[]
}

// Rendered heights in rem: a provider label, a model row, and the menu's fixed parts (padding, search, Manage models).
const MODEL_LABEL_REM = 1.75
const MODEL_ROW_REM = 2
const MODEL_MENU_CHROME_REM = 5.5
/** Tallest the menu gets before its list scrolls; the window's room caps it further. */
const MODEL_MENU_MAX_REM = 24
/** Width of the harness rail: a 2rem button and its 0.25rem padding on each side. */
const HARNESS_RAIL_PX = 40

/**
 * Model menu: a rail of the connected harnesses, the picked harness's models grouped by the provider behind them (its
 * subscription or an API key the user added), and a search box over every harness. The menu is as tall as its tallest
 * harness (up to a cap), so switching harnesses or searching never resizes it; longer lists scroll. In the search box,
 * ArrowLeft and ArrowRight step through the harnesses. `sections` is null while connections load.
 *
 * `defaultLabel` labels an unset choice without offering a model reset.
 */
export function ModelPicker({
  sections,
  value,
  onChange,
  defaultLabel,
}: {
  sections: readonly ModelSection[] | null
  value: ModelInfo | undefined
  onChange: (value: AgentModel) => void
  defaultLabel?: string
}) {
  const tabs: readonly HarnessTab[] = HARNESSES.map((harness) => ({
    harness,
    sections: (sections ?? []).filter((section) => section.harness === harness.id),
  })).filter((tab) => tab.sections.length > 0)
  const offered = tabs.flatMap((tab) =>
    tab.sections.flatMap((section) => section.models.map((model) => ({ harness: tab.harness, section, model }))),
  )
  const menu = useFilterMenu(
    offered,
    (item) => `${modelDisplayName(item.model)} ${item.model.name} ${item.model.id} ${item.section.provider.name} ${item.harness.name}`,
    (item) => onChange(item.model.id),
  )
  // Unset shows the selected model's actual harness; each opening goes back to it.
  const [pickedHarness, setPickedHarness] = useState<HarnessId>()
  const valueHarness = value === undefined ? undefined : harnessForModel(value)
  const tab =
    tabs.find((candidate) => candidate.harness.id === pickedHarness) ??
    tabs.find((candidate) => candidate.harness === valueHarness) ??
    tabs[0]
  const searching = menu.query !== ""
  const matched = new Set(menu.matches.map((item) => item.model.id))
  const groups: readonly ModelGroup[] = searching
    ? tabs.flatMap((candidate) =>
        candidate.sections
          .map((section) => ({ harness: candidate.harness, section, models: section.models.filter((m) => matched.has(m.id)) }))
          .filter((group) => group.models.length > 0),
      )
    : (tab?.sections.map((section) => ({ harness: tab.harness, section, models: section.models })) ?? [])
  const tallestTabRem = Math.max(
    2 * MODEL_ROW_REM,
    ...tabs.map((candidate) =>
      candidate.sections.reduce((sum, section) => sum + MODEL_LABEL_REM + section.models.length * MODEL_ROW_REM, 0),
    ),
  )
  const menuHeight = `min(${Math.min(MODEL_MENU_MAX_REM, MODEL_MENU_CHROME_REM + tallestTabRem)}rem + 1px, var(--radix-dropdown-menu-content-available-height))`

  function stepHarness(delta: 1 | -1) {
    if (tab === undefined) return
    const next = tabs[(tabs.indexOf(tab) + delta + tabs.length) % tabs.length]!
    setPickedHarness(next.harness.id)
  }

  function onSearchKeyDown(e: KeyboardEvent<HTMLInputElement>) {
    if (!searching && tabs.length > 1 && (e.key === "ArrowLeft" || e.key === "ArrowRight")) {
      e.preventDefault()
      e.stopPropagation()
      stepHarness(e.key === "ArrowRight" ? 1 : -1)
      return
    }
    menu.inputProps.onKeyDown(e)
  }

  const label = value === undefined ? defaultLabel ?? (sections === null ? "Model" : "No models") : modelDisplayName(value)
  return (
    <DropdownMenu
      open={menu.open}
      onOpenChange={(open) => {
        if (open) setPickedHarness(undefined)
        menu.setOpen(open)
      }}
    >
      <DropdownMenuTrigger asChild>
        <Button type="button" variant="ghost" size="sm" className="data-[state=open]:bg-white/[0.06]">
          {valueHarness && <HarnessLogo harness={valueHarness} className="size-4" />}
          {label}
          <ChevronDown className="opacity-60" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="start"
        side="top"
        // The rail hangs off the panel's left edge; this keeps the panel itself aligned with the button.
        alignOffset={tabs.length > 0 ? -HARNESS_RAIL_PX : 0}
        // The content is only the frame: the panel below carries the menu surface, so the rail can sit outside it.
        className="flex max-w-(--radix-dropdown-menu-content-available-width) items-start overflow-visible bg-transparent p-0 shadow-none"
        style={{ height: menuHeight }}
      >
        {tabs.length > 0 && (
          // A tab poking out from behind the panel's left edge, in the panel's own surface and drop shadow, as tall as its
          // harnesses, scrolling only on a short window. Opaque, so the transcript behind the menu never shows through.
          // Hidden, but still holding its place, while searching.
          <div
            role="group"
            aria-label="Harnesses"
            aria-hidden={searching || undefined}
            className={cn(
              "mt-4 flex max-h-[calc(100%-2rem)] shrink-0 flex-col gap-0.5 overflow-y-auto rounded-l-xl bg-secondary p-1 shadow-[0_16px_40px_-12px_rgb(0_0_0/0.85),inset_0_1px_0_0_rgb(255_255_255/0.05)]",
              searching && "invisible",
            )}
          >
            {tabs.map((candidate) => (
              <button
                key={candidate.harness.id}
                type="button"
                tabIndex={-1}
                aria-label={candidate.harness.name}
                aria-pressed={candidate === tab}
                title={candidate.harness.name}
                // Keeps focus in the search box, so typing still filters after switching harness.
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => setPickedHarness(candidate.harness.id)}
                className={cn(
                  "flex size-8 shrink-0 items-center justify-center rounded-lg text-foreground transition-colors hover:bg-white/[0.06]",
                  candidate === tab && "bg-white/[0.1] hover:bg-white/[0.1]",
                )}
              >
                <HarnessLogo harness={candidate.harness} className="size-4" />
              </button>
            ))}
          </div>
        )}
        <div className="flex h-full w-80 min-w-0 flex-col rounded-2xl bg-secondary p-1.5 shadow-[0_16px_40px_-12px_rgb(0_0_0/0.85),inset_0_1px_0_0_rgb(255_255_255/0.05)]">
          {tabs.length > 0 && (
            <Input
              {...menu.inputProps}
              onKeyDown={onSearchKeyDown}
              placeholder={tab && !searching ? `Search models · ${tab.harness.name}` : "Search models"}
              aria-label="Search models"
              className="mb-1 h-8 shrink-0"
            />
          )}
          <div ref={menu.listRef} className="min-h-0 flex-1 overflow-y-auto">
            {sections === null && <DropdownMenuLabel>Loading models…</DropdownMenuLabel>}
            {sections !== null && tabs.length === 0 && (
              <DropdownMenuLabel>Connect a harness or add an API key to choose a model.</DropdownMenuLabel>
            )}
            <DropdownMenuRadioGroup
              value={value?.id ?? ""}
              onValueChange={(v) => {
                if (Schema.is(AgentModel)(v)) onChange(v)
              }}
            >
              {groups.map((group) => (
                <Fragment key={`${group.harness.id}:${group.section.provider.id}`}>
                  <DropdownMenuLabel className="flex items-center gap-1.5">
                    {searching && <HarnessLogo harness={group.harness} className="size-3.5" />}
                    <span className="truncate">
                      {searching ? `${group.harness.name} · ${group.section.provider.name}` : group.section.provider.name}
                    </span>
                  </DropdownMenuLabel>
                  {group.models.map((m) => (
                    <DropdownMenuRadioItem key={m.id} value={m.id} {...filterItemProps}>
                      <span className="min-w-0 flex-1 truncate">{modelDisplayName(m)}</span>
                    </DropdownMenuRadioItem>
                  ))}
                </Fragment>
              ))}
            </DropdownMenuRadioGroup>
            {searching && groups.length === 0 && (
              <DropdownMenuLabel>No model matches “{menu.query}”.</DropdownMenuLabel>
            )}
          </div>
          <DropdownMenuSeparator />
          <DropdownMenuItem asChild>
            <Link to="/settings/connections" className="text-muted-foreground">
              <Settings2 />
              Manage models
            </Link>
          </DropdownMenuItem>
        </div>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
