import {
  Fragment,
  useEffect,
  useId,
  useRef,
  useState,
  type ClipboardEvent,
  type DragEvent,
  type FormEvent,
  type KeyboardEvent,
} from "react"
import { Link } from "react-router-dom"
import { useQuery } from "@tanstack/react-query"
import { Schema } from "effect"
import { ArrowUp, Check, ChevronDown, FileText, MousePointer2, Paperclip, Settings2, Square, X } from "lucide-react"
import { Popover } from "radix-ui"
import {
  AgentModel,
  EFFORT_LABELS,
  EffortPick,
  ModelProvider,
  GithubRepoSlug,
  MAX_ATTACHMENT_BYTES,
  connectedModelProviders,
  harnessCommandPrefix,
  resolveAgentChoice,
  type AgentEffort,
  type ContextUsage,
  type HarnessCommand,
  type Message,
  type ModelInfo,
  type ModelProviderInfo,
  type Run,
  type SendMessageBody,
  type SendMessageResponse,
} from "@cloudagents/protocol"
import { queries } from "@/api/queries"
import { Alert } from "@cloudagents/ui/alert"
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
import { SlashCommands, slashListboxId, slashOptionId } from "@/components/SlashCommands"
import {
  appCommandOf,
  matchAppCommand,
  withAppCommands,
  type AppCommand,
  type AppCommandHandlers,
} from "@cloudagents/composer/commands"
import {
  ComposerEditor,
  composerViewOf,
  type ComposerEditorHandle,
  type ComposerEditorView,
} from "@cloudagents/composer/editor"
import { findModelMentionTrigger, filterMentionModels } from "@cloudagents/composer/models"
import { ModelMentions } from "@/components/ModelMentions"
import { GithubReferenceMenu } from "@/components/GithubReferenceMenu"
import { useOpenUsagePanel } from "@/components/UsagePanel"
import {
  findGithubReferenceTrigger,
  type GithubReferenceKind,
} from "@cloudagents/composer/reference"
import { filterItemProps, useFilterMenu } from "@/hooks/useFilterMenu"
import { useShownModels } from "@/hooks/useShownModels"
import { useStoredChoice } from "@/hooks/useStoredChoice"
import { useStoredDraft } from "@/hooks/useStoredDraft"
import { usePromptHistory } from "@/hooks/usePromptHistory"
import { HARNESSES, harnessOf, type Harness, type HarnessId } from "@/lib/harnesses"
import { cn } from "@/lib/utils"
import { errorText } from "@/util"
import { ContextBar } from "./ContextBar"
import { Markdown } from "@cloudagents/ui/markdown"
import { MessageAttachments } from "@cloudagents/ui/message-attachments"

/** A connected provider and the models the user keeps in the picker for it. */
interface ModelSection {
  readonly provider: ModelProviderInfo
  readonly models: readonly ModelInfo[]
}

const MODEL_LOGOS = Object.fromEntries(ModelProvider.literals.map((provider) => {
  const harness = harnessOf(provider)
  return [provider, { src: harness.logo, monochrome: harness.monochrome }]
}))

// Keep each level's visual weight consistent across models with different supported levels.
const EFFORT_RING_FILL: Record<AgentEffort, number> = {
  none: 0,
  low: 25,
  medium: 50,
  high: 75,
  xhigh: 87.5,
  max: 100,
}

/** A stepped slider containing only the selected model's supported thinking levels. */
function ThinkingPicker({
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
          <div className="relative flex h-8 items-center rounded-full bg-input transition-shadow has-focus-visible:shadow-glow">
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
 */
function ModelPicker({
  sections,
  value,
  onChange,
}: {
  sections: readonly ModelSection[] | null
  value: ModelInfo | undefined
  onChange: (value: AgentModel) => void
}) {
  const tabs: readonly HarnessTab[] = HARNESSES.map((harness) => ({
    harness,
    sections: (sections ?? []).filter((section) => harnessOf(section.provider.id) === harness),
  })).filter((tab) => tab.sections.length > 0)
  const offered = tabs.flatMap((tab) =>
    tab.sections.flatMap((section) => section.models.map((model) => ({ harness: tab.harness, section, model }))),
  )
  const menu = useFilterMenu(
    offered,
    (item) => `${item.model.name} ${item.model.id} ${item.section.provider.name} ${item.harness.name}`,
    (item) => onChange(item.model.id),
  )
  // Unset shows the selected model's harness; each opening goes back to it.
  const [pickedHarness, setPickedHarness] = useState<HarnessId>()
  const valueHarness = value === undefined ? undefined : harnessOf(value.provider)
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

  const label = value?.name ?? (sections === null ? "Model" : "No models")
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
                <Fragment key={group.section.provider.id}>
                  <DropdownMenuLabel className="flex items-center gap-1.5">
                    {searching && <HarnessLogo harness={group.harness} className="size-3.5" />}
                    <span className="truncate">
                      {searching ? `${group.harness.name} · ${group.section.provider.name}` : group.section.provider.name}
                    </span>
                  </DropdownMenuLabel>
                  {group.models.map((m) => (
                    <DropdownMenuRadioItem key={m.id} value={m.id} {...filterItemProps}>
                      <span className="min-w-0 flex-1 truncate">{m.name}</span>
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

/** A file waiting to go with the next message: a thumbnail for images, else its name; the cross removes it. */
function PendingFile({ file, onRemove }: { file: File; onRemove: () => void }) {
  const isImage = file.type.startsWith("image/")
  const [preview, setPreview] = useState<string>()
  useEffect(() => {
    if (!isImage) return
    const url = URL.createObjectURL(file)
    setPreview(url)
    return () => URL.revokeObjectURL(url)
  }, [file, isImage])

  return (
    <div className="group relative flex h-14 max-w-56 items-center gap-2 rounded-xl bg-white/[0.06] shadow-soft">
      {isImage ? (
        preview && <img src={preview} alt={file.name} className="h-14 w-14 rounded-xl object-cover" />
      ) : (
        <>
          <FileText className="ml-3 size-4 shrink-0 text-muted-foreground" />
          <span className="truncate pr-6 text-xs">{file.name}</span>
        </>
      )}
      <button
        type="button"
        aria-label={`Remove ${file.name}`}
        title={`Remove ${file.name}`}
        onClick={onRemove}
        className="absolute -top-1.5 -right-1.5 flex size-5 items-center justify-center rounded-full bg-secondary text-muted-foreground shadow-soft hover:text-foreground"
      >
        <X className="size-3" />
      </button>
    </div>
  )
}

/** A UI element picked in the thread's browser preview, sent with the next message as context. */
export interface ElementContext {
  readonly label: string
  readonly selector: string
  readonly html: string
  readonly page: string | undefined
}

/** The context block appended to the message text, one section per picked element. */
function elementsText(elements: readonly ElementContext[]): string {
  return elements
    .map((e) => {
      const lines = [`Selected UI element: ${e.label}`]
      if (e.page) lines.push(`Page: ${e.page}`)
      lines.push(`Selector: \`${e.selector}\``)
      if (e.html) lines.push("```html", e.html, "```")
      return lines.join("\n")
    })
    .join("\n\n")
}

/** A picked preview element waiting to go with the next message; styled like a pending file. */
function PendingElement({ element, onRemove }: { element: ElementContext; onRemove: () => void }) {
  return (
    <div
      className="group relative flex h-14 max-w-64 items-center gap-2 rounded-xl bg-white/[0.06] shadow-soft"
      title={element.selector}
    >
      <MousePointer2 className="ml-3 size-4 shrink-0 text-muted-foreground" />
      <div className="min-w-0 pr-6">
        <div className="truncate text-xs">{element.label}</div>
        <code className="block truncate text-[11px] text-muted-foreground">{element.selector}</code>
      </div>
      <button
        type="button"
        aria-label={`Remove ${element.label}`}
        title={`Remove ${element.label}`}
        onClick={onRemove}
        className="absolute -top-1.5 -right-1.5 flex size-5 items-center justify-center rounded-full bg-secondary text-muted-foreground shadow-soft hover:text-foreground"
      >
        <X className="size-3" />
      </button>
    </div>
  )
}

/**
 * The agent's open question (`task_ask`) at the top of the box: its screenshot, the question, and its options as a
 * vertical list. Clicking an option only selects it; Send or Enter locks it in.
 */
function AskPanel({
  ask,
  chosen,
  onChoose,
}: {
  ask: Message
  chosen: number | undefined
  onChoose: (index: number) => void
}) {
  const attachments = ask.attachments ?? []
  const options = ask.options ?? []
  return (
    <div className="flex max-h-[60vh] flex-col gap-3 overflow-auto px-2 pt-2 pb-1">
      {attachments.length > 0 && <MessageAttachments taskId={ask.taskId} attachments={attachments} className="mt-0" />}
      <Markdown text={ask.text} />
      {options.length > 0 && (
        <div role="radiogroup" aria-label="Answer" className="flex flex-col gap-1.5">
          {options.map((option, i) => {
            const selected = chosen === i
            return (
              <button
                key={i}
                type="button"
                role="radio"
                aria-checked={selected}
                onClick={() => onChoose(i)}
                className={cn(
                  "flex w-full items-center gap-3 rounded-xl px-3 py-2 text-left text-sm transition-colors",
                  selected ? "bg-white/[0.12] ring-1 ring-white/30" : "bg-white/[0.04] hover:bg-white/[0.08]",
                )}
              >
                <span
                  aria-hidden
                  className={cn(
                    "flex size-5 shrink-0 items-center justify-center rounded-md text-[11px] tabular-nums",
                    selected ? "bg-foreground text-background" : "bg-white/[0.08] text-muted-foreground",
                  )}
                >
                  {selected ? <Check className="size-3.5" /> : i + 1}
                </span>
                <span className="min-w-0 break-words">{option}</span>
              </button>
            )
          })}
        </div>
      )}
    </div>
  )
}

interface Props {
  /** Resolves once the message is accepted; the text and files are cleared only then. */
  onSend: (body: SendMessageBody, files: readonly File[]) => Promise<SendMessageResponse | void>
  pending: boolean
  error: unknown
  /**
   * Stops the active turn. While set, an empty box shows a stop button; typing turns it back into send, and the
   * message joins the running turn (the model/thinking picks apply from the next turn).
   */
  onStop?: (() => void) | undefined
  stopping?: boolean
  /** The focused thread whose harness supplies slash commands. Omitted on the new-thread page, before a harness exists. */
  taskId?: string | undefined
  /** The turn the next message joins, if one is running: the server answers commands from its harness. */
  activeRunId?: string | undefined
  /** That turn's provider; authoritative over the picker, including for the `$` trigger. */
  activeRunProvider?: ModelProvider | undefined
  /** The run from `threadChoiceRun`: the pickers show its choice until a different one is picked. */
  lastRun?: Pick<Run, "model" | "effort"> | undefined
  placeholder?: string
  autoFocus?: boolean
  className?: string
  /** Names the unsent text kept in localStorage, so it survives leaving the thread and coming back. */
  draftKey: string
  /** Preview elements to send as context; owned by the thread so the preview can add to them. */
  elements?: readonly ElementContext[]
  onElementsChange?: (elements: readonly ElementContext[]) => void
  /** The thread's context use, drawn along the top of the box; absent on a new thread or before a turn reports it. */
  context?: ContextUsage | undefined
  /** The agent's open question (a `task_ask` message), shown at the top of the box. A picked option is sent as the
   * answer, followed by anything typed; with nothing picked, the typed text answers.
   */
  ask?: Message | undefined
  /** New-thread repository choice; it also names `#` references. */
  repo?: string | undefined
  /** Called when the reference menu's repository picker changes the new thread's repository. */
  onRepoChange?: (repo: string | undefined) => void
  /** Repositories an existing thread has checked out; one is unambiguous, several ask for a pick. */
  repos?: readonly string[]
}

/** Message box with file attachments, the model and thinking-level pickers, slash commands, `#` references, and a round send / stop button. */
export function Composer({
  onSend,
  pending,
  error,
  onStop,
  stopping,
  taskId,
  activeRunId,
  activeRunProvider,
  lastRun,
  placeholder,
  autoFocus,
  className,
  draftKey,
  elements = [],
  onElementsChange,
  context,
  ask,
  repo,
  onRepoChange,
  repos = [],
}: Props) {
  const [text, setText] = useStoredDraft(draftKey)
  const promptHistory = usePromptHistory(draftKey)
  const [view, setView] = useState<ComposerEditorView>(() => composerViewOf(text))
  const [files, setFiles] = useState<readonly File[]>([])
  const [fileError, setFileError] = useState<string>()
  const [dragging, setDragging] = useState(false)
  const [composerFocused, setComposerFocused] = useState(false)
  const [autocompleteDismissed, setAutocompleteDismissed] = useState(false)
  const [activeCommandIndex, setActiveCommandIndex] = useState(0)
  const [activeReferenceIndex, setActiveReferenceIndex] = useState(0)
  const [activeModelIndex, setActiveModelIndex] = useState(0)
  const [referenceMenuEngaged, setReferenceMenuEngaged] = useState(false)
  const fileInput = useRef<HTMLInputElement>(null)
  const editor = useRef<ComposerEditorHandle>(null)
  // The picked option belongs to one question; a new question starts with nothing picked.
  const [choice, setChoice] = useState<{ askId: string; index: number }>()
  const askOptions = ask?.options ?? []
  const chosenIndex = choice !== undefined && choice.askId === ask?.id ? choice.index : undefined
  const chosenOption = chosenIndex === undefined ? undefined : askOptions[chosenIndex]
  const slashMenuId = useId()
  const referenceMenuId = useId()
  const modelMenuId = useId()
  const openUsagePanel = useOpenUsagePanel()
  // The shared catalog decides what appears and matches; every app action needs its local implementation here.
  const appCommandHandlers: AppCommandHandlers = { usage: openUsagePanel }
  // A thread keeps its unsent picks to itself; the unsuffixed keys belong to the new-thread composer.
  const pickSuffix = taskId === undefined ? "" : `.${taskId}`
  const [pickedModel, setPickedModel, clearPickedModel] = useStoredChoice(`kestrel.model${pickSuffix}`, AgentModel)
  const [pickedEffort, setPickedEffort, clearPickedEffort] = useStoredChoice(`kestrel.effort${pickSuffix}`, EffortPick)
  const [defaultModel] = useStoredChoice("kestrel.model", AgentModel)
  const [defaultEffort] = useStoredChoice("kestrel.effort", EffortPick)
  const connections = useQuery(queries.connections())
  const capabilities = useQuery(queries.capabilities())
  const shown = useShownModels()
  // The reference repository picker's choice. A page-level pick (the new thread's repository) wins when set.
  const [pickedReferenceRepo, setPickedReferenceRepo] = useState<string>()
  const checkoutRepos = repos.filter((candidate) => Schema.is(GithubRepoSlug)(candidate))
  const soleCheckout = checkoutRepos.length === 1 ? checkoutRepos[0] : undefined
  const referenceRepo = pickedReferenceRepo ?? repo ?? soleCheckout
  useEffect(() => setPickedReferenceRepo(undefined), [repo])
  const connected = connections.data ? connectedModelProviders(connections.data, capabilities.data?.harnesses) : []
  const sections: readonly ModelSection[] | null = connections.data
    ? connected.map((provider) => ({ provider, models: shown[provider.id] })).filter((s) => s.models.length > 0)
    : null
  const offered = sections?.flatMap((s) => s.models) ?? []
  const { model, effort } = resolveAgentChoice({ offered, connected, pickedModel, pickedEffort, lastRun, defaultModel, defaultEffort })
  const effortOptions = (model?.efforts ?? []).map((e) => ({
    value: e,
    label: e === "none" ? "Off" : EFFORT_LABELS[e],
  }))
  const empty = text.trim() === "" && files.length === 0 && elements.length === 0 && chosenOption === undefined

  // Slash autocomplete begins with a leading trigger at the start of the message. Claude Code's trigger is `/`;
  // Codex lists its commands and skills on `/`, and only its skills on their native `$`. The menu follows the caret
  // while it stays inside the first word, then closes once an argument starts.
  const visible = view.plain
  const firstSpace = visible.search(/\s/)
  const commandTokenEnd = firstSpace === -1 ? visible.length : firstSpace
  const trigger: "/" | "$" | undefined = visible.startsWith("/") ? "/" : visible.startsWith("$") ? "$" : undefined
  const expectedProvider = activeRunProvider ?? model?.provider
  // The running turn's provider wins over the picker. An older run without a stored provider is probed once.
  const triggerAllowed =
    trigger === "/" ||
    (trigger === "$" &&
      (expectedProvider === "openai" || (activeRunId !== undefined && activeRunProvider === undefined)))
  // A new thread has no harness to ask, so only Kestrel's own `/` commands list there.
  const slashQuery =
    (taskId !== undefined || trigger === "/") &&
    trigger !== undefined &&
    triggerAllowed &&
    view.caret > 0 &&
    (firstSpace === -1 || view.caret <= firstSpace)
      ? visible.slice(1, view.caret)
      : undefined
  // Keyed by thread, model and running turn, and fetched only while a trigger token is present: a new thread never
  // asks, and another thread's or provider's cached list can never be shown here.
  const commandQuery = useQuery({
    ...queries.commands(taskId, model?.id, activeRunId, activeRunProvider),
    enabled: slashQuery !== undefined && taskId !== undefined && model !== undefined,
  })
  // The response is authoritative (an active run may use another provider than the picker); `$` only belongs to Codex.
  const commandProvider = commandQuery.data?.provider ?? expectedProvider
  const commandMatches =
    slashQuery === undefined
      ? []
      : withAppCommands(commandQuery.data?.commands ?? [], commandProvider).filter(
          (c) =>
            (trigger !== "$" || harnessCommandPrefix(c, commandProvider) === "$") &&
            c.name.toLowerCase().startsWith(slashQuery.toLowerCase()),
        )
  // On a new thread nothing but those commands can match, and any other `/text` is an ordinary first message to send.
  const slashMenuOpen =
    slashQuery !== undefined &&
    (trigger !== "$" || commandProvider === "openai") &&
    (taskId !== undefined || commandMatches.length > 0) &&
    composerFocused &&
    !autocompleteDismissed
  const selectedCommandIndex =
    commandMatches.length === 0 ? -1 : Math.min(activeCommandIndex, commandMatches.length - 1)
  const selectedCommand = selectedCommandIndex === -1 ? undefined : commandMatches[selectedCommandIndex]
  const modelTrigger = findModelMentionTrigger(view.referenceText, view.caret)
  const modelMatches = modelTrigger === undefined ? [] : filterMentionModels(offered, modelTrigger.query)
  const modelMenuOpen = modelTrigger !== undefined && !slashMenuOpen && composerFocused && !autocompleteDismissed
  const selectedModelIndex = modelMatches.length === 0 ? -1 : Math.min(activeModelIndex, modelMatches.length - 1)
  const selectedMentionModel = modelMatches[selectedModelIndex]
  // A `#123` token anywhere opens the same menu. `referenceText` masks existing chips, so their labels never reopen it.
  const referenceTrigger = findGithubReferenceTrigger(view.referenceText, view.caret)
  const referenceMenuOpen =
    referenceTrigger !== undefined &&
    !slashMenuOpen &&
    !modelMenuOpen &&
    !autocompleteDismissed &&
    (composerFocused || referenceMenuEngaged)
  const selectedReferenceIndex = Math.min(activeReferenceIndex, 1)

  // A shorter prefix or a different harness reorders what is active; start at the top again.
  useEffect(() => {
    setActiveCommandIndex(0)
  }, [slashQuery, taskId, model?.id, activeRunId, activeRunProvider])

  useEffect(() => {
    setActiveReferenceIndex(0)
  }, [referenceTrigger?.start, referenceTrigger?.number])

  useEffect(() => {
    setActiveModelIndex(0)
  }, [modelTrigger?.start, modelTrigger?.query])
  // Once the menu is gone, a picker interaction must not keep a later menu open without focus.
  useEffect(() => {
    if (!referenceMenuOpen) setReferenceMenuEngaged(false)
  }, [referenceMenuOpen])

  /** Runs an app action: only its invocation and the gap after it leave the draft, which never goes to the agent. */
  function runAppCommand(command: AppCommand, consumed: number) {
    editor.current?.replaceRange(0, consumed, "")
    appCommandHandlers[command.name]()
  }

  /** Writes the command into the leading token, keeps any argument text, and leaves the caret ready for arguments. */
  function chooseCommand(command: HarnessCommand) {
    // App actions send nothing, so picking one runs it and only its invocation and gap leave the draft.
    const app = appCommandOf(command, commandProvider)
    if (app !== undefined) {
      runAppCommand(app, matchAppCommand(visible)?.consumed ?? commandTokenEnd)
      return
    }
    // Each command carries its invocation syntax: `/name` for commands, `$name` for Codex skills.
    const prefix = harnessCommandPrefix(command, commandQuery.data?.provider)
    // Replace the token and the whitespace after it; anything typed after (including reference chips) stays.
    const gap = /^\s*/.exec(visible.slice(commandTokenEnd))?.[0].length ?? 0
    editor.current?.replaceRange(0, commandTokenEnd + gap, `${prefix}${command.name} `)
    setAutocompleteDismissed(true)
    editor.current?.focus()
  }

  function chooseMentionModel(mentionModel: ModelInfo) {
    if (modelTrigger === undefined) return
    editor.current?.insertModelMention(mentionModel, modelTrigger.start, modelTrigger.end)
    setAutocompleteDismissed(true)
    editor.current?.focus()
  }

  /** Turns the `#123` being typed into an inline chip; the following text stays exactly where it was. */
  function chooseReference(kind: GithubReferenceKind) {
    if (referenceTrigger === undefined || referenceRepo === undefined) return
    editor.current?.insertReference(
      { repo: referenceRepo, kind, number: referenceTrigger.number },
      referenceTrigger.start,
      referenceTrigger.end,
    )
    setAutocompleteDismissed(true)
    setReferenceMenuEngaged(false)
    editor.current?.focus()
  }

  function chooseReferenceRepo(next: string | undefined) {
    setPickedReferenceRepo(next)
    onRepoChange?.(next)
    // The picker took focus; return it (and the caret to the number) so the two choices stay open for Enter.
    requestAnimationFrame(() => editor.current?.focusAt(referenceTrigger?.end ?? view.caret))
  }

  /** Adds files, refusing empty ones and any over the box's limit before they are uploaded. */
  function addFiles(added: readonly File[]) {
    const refused = added.filter((f) => f.size === 0 || f.size > MAX_ATTACHMENT_BYTES)
    setFileError(
      refused.length === 0
        ? undefined
        : `Not attached (empty or over ${MAX_ATTACHMENT_BYTES / 1024 / 1024} MB): ${refused.map((f) => f.name).join(", ")}`,
    )
    const accepted = added.filter((f) => !refused.includes(f))
    if (accepted.length > 0) setFiles((current) => [...current, ...accepted])
  }

  function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault()
    // An app command typed any way never reaches the agent, so it works during a turn too; any text after it and any
    // attachments stay for the next message.
    const app = matchAppCommand(visible)
    if (app !== undefined && chosenOption === undefined) {
      runAppCommand(app.command, app.consumed)
      return
    }
    // Enter submits via requestSubmit, which ignores the disabled button, so guard here too.
    // Failures surface through `error`; the text and files stay so they can be resent.
    if (empty || pending) return
    const message = [chosenOption ?? "", text.trim(), elementsText(elements)].filter((part) => part !== "").join("\n\n")
    onSend({ text: message, model: model?.id, effort }, files).then(
      (sent) => {
        promptHistory.remember(text.trim())
        setText("")
        onElementsChange?.([])
        setFiles([])
        setFileError(undefined)
        setChoice(undefined)
        // The new run now records these picks. A message joining a running turn keeps them for the next turn.
        if (taskId !== undefined && sent !== undefined && sent.message.afterItems === undefined) {
          clearPickedModel(pickedModel)
          clearPickedEffort(pickedEffort)
        }
      },
      () => {},
    )
  }

  function onKey(e: KeyboardEvent<HTMLElement>) {
    // IME composition owns Enter/arrows; never pick a command or submit from a composition key.
    const composing = e.nativeEvent.isComposing || e.keyCode === 229
    if (!composing && slashMenuOpen) {
      if (e.key === "Escape") {
        e.preventDefault()
        setAutocompleteDismissed(true)
        return
      }
      if ((e.key === "ArrowDown" || e.key === "ArrowUp") && commandMatches.length > 0) {
        e.preventDefault()
        const current = Math.min(activeCommandIndex, commandMatches.length - 1)
        const delta = e.key === "ArrowDown" ? 1 : -1
        setActiveCommandIndex((current + delta + commandMatches.length) % commandMatches.length)
        return
      }
      // Enter always belongs to the open menu (even while loading): it selects the active command or does nothing.
      // Tab selects too, but only when there is one, so it can still move focus out of an empty menu.
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault()
        if (selectedCommand !== undefined) chooseCommand(selectedCommand)
        return
      }
      if (e.key === "Tab" && !e.shiftKey && selectedCommand !== undefined) {
        e.preventDefault()
        chooseCommand(selectedCommand)
        return
      }
    }
    if (!composing && modelMenuOpen) {
      if (e.key === "Escape") {
        e.preventDefault()
        setAutocompleteDismissed(true)
        return
      }
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault()
        if (modelMatches.length > 0) {
          const delta = e.key === "ArrowDown" ? 1 : -1
          setActiveModelIndex((Math.max(0, selectedModelIndex) + delta + modelMatches.length) % modelMatches.length)
        }
        return
      }
      if (e.key === "Enter" && !e.shiftKey && selectedMentionModel !== undefined) {
        e.preventDefault()
        chooseMentionModel(selectedMentionModel)
        return
      }
      if (e.key === "Tab" && !e.shiftKey && selectedMentionModel !== undefined) {
        e.preventDefault()
        chooseMentionModel(selectedMentionModel)
        return
      }
    }
    if (!composing && referenceMenuOpen) {
      if (e.key === "Escape") {
        e.preventDefault()
        setAutocompleteDismissed(true)
        setReferenceMenuEngaged(false)
        return
      }
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault()
        const delta = e.key === "ArrowDown" ? 1 : -1
        setActiveReferenceIndex((selectedReferenceIndex + delta + 2) % 2)
        return
      }
      // Enter picks the highlighted kind; without a repository there is nothing to insert yet.
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault()
        chooseReference(selectedReferenceIndex === 0 ? "pr" : "issue")
        return
      }
      if (e.key === "Tab" && !e.shiftKey && referenceRepo !== undefined) {
        e.preventDefault()
        chooseReference(selectedReferenceIndex === 0 ? "pr" : "issue")
        return
      }
    }
    // With an empty box, the arrow keys move through the question's options.
    if (!composing && ask && askOptions.length > 0 && text === "" && (e.key === "ArrowDown" || e.key === "ArrowUp")) {
      e.preventDefault()
      const delta = e.key === "ArrowDown" ? 1 : -1
      const start = chosenIndex ?? (delta === 1 ? -1 : askOptions.length)
      setChoice({ askId: ask.id, index: (start + delta + askOptions.length) % askOptions.length })
      return
    }
    if (
      !composing && !slashMenuOpen && !referenceMenuOpen && !modelMenuOpen && !ask &&
      !e.shiftKey && !e.ctrlKey && !e.altKey && !e.metaKey &&
      (e.key === "ArrowUp" || e.key === "ArrowDown")
    ) {
      const current = editor.current?.readView()
      const selection = window.getSelection()
      // An unchanged recall keeps browsing at the end, even when it spans visual lines.
      // Ordinary drafts keep native Up movement; Range geometry also detects soft wrapping.
      const continuingHistory = current !== undefined &&
        promptHistory.isBrowsing(current.markdown) && current.caret === current.plain.length
      let atHistoryBoundary = continuingHistory || (current !== undefined &&
        (e.key === "ArrowUp" ? current.caret === 0 : current.caret === current.plain.length))
      if (current && !continuingHistory && !current.plain.includes("\n") && e.key === "ArrowUp" &&
        current.caret === current.plain.length && selection?.isCollapsed) {
        const range = document.createRange()
        range.selectNodeContents(e.currentTarget)
        const rects = range.getClientRects()
        const first = rects[0]
        atHistoryBoundary = first === undefined
        if (first !== undefined) {
          atHistoryBoundary = true
          for (const rect of rects) {
            if (rect.height > 0 && (rect.top >= first.bottom || rect.bottom <= first.top)) {
              atHistoryBoundary = false
              break
            }
          }
        }
      }
      if (current && selection?.isCollapsed && atHistoryBoundary) {
        const recalled = promptHistory.navigate(e.key === "ArrowUp" ? -1 : 1, current.markdown)
        if (recalled !== undefined) {
          e.preventDefault()
          setAutocompleteDismissed(true)
          setText(recalled)
        }
      }
    }
    if (e.key === "Enter" && !e.shiftKey && !composing) {
      e.preventDefault()
      e.currentTarget.closest("form")?.requestSubmit()
    }
  }

  /** Pasted files (e.g. a screenshot) are attached; pasted text goes into the box as usual. */
  function onPaste(e: ClipboardEvent<HTMLDivElement>) {
    const pasted = Array.from(e.clipboardData.files)
    if (pasted.length === 0) return
    e.preventDefault()
    addFiles(pasted)
  }

  function onDragOver(e: DragEvent<HTMLFormElement>) {
    if (!e.dataTransfer.types.includes("Files")) return
    e.preventDefault()
    setDragging(true)
  }

  function onDrop(e: DragEvent<HTMLFormElement>) {
    setDragging(false)
    if (e.dataTransfer.files.length === 0) return
    e.preventDefault()
    addFiles(Array.from(e.dataTransfer.files))
  }

  const activeListboxId = slashMenuOpen
    ? selectedCommand !== undefined
      ? slashListboxId(slashMenuId)
      : undefined
    : referenceMenuOpen
      ? slashListboxId(referenceMenuId)
      : modelMenuOpen
        ? slashListboxId(modelMenuId)
        : undefined
  const activeOptionId =
    slashMenuOpen && selectedCommand !== undefined
      ? slashOptionId(slashMenuId, selectedCommandIndex)
      : referenceMenuOpen
        ? slashOptionId(referenceMenuId, selectedReferenceIndex)
        : modelMenuOpen && selectedMentionModel !== undefined
          ? slashOptionId(modelMenuId, selectedModelIndex)
          : undefined

  return (
    <div className={cn("w-full max-w-3xl", className)}>
      {Boolean(error) && <Alert className="mb-2">{errorText(error)}</Alert>}
      {fileError && <Alert className="mb-2">{fileError}</Alert>}
      <form
        className={cn(
          "relative flex flex-col gap-1 rounded-2xl bg-secondary p-2 shadow-soft transition-shadow duration-200 focus-within:shadow-glow",
          dragging && "shadow-glow ring-1 ring-white/20",
        )}
        onSubmit={submit}
        onDragOver={onDragOver}
        onDragLeave={(e) => {
          if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDragging(false)
        }}
        onDrop={onDrop}
      >
        {context && <ContextBar context={context} />}
        {ask && (
          <AskPanel
            ask={ask}
            chosen={chosenIndex}
            onChoose={(index) => {
              setChoice({ askId: ask.id, index })
              // Back to the box, so Enter sends the pick.
              editor.current?.focus()
            }}
          />
        )}
        {(files.length > 0 || elements.length > 0) && (
          <div className="flex flex-wrap gap-2 px-1.5 pt-1.5">
            {elements.map((element, i) => (
              <PendingElement
                key={`${i}:${element.selector}`}
                element={element}
                onRemove={() => onElementsChange?.(elements.filter((e) => e !== element))}
              />
            ))}
            {files.map((file, i) => (
              <PendingFile
                key={`${i}:${file.name}:${file.size}:${file.lastModified}`}
                file={file}
                onRemove={() => setFiles((current) => current.filter((f) => f !== file))}
              />
            ))}
          </div>
        )}
        <div className="relative">
          <ComposerEditor
            ref={editor}
            value={text}
            placeholder={
              placeholder ??
              (ask
                ? askOptions.length > 0
                  ? "Pick an answer and press Enter, or type your own"
                  : "Type your answer (Enter to send)"
                : "Message the agent (Enter to send, Shift+Enter for newline)")
            }
            autoFocus={autoFocus}
            className="max-h-56 min-h-12 bg-transparent shadow-none focus-visible:bg-transparent focus-visible:shadow-none"
            modelLogos={MODEL_LOGOS}
            ariaExpanded={slashMenuOpen || referenceMenuOpen || modelMenuOpen}
            ariaControls={activeListboxId}
            ariaActiveDescendant={activeOptionId}
            onChange={(next) => {
              setView(next)
              if (next.markdown !== text) {
                setText(next.markdown)
                setAutocompleteDismissed(false)
              }
            }}
            onFocus={() => {
              setComposerFocused(true)
              setAutocompleteDismissed(false)
              setReferenceMenuEngaged(false)
            }}
            onBlur={() => setComposerFocused(false)}
            onKeyDown={onKey}
            onPaste={onPaste}
          />
          {slashMenuOpen && (
            <SlashCommands
              id={slashMenuId}
              query={slashQuery ?? ""}
              trigger={trigger ?? "/"}
              provider={commandQuery.data?.provider ?? expectedProvider}
              matches={commandMatches}
              chosenModel={taskId === undefined || model !== undefined}
              pending={taskId !== undefined && commandQuery.isPending}
              error={commandQuery.error}
              activeIndex={selectedCommandIndex}
              onActiveIndexChange={setActiveCommandIndex}
              onSelect={chooseCommand}
            />
          )}
          {modelMenuOpen && modelTrigger !== undefined && (
            <ModelMentions
              id={modelMenuId}
              matches={modelMatches}
              query={modelTrigger.query}
              pending={connections.isPending}
              failed={connections.isError}
              activeIndex={selectedModelIndex}
              onActiveIndexChange={setActiveModelIndex}
              onSelect={chooseMentionModel}
            />
          )}
          {referenceMenuOpen && referenceTrigger !== undefined && (
            <div onPointerDownCapture={() => setReferenceMenuEngaged(true)}>
              <GithubReferenceMenu
                id={referenceMenuId}
                number={referenceTrigger.number}
                repo={referenceRepo}
                onRepoChange={chooseReferenceRepo}
                activeIndex={selectedReferenceIndex}
                onActiveIndexChange={setActiveReferenceIndex}
                onSelect={chooseReference}
              />
            </div>
          )}
        </div>
        <input
          ref={fileInput}
          type="file"
          multiple
          hidden
          onChange={(e) => {
            addFiles(Array.from(e.target.files ?? []))
            // Lets the same file be picked again after it was removed.
            e.target.value = ""
          }}
        />
        <div className="flex items-center gap-1">
          <Button
            type="button"
            variant="ghost"
            size="icon"
            aria-label="Attach files"
            title="Attach files"
            onClick={() => fileInput.current?.click()}
          >
            <Paperclip />
          </Button>
          <ModelPicker sections={sections} value={model} onChange={setPickedModel} />
          {model !== undefined && model.efforts.length > 0 && (
            <ThinkingPicker value={effort} options={effortOptions} onChange={setPickedEffort} />
          )}
          {onStop && empty ? (
            <Button
              type="button"
              size="icon"
              className="ml-auto"
              aria-label="Stop"
              title="Stop"
              disabled={stopping}
              onClick={onStop}
            >
              <Square className="size-3.5 fill-current" />
            </Button>
          ) : (
            <Button
              type="submit"
              size="icon"
              className="ml-auto"
              aria-label="Send"
              title="Send"
              disabled={pending || empty}
            >
              <ArrowUp />
            </Button>
          )}
        </div>
      </form>
    </div>
  )
}
