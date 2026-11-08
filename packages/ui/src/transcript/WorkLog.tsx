import { useLayoutEffect, useRef, type ReactNode } from "react"
import {
  outputText,
  Paths,
  type Attachment,
  type EditLine,
  type ToolIcon,
  type ToolItem,
  type ToolKind,
  type ToolView,
} from "@cloudagents/protocol"
import Bot from "lucide-react/icons/bot"
import Brain from "lucide-react/icons/brain"
import Camera from "lucide-react/icons/camera"
import CheckSquare from "lucide-react/icons/check-square"
import ChevronRight from "lucide-react/icons/chevron-right"
import FilePen from "lucide-react/icons/file-pen"
import FileText from "lucide-react/icons/file-text"
import GitBranch from "lucide-react/icons/git-branch"
import Globe from "lucide-react/icons/globe"
import Image from "lucide-react/icons/image"
import Keyboard from "lucide-react/icons/keyboard"
import ListTodo from "lucide-react/icons/list-todo"
import Loader from "lucide-react/icons/loader"
import MessageSquare from "lucide-react/icons/message-square"
import Monitor from "lucide-react/icons/monitor"
import MousePointerClick from "lucide-react/icons/mouse-pointer-click"
import Search from "lucide-react/icons/search"
import Square from "lucide-react/icons/square"
import SquareTerminal from "lucide-react/icons/square-terminal"
import Wrench from "lucide-react/icons/wrench"
import X from "lucide-react/icons/x"
import type { LucideIcon } from "lucide-react"
import { cn } from "../cn"
import { useTranscriptHost } from "./host"
import { useAutoOpen } from "./useAutoOpen"

const SHIMMER_CLASS =
  "motion-safe:animate-title-shimmer motion-safe:bg-[linear-gradient(90deg,var(--color-muted-foreground)_40%,var(--color-foreground)_50%,var(--color-muted-foreground)_60%)] motion-safe:bg-[length:250%_100%] motion-safe:bg-clip-text motion-safe:text-transparent"

const PRE_CLASS = "m-0 max-h-72 overflow-auto rounded-lg bg-code px-3 py-2 font-mono text-[11px] break-all whitespace-pre-wrap shadow-well"

/** A row's header: icon, one-line label, trailing marks, and a chevron that shows on hover and while open. */
const ROW_CLASS =
  "group/row flex w-full min-w-0 cursor-pointer items-center gap-2 rounded-md py-0.5 text-left text-sm text-muted-foreground select-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/70 focus-visible:outline-none"

/** Details hang off the row's icon column. */
const DETAILS_CLASS = "mt-1 mb-1.5 ml-[7px] flex min-w-0 flex-col gap-2 border-l-2 border-border pl-3"

/** How close to the bottom (px) still counts as following the stream. */
const LIVE_EDGE_PX = 16

const KIND_ICONS: Record<ToolKind, LucideIcon> = {
  command: SquareTerminal,
  read: FileText,
  edit: FilePen,
  search: Search,
  web: Globe,
  desktop: Monitor,
  agent: Bot,
  plan: ListTodo,
  other: Wrench,
}

const EXTRA_ICONS: Record<ToolIcon, LucideIcon> = {
  camera: Camera,
  pointer: MousePointerClick,
  keyboard: Keyboard,
  git: GitBranch,
  message: MessageSquare,
}

function Chevron({ open }: { open: boolean }) {
  return (
    <ChevronRight
      className={cn(
        "size-3.5 shrink-0 opacity-0 transition group-hover/row:opacity-100 group-focus-visible/row:opacity-100",
        open && "rotate-90 opacity-100",
      )}
    />
  )
}

/**
 * Open while the model is thinking (the item is its stream's newest and the run is going), then folds to a
 * "Thought" line once anything follows it.
 */
export function ThinkingBlock({ text, live }: { text: string; live: boolean }) {
  const [open, toggle] = useAutoOpen(live)
  const scrollerRef = useRef<HTMLDivElement>(null)
  const atLiveEdgeRef = useRef(true)

  // Follows the streaming text, unless the user scrolled up to read.
  useLayoutEffect(() => {
    const el = scrollerRef.current
    if (live && atLiveEdgeRef.current && el) el.scrollTop = el.scrollHeight
  }, [live, open, text])

  return (
    <div>
      <button type="button" aria-expanded={open} onClick={toggle} className={ROW_CLASS}>
        <Brain className="size-4 shrink-0" />
        <span className={cn(live && SHIMMER_CLASS)}>{live ? "Thinking" : "Thought"}</span>
        <Chevron open={open} />
      </button>
      {open && (
        <div
          ref={scrollerRef}
          onScroll={(event) => {
            const { scrollHeight, scrollTop, clientHeight } = event.currentTarget
            atLiveEdgeRef.current = scrollHeight - scrollTop - clientHeight <= LIVE_EDGE_PX
          }}
          className={cn(DETAILS_CLASS, "max-h-60 overflow-auto text-sm break-words whitespace-pre-wrap text-muted-foreground italic")}
        >
          {text}
        </div>
      )}
    </div>
  )
}

const DIFF_LINE: Record<EditLine["kind"], { row: string; marker: string }> = {
  add: { row: "bg-success/10", marker: "+" },
  del: { row: "bg-destructive/10", marker: "-" },
  context: { row: "", marker: " " },
}

function EditDiff({ lines }: { lines: readonly EditLine[] }) {
  return (
    <div className="max-h-72 overflow-auto rounded-lg bg-code py-1.5 font-mono text-[11px] shadow-well">
      {lines.map((line, index) => (
        <div key={index} className={cn("flex px-3 whitespace-pre-wrap break-all", DIFF_LINE[line.kind].row)}>
          <span
            className={cn(
              "w-4 shrink-0 select-none",
              line.kind === "add" ? "text-success" : line.kind === "del" ? "text-destructive" : "text-muted-foreground/50",
            )}
          >
            {DIFF_LINE[line.kind].marker}
          </span>
          <span className="text-foreground/90">{line.text}</span>
        </div>
      ))}
    </div>
  )
}

const CHANGE_CLASS: Record<string, string> = { add: "text-success", delete: "text-destructive" }

/** Where a run's files are served from: the thread (its box) and the run. */
export interface RunSource {
  readonly taskId: string
  readonly runId: string
}

/** An image a tool call returned, at transcript size; a click opens it whole (how is up to the host). */
function RunImage({ source, image }: { source: RunSource; image: Attachment }) {
  const file = useTranscriptHost().useFileLink(source.taskId, Paths.taskRunImage(source.taskId, source.runId, image.id))
  if (file.url === undefined) return null
  return (
    <a href={file.url} target="_blank" rel="noreferrer" onClick={file.onOpen} className="w-fit">
      <img
        src={file.url}
        alt="Tool screenshot"
        loading="lazy"
        onError={file.onError}
        className="max-h-72 rounded-lg shadow-soft"
      />
    </a>
  )
}

function ToolDetails({ item, view, source, nested }: { item: ToolItem; view: ToolView; source: RunSource; nested: ReactNode }) {
  const output = outputText(item.output, view.kind)
  const hasInput = typeof item.input === "object" && item.input !== null && Object.keys(item.input).length > 0
  // An unrecognized call shows its input as is; a recognized one summarizes it, so the whole input sits one click away.
  const inlineInput = view.kind === "other" && view.note === undefined && hasInput
  return (
    <>
      {view.command !== undefined && (
        <pre className={PRE_CLASS} title={view.rawCommand}>
          <span className="text-muted-foreground select-none">$ </span>
          {view.command}
        </pre>
      )}
      {view.note !== undefined && (
        <div className="max-h-60 overflow-auto text-sm break-words whitespace-pre-wrap text-muted-foreground">{view.note}</div>
      )}
      {view.diff !== undefined && view.diff.length > 0 && <EditDiff lines={view.diff} />}
      {view.changes !== undefined && (
        <ul className="flex flex-col gap-0.5 font-mono text-[11px]">
          {view.changes.map((change) => (
            <li key={`${change.kind}:${change.path}`} className="flex gap-2">
              <span className={cn("w-12 shrink-0", CHANGE_CLASS[change.kind] ?? "text-warning")}>{change.kind}</span>
              <span className="break-all text-foreground/90">{change.path}</span>
            </li>
          ))}
        </ul>
      )}
      {view.todos !== undefined && (
        <ul className="flex flex-col gap-1 text-sm">
          {view.todos.map((todo, index) => {
            const Icon = todo.status === "completed" ? CheckSquare : todo.status === "in_progress" ? Loader : Square
            return (
              <li key={index} className={cn("flex items-start gap-2", todo.status === "completed" && "text-muted-foreground line-through")}>
                <Icon className="mt-0.5 size-3.5 shrink-0" />
                {todo.text}
              </li>
            )
          })}
        </ul>
      )}
      {inlineInput && <pre className={PRE_CLASS}>{JSON.stringify(item.input, null, 2)}</pre>}
      {/* A diff stands in for an edit's success message, but never for the error saying why it failed. */}
      {output.text !== "" && (view.diff === undefined || item.status === "error") && (
        <pre className={cn(PRE_CLASS, item.status === "error" && "text-destructive")}>{output.text}</pre>
      )}
      {item.images?.map((image) => <RunImage key={image.id} source={source} image={image} />)}
      {/* Placeholders for images the box did not keep: runs from before it kept them, or a type it cannot serve. */}
      {output.images > 0 && (
        <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
          <Image className="size-3.5" />
          {output.images === 1 ? "Returned a screenshot" : `Returned ${output.images} screenshots`} (not kept)
        </div>
      )}
      {nested}
      {hasInput && !inlineInput ? (
        <details className="group/input min-w-0">
          <summary className="w-fit cursor-pointer font-mono text-[10px] break-all text-muted-foreground/60 select-none hover:text-muted-foreground">
            {item.name} · <span className="group-open/input:hidden">full input</span>
            <span className="hidden group-open/input:inline">hide input</span>
          </summary>
          <pre className={cn(PRE_CLASS, "mt-1")}>{JSON.stringify(item.input, null, 2)}</pre>
        </details>
      ) : (
        <div className="font-mono text-[10px] break-all text-muted-foreground/60">{item.name}</div>
      )}
    </>
  )
}

/**
 * One tool call as a single line (what it did, to what), with its input, diff and output behind a click. A subagent
 * stays open while it runs, so its own calls show as they happen.
 */
export function ToolRow({ item, view, source, running, nested }: {
  item: ToolItem
  view: ToolView
  source: RunSource
  running: boolean
  nested?: ReactNode
}) {
  const live = running && item.status === "running"
  const [open, toggle] = useAutoOpen(view.kind === "agent" && live)
  const Icon = view.icon !== undefined ? EXTRA_ICONS[view.icon] : KIND_ICONS[view.kind]
  const failed = item.status === "error"
  return (
    <div className="min-w-0">
      <button type="button" aria-expanded={open} onClick={toggle} className={ROW_CLASS}>
        <Icon className={cn("size-4 shrink-0", failed && "text-destructive")} />
        <span
          className={cn(
            "min-w-0 truncate",
            view.code && "font-mono text-xs",
            failed && "text-destructive",
            live && SHIMMER_CLASS,
          )}
        >
          {view.label}
        </span>
        {!failed && (view.added !== undefined || view.removed !== undefined) && (
          <span className="shrink-0 font-mono text-xs">
            <span className="text-success">+{view.added ?? 0}</span> <span className="text-destructive">−{view.removed ?? 0}</span>
          </span>
        )}
        {failed && <X className="size-3.5 shrink-0 text-destructive" aria-label="failed" />}
        <Chevron open={open} />
      </button>
      {open && (
        <div className={DETAILS_CLASS}>
          <ToolDetails item={item} view={view} source={source} nested={nested} />
        </div>
      )}
    </div>
  )
}

/**
 * Consecutive tool calls under one summary line ("Ran 3 commands, read 2 files"). Open while the calls are still
 * coming in, folded once the agent moves on, like a thought. A lone call renders without the summary but through the
 * same elements, so its row (and whatever the user opened in it) survives the next call turning it into a group.
 */
export function ToolGroup({ single, summary, kinds, live, failedCount, children }: {
  single: boolean
  summary: string
  kinds: ReadonlySet<ToolKind>
  live: boolean
  failedCount: number
  children: ReactNode
}) {
  const [open, toggle] = useAutoOpen(live)
  const [only] = kinds
  const Icon = kinds.size === 1 && only !== undefined ? KIND_ICONS[only] : Wrench
  return (
    <div className="min-w-0">
      {single ? null : (
        <button type="button" aria-expanded={open} onClick={toggle} className={ROW_CLASS}>
          <Icon className="size-4 shrink-0" />
          <span className={cn("min-w-0 truncate", live && SHIMMER_CLASS)}>{summary}</span>
          {failedCount > 0 && (
            <span className="flex shrink-0 items-center gap-1 text-destructive">
              <X className="size-3.5" aria-hidden="true" />
              {failedCount} failed
            </span>
          )}
          <Chevron open={open} />
        </button>
      )}
      {(single || open) && <div className={single ? "min-w-0" : cn(DETAILS_CLASS, "gap-0")}>{children}</div>}
    </div>
  )
}
