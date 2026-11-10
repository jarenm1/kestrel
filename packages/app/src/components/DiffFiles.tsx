import { useRef, type ReactNode } from "react"
import { ChevronRight } from "lucide-react"
import { FileDiff, type FileDiffProps } from "@pierre/diffs/react"
import type { FileDiffMetadata } from "@pierre/diffs/types"
import {
  diffFileKey,
  diffFileNotes,
  diffFileStats,
  diffFileStatus,
  displayPath,
  isRenamed,
  type DiffFileStatus,
} from "@/lib/pierreDiff"
import { cn } from "@/lib/utils"

/** Files with more changed lines than this start collapsed, so one huge file does not bury the rest. */
const LARGE_FILE_LINES = 1500

const STATUS: Record<DiffFileStatus, { letter: string; className: string; label: string }> = {
  added: { letter: "A", className: "bg-success/15 text-success", label: "Added" },
  deleted: { letter: "D", className: "bg-destructive/15 text-destructive", label: "Deleted" },
  modified: { letter: "M", className: "bg-warning/15 text-warning", label: "Modified" },
  renamed: { letter: "R", className: "bg-info/15 text-info", label: "Renamed" },
}

/** The same dark rendering t3code uses. Kestrel has no light appearance, so no second theme is loaded. */
const DIFF_OPTIONS: NonNullable<FileDiffProps<undefined, undefined>["options"]> = {
  theme: "pierre-dark",
  themeType: "dark",
  diffStyle: "unified",
  diffIndicators: "classic",
  lineDiffType: "none",
  overflow: "scroll",
  disableFileHeader: true,
  disableBackground: true,
  preferredHighlighter: "highlights",
  tokenizeMaxLineLength: 1000,
  hunkSeparators: "simple",
}

export const isLargeDiffFile = (file: FileDiffMetadata): boolean => {
  const stats = diffFileStats(file)
  return stats.additions + stats.deletions > LARGE_FILE_LINES
}

/**
 * One parsed diff as a scrollable buffer with a collapsible section per file. The caller owns the open/closed state,
 * so a section can offer its own controls (DiffPanel's Expand all, the pull request view's Viewed checkbox).
 */
export function DiffFileList({
  files,
  binary,
  isCollapsed,
  onToggle,
  fileAction,
  emptyText = "No changes.",
}: {
  files: readonly FileDiffMetadata[]
  /** Names of files whose patches are binary; they get a note instead of a body. */
  binary: ReadonlySet<string>
  isCollapsed: (file: FileDiffMetadata) => boolean
  onToggle: (file: FileDiffMetadata) => void
  /** Rendered beside a file's header, outside its toggle button (e.g. a Viewed checkbox). */
  fileAction?: (file: FileDiffMetadata) => ReactNode
  emptyText?: string
}) {
  return (
    <div className="overflow-clip rounded-xl bg-code font-mono text-xs shadow-well">
      {files.length === 0 && <p className="px-3 py-2.5 text-muted-foreground">{emptyText}</p>}
      {files.map((file) => (
        <FileSection
          key={diffFileKey(file)}
          file={file}
          binary={binary.has(file.name)}
          collapsed={isCollapsed(file)}
          onToggle={() => onToggle(file)}
          action={fileAction?.(file)}
        />
      ))}
    </div>
  )
}

function FileSection({
  file,
  binary,
  collapsed,
  onToggle,
  action,
}: {
  file: FileDiffMetadata
  binary: boolean
  collapsed: boolean
  onToggle: () => void
  action: ReactNode
}) {
  const section = useRef<HTMLElement>(null)
  const status = STATUS[diffFileStatus(file)]
  const path = displayPath(file)
  const slash = path.lastIndexOf("/")
  const stats = diffFileStats(file)

  function onClick() {
    onToggle()
    // Collapsing from a stuck header would leave the view far below the section; bring its header back.
    if (!collapsed) requestAnimationFrame(() => section.current?.scrollIntoView({ block: "nearest" }))
  }

  return (
    <section ref={section} className="border-b border-white/[0.06] last:border-b-0">
      <div className="sticky top-0 z-10 flex items-center gap-2 bg-card/95 pr-3 font-sans backdrop-blur hover:bg-accent/95">
        <button
          type="button"
          onClick={onClick}
          aria-expanded={!collapsed}
          title={isRenamed(file) ? `${file.prevName ?? path} → ${path}` : path}
          className="flex min-w-0 flex-1 items-center gap-2 py-1.5 pl-3 text-left outline-none focus-visible:shadow-glow"
        >
          <ChevronRight
            className={cn("size-3.5 shrink-0 text-muted-foreground transition-transform", !collapsed && "rotate-90")}
          />
          <span
            aria-label={status.label}
            className={cn("grid size-4 shrink-0 place-items-center rounded font-mono text-[10px] font-semibold", status.className)}
          >
            {status.letter}
          </span>
          <span className="min-w-0 flex-1 truncate">
            {isRenamed(file) && <span className="text-muted-foreground">{file.prevName} → </span>}
            <span className="text-muted-foreground">{path.slice(0, slash + 1)}</span>
            <span className="font-medium text-foreground">{path.slice(slash + 1)}</span>
          </span>
          {binary ? (
            <span className="shrink-0 text-muted-foreground">binary</span>
          ) : (
            <span className="shrink-0 font-mono">
              <span className="text-success">+{stats.additions}</span>{" "}
              <span className="text-destructive">−{stats.deletions}</span>
            </span>
          )}
        </button>
        {action}
      </div>
      {!collapsed && <FileBody file={file} binary={binary} />}
    </section>
  )
}

function FileBody({ file, binary }: { file: FileDiffMetadata; binary: boolean }) {
  const notes = diffFileNotes(file, binary)
  return (
    <div className="overflow-x-auto">
      {notes.map((note) => (
        <p key={note} className="px-3 py-1.5 font-sans text-muted-foreground">
          {note}
        </p>
      ))}
      {file.hunks.length > 0 && <FileDiff fileDiff={file} options={DIFF_OPTIONS} disableWorkerPool />}
    </div>
  )
}
