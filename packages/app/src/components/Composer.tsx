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
import {
  AgentEffort,
  AgentModel,
  EFFORT_LABELS,
  MAX_ATTACHMENT_BYTES,
  connectedModelProviders,
  harnessCommandPrefix,
  type ContextUsage,
  type HarnessCommand,
  type Message,
  type ModelInfo,
  type ModelProvider,
  type ModelProviderInfo,
  type SendMessageBody,
} from "@cloudagents/protocol"
import { queries } from "@/api/queries"
import { Alert } from "@/components/ui/alert"
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
import { SlashCommands, slashListboxId, slashOptionId } from "@/components/SlashCommands"
import { Textarea } from "@/components/ui/textarea"
import { useShownModels } from "@/hooks/useShownModels"
import { cn } from "@/lib/utils"
import { errorText } from "@/util"
import { ContextBar } from "./ContextBar"
import { Markdown } from "./Markdown"
import { MessageAttachments } from "./MessageAttachments"

/** A connected provider and the models the user keeps in the picker for it. */
interface ModelSection {
  readonly provider: ModelProviderInfo
  readonly models: readonly ModelInfo[]
}

/** One pick, remembered in localStorage so it survives switching threads and reloads. */
function useStoredChoice<A extends string>(key: string, schema: Schema.Schema<A>) {
  const [value, setValue] = useState<A | undefined>(() => {
    const stored = localStorage.getItem(key)
    return stored !== null && Schema.is(schema)(stored) ? stored : undefined
  })
  useEffect(() => {
    if (value === undefined) localStorage.removeItem(key)
    else localStorage.setItem(key, value)
  }, [key, value])
  return [value, setValue] as const
}

/** A pill that opens a single-choice menu; shows its label until something other than Default is picked. */
function PillPicker<T extends string>({
  label,
  value,
  options,
  onChange,
}: {
  label: string
  value: T | undefined
  options: readonly { value: T | undefined; label: string }[]
  onChange: (value: T | undefined) => void
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button type="button" variant="ghost" size="sm" className="data-[state=open]:bg-white/[0.06]">
          {value === undefined ? label : options.find((o) => o.value === value)?.label}
          <ChevronDown className="opacity-60" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" side="top">
        <DropdownMenuLabel>{label}</DropdownMenuLabel>
        <DropdownMenuRadioGroup
          value={value ?? ""}
          onValueChange={(v) => onChange(options.find((o) => (o.value ?? "") === v)?.value)}
        >
          {options.map((o) => (
            <DropdownMenuRadioItem key={o.label} value={o.value ?? ""}>
              {o.label}
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

/**
 * Model menu: one group per connected provider, divided, with the models the user keeps for it (Connections).
 * `sections` is null while connections load.
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
  const label = value?.name ?? (sections === null ? "Model" : "No models")
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button type="button" variant="ghost" size="sm" className="data-[state=open]:bg-white/[0.06]">
          {label}
          <ChevronDown className="opacity-60" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="start"
        side="top"
        className="max-h-(--radix-dropdown-menu-content-available-height) min-w-56 overflow-y-auto"
      >
        {sections !== null && sections.length === 0 && (
          <DropdownMenuLabel>Connect Anthropic or OpenAI to choose a model.</DropdownMenuLabel>
        )}
        <DropdownMenuRadioGroup
          value={value?.id ?? ""}
          onValueChange={(v) => {
            if (Schema.is(AgentModel)(v)) onChange(v)
          }}
        >
          {sections?.map((section, i) => (
            <Fragment key={section.provider.id}>
              {i > 0 && <DropdownMenuSeparator />}
              <DropdownMenuLabel>{section.provider.name}</DropdownMenuLabel>
              {section.models.map((m) => (
                <DropdownMenuRadioItem key={m.id} value={m.id}>
                  {m.name}
                </DropdownMenuRadioItem>
              ))}
            </Fragment>
          ))}
        </DropdownMenuRadioGroup>
        <DropdownMenuSeparator />
        <DropdownMenuItem asChild>
          <Link to="/settings/connections" className="text-muted-foreground">
            <Settings2 />
            Manage models
          </Link>
        </DropdownMenuItem>
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
  onSend: (body: SendMessageBody, files: readonly File[]) => Promise<unknown>
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
  placeholder?: string
  autoFocus?: boolean
  className?: string
  /** Preview elements to send as context; owned by the thread so the preview can add to them. */
  elements?: readonly ElementContext[]
  onElementsChange?: (elements: readonly ElementContext[]) => void
  /** The thread's context use, drawn along the top of the box; absent on a new thread or before a turn reports it. */
  context?: ContextUsage | undefined
  /**
   * The agent's open question (a `task_ask` message), shown at the top of the box. A picked option is sent as the
   * answer, followed by anything typed; with nothing picked, the typed text answers.
   */
  ask?: Message | undefined
}

/** Message box with file attachments, the model and thinking-level pickers, slash commands, and a round send / stop button. */
export function Composer({
  onSend,
  pending,
  error,
  onStop,
  stopping,
  taskId,
  activeRunId,
  activeRunProvider,
  placeholder,
  autoFocus,
  className,
  elements = [],
  onElementsChange,
  context,
  ask,
}: Props) {
  const [text, setText] = useState("")
  const [caret, setCaret] = useState(0)
  const [files, setFiles] = useState<readonly File[]>([])
  const [fileError, setFileError] = useState<string>()
  const [dragging, setDragging] = useState(false)
  const [composerFocused, setComposerFocused] = useState(false)
  const [slashDismissed, setSlashDismissed] = useState(false)
  const [activeCommandIndex, setActiveCommandIndex] = useState(0)
  const fileInput = useRef<HTMLInputElement>(null)
  const textarea = useRef<HTMLTextAreaElement>(null)
  // The picked option belongs to one question; a new question starts with nothing picked.
  const [choice, setChoice] = useState<{ askId: string; index: number }>()
  const askOptions = ask?.options ?? []
  const chosenIndex = choice !== undefined && choice.askId === ask?.id ? choice.index : undefined
  const chosenOption = chosenIndex === undefined ? undefined : askOptions[chosenIndex]
  const slashMenuId = useId()
  const [storedModel, setModel] = useStoredChoice("kestrel.model", AgentModel)
  const [storedEffort, setEffort] = useStoredChoice("kestrel.effort", AgentEffort)
  const connections = useQuery(queries.connections())
  const shown = useShownModels()
  const sections: readonly ModelSection[] | null = connections.data
    ? connectedModelProviders(connections.data)
        .map((provider) => ({ provider, models: shown[provider.id] }))
        .filter((s) => s.models.length > 0)
    : null
  // The stored pick counts only while it is on offer; otherwise the first model on offer stands in, unsaved.
  const offered = sections?.flatMap((s) => s.models) ?? []
  const model = offered.find((m) => m.id === storedModel) ?? offered[0]
  const effort = storedEffort !== undefined && model?.efforts.includes(storedEffort) ? storedEffort : undefined
  const effortOptions: readonly { value: AgentEffort | undefined; label: string }[] = [
    { value: undefined, label: "Default" },
    ...(model?.efforts ?? []).map((e) => ({ value: e, label: EFFORT_LABELS[e] })),
  ]
  const empty = text.trim() === "" && files.length === 0 && elements.length === 0 && chosenOption === undefined

  // Slash autocomplete begins with a leading trigger at the start of the message. Claude Code's trigger is `/`;
  // Codex lists its commands and skills on `/`, and only its skills on their native `$`. The menu follows the caret
  // while it stays inside the first word, then closes once an argument starts.
  const firstSpace = text.search(/\s/)
  const commandTokenEnd = firstSpace === -1 ? text.length : firstSpace
  const trigger: "/" | "$" | undefined = text.startsWith("/") ? "/" : text.startsWith("$") ? "$" : undefined
  const expectedProvider = activeRunProvider ?? model?.provider
  // The running turn's provider wins over the picker. An older run without a stored provider is probed once.
  const triggerAllowed =
    trigger === "/" ||
    (trigger === "$" &&
      (expectedProvider === "openai" || (activeRunId !== undefined && activeRunProvider === undefined)))
  const slashQuery =
    taskId !== undefined &&
    trigger !== undefined &&
    triggerAllowed &&
    caret > 0 &&
    (firstSpace === -1 || caret <= firstSpace)
      ? text.slice(1, caret)
      : undefined
  // Keyed by thread, model and running turn, and fetched only while a trigger token is present: a new thread never
  // asks, and another thread's or provider's cached list can never be shown here.
  const commandQuery = useQuery({
    ...queries.commands(taskId, model?.id, activeRunId, activeRunProvider),
    enabled: slashQuery !== undefined && taskId !== undefined && model !== undefined,
  })
  // The response is authoritative (an active run may use another provider than the picker); `$` only belongs to Codex.
  const commandProvider = commandQuery.data?.provider ?? expectedProvider
  const slashMenuOpen =
    slashQuery !== undefined &&
    (trigger !== "$" || commandProvider === "openai") &&
    composerFocused &&
    !slashDismissed
  const commandMatches =
    slashQuery === undefined
      ? []
      : (commandQuery.data?.commands ?? []).filter(
          (c) =>
            (trigger !== "$" || harnessCommandPrefix(c, commandProvider) === "$") &&
            c.name.toLowerCase().startsWith(slashQuery.toLowerCase()),
        )
  const selectedCommandIndex =
    commandMatches.length === 0 ? -1 : Math.min(activeCommandIndex, commandMatches.length - 1)
  const selectedCommand = selectedCommandIndex === -1 ? undefined : commandMatches[selectedCommandIndex]

  // A shorter prefix or a different harness reorders what is active; start at the top again.
  useEffect(() => {
    setActiveCommandIndex(0)
  }, [slashQuery, taskId, model?.id, activeRunId, activeRunProvider])

  /** Writes the command into the leading token, keeps any argument text, and leaves the caret ready for arguments. */
  function chooseCommand(command: HarnessCommand) {
    // Each command carries its invocation syntax: `/name` for commands, `$name` for Codex skills.
    const prefix = harnessCommandPrefix(command, commandQuery.data?.provider)
    const rest = text.slice(commandTokenEnd).replace(/^\s+/, "")
    const nextText = `${prefix}${command.name} ` + rest
    const nextCaret = prefix.length + command.name.length + 1
    setText(nextText)
    setCaret(nextCaret)
    setSlashDismissed(true)
    // Wait for React to write the new value before moving the caret into it.
    requestAnimationFrame(() => {
      const el = textarea.current
      if (el === null) return
      el.focus()
      el.setSelectionRange(nextCaret, nextCaret)
    })
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
    // Enter submits via requestSubmit, which ignores the disabled button, so guard here too.
    // Failures surface through `error`; the text and files stay so they can be resent.
    if (empty || pending) return
    const message = [chosenOption ?? "", text.trim(), elementsText(elements)].filter((part) => part !== "").join("\n\n")
    onSend({ text: message, model: model?.id, effort }, files).then(
      () => {
        setText("")
        onElementsChange?.([])
        setFiles([])
        setFileError(undefined)
        setChoice(undefined)
      },
      () => {},
    )
  }

  function onKey(e: KeyboardEvent<HTMLTextAreaElement>) {
    // IME composition owns Enter/arrows; never pick a command or submit from a composition key.
    const composing = e.nativeEvent.isComposing || e.keyCode === 229
    if (!composing && slashMenuOpen) {
      if (e.key === "Escape") {
        e.preventDefault()
        setSlashDismissed(true)
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
    // With an empty box, the arrow keys move through the question's options.
    if (!composing && ask && askOptions.length > 0 && text === "" && (e.key === "ArrowDown" || e.key === "ArrowUp")) {
      e.preventDefault()
      const delta = e.key === "ArrowDown" ? 1 : -1
      const start = chosenIndex ?? (delta === 1 ? -1 : askOptions.length)
      setChoice({ askId: ask.id, index: (start + delta + askOptions.length) % askOptions.length })
      return
    }
    if (e.key === "Enter" && !e.shiftKey && !composing) {
      e.preventDefault()
      e.currentTarget.form?.requestSubmit()
    }
  }

  /** Pasted files (e.g. a screenshot) are attached; pasted text goes into the box as usual. */
  function onPaste(e: ClipboardEvent<HTMLTextAreaElement>) {
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
              textarea.current?.focus()
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
          <Textarea
            ref={textarea}
            className="min-h-12 resize-none bg-transparent shadow-none focus-visible:bg-transparent focus-visible:shadow-none"
            value={text}
            placeholder={
              placeholder ??
              (ask
                ? askOptions.length > 0
                  ? "Pick an answer and press Enter, or type your own"
                  : "Type your answer (Enter to send)"
                : "Message the agent (Enter to send, Shift+Enter for newline)")
            }
            rows={2}
            autoFocus={autoFocus}
            role="combobox"
            aria-autocomplete="list"
            aria-haspopup="listbox"
            aria-expanded={slashMenuOpen}
            aria-controls={
              slashMenuOpen && selectedCommand !== undefined ? slashListboxId(slashMenuId) : undefined
            }
            aria-activedescendant={
              slashMenuOpen && selectedCommand !== undefined
                ? slashOptionId(slashMenuId, selectedCommandIndex)
                : undefined
            }
            onChange={(e) => {
              setText(e.target.value)
              setCaret(e.target.selectionStart)
              setSlashDismissed(false)
            }}
            onSelect={(e) => setCaret(e.currentTarget.selectionStart)}
            onFocus={() => {
              setComposerFocused(true)
              setSlashDismissed(false)
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
              chosenModel={model !== undefined}
              pending={commandQuery.isPending}
              error={commandQuery.error}
              activeIndex={selectedCommandIndex}
              onActiveIndexChange={setActiveCommandIndex}
              onSelect={chooseCommand}
            />
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
          <ModelPicker sections={sections} value={model} onChange={setModel} />
          {model !== undefined && model.efforts.length > 0 && (
            <PillPicker label="Thinking" value={effort} options={effortOptions} onChange={setEffort} />
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
