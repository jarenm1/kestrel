import {
  Fragment,
  useEffect,
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
import { ArrowUp, ChevronDown, FileText, Paperclip, Settings2, Square, X } from "lucide-react"
import {
  AgentEffort,
  AgentModel,
  EFFORT_LABELS,
  MAX_ATTACHMENT_BYTES,
  connectedModelProviders,
  type ModelInfo,
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
import { Textarea } from "@/components/ui/textarea"
import { useShownModels } from "@/hooks/useShownModels"
import { cn } from "@/lib/utils"
import { errorText } from "@/util"

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
          <Link to="/connections" className="text-muted-foreground">
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
  placeholder?: string
  autoFocus?: boolean
  className?: string
}

/** Message box with file attachments, the model and thinking-level pickers, and a round send / stop button. */
export function Composer({ onSend, pending, error, onStop, stopping, placeholder, autoFocus, className }: Props) {
  const [text, setText] = useState("")
  const [files, setFiles] = useState<readonly File[]>([])
  const [fileError, setFileError] = useState<string>()
  const [dragging, setDragging] = useState(false)
  const fileInput = useRef<HTMLInputElement>(null)
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
  const empty = text.trim() === "" && files.length === 0

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
    onSend({ text: text.trim(), model: model?.id, effort }, files).then(
      () => {
        setText("")
        setFiles([])
        setFileError(undefined)
      },
      () => {},
    )
  }

  function onKey(e: KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
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
          "flex flex-col gap-1 rounded-2xl bg-secondary p-2 shadow-soft transition-shadow duration-200 focus-within:shadow-glow",
          dragging && "shadow-glow ring-1 ring-white/20",
        )}
        onSubmit={submit}
        onDragOver={onDragOver}
        onDragLeave={(e) => {
          if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDragging(false)
        }}
        onDrop={onDrop}
      >
        {files.length > 0 && (
          <div className="flex flex-wrap gap-2 px-1.5 pt-1.5">
            {files.map((file, i) => (
              <PendingFile
                key={`${i}:${file.name}:${file.size}:${file.lastModified}`}
                file={file}
                onRemove={() => setFiles((current) => current.filter((f) => f !== file))}
              />
            ))}
          </div>
        )}
        <Textarea
          className="min-h-12 resize-none bg-transparent shadow-none focus-visible:bg-transparent focus-visible:shadow-none"
          value={text}
          placeholder={placeholder ?? "Message the agent (Enter to send, Shift+Enter for newline)"}
          rows={2}
          autoFocus={autoFocus}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={onKey}
          onPaste={onPaste}
        />
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
