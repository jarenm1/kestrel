import { useRef, type ReactNode } from "react"
import { ChevronRight } from "lucide-react"
import { type DiffFile, type DiffFileStatus, type DiffLine, displayPath } from "@/lib/diff"
import { cn } from "@/lib/utils"

/** Files with more changed lines than this start collapsed, so one huge file does not bury the rest. */
const LARGE_FILE_LINES = 1500

const STATUS: Record<DiffFileStatus, { letter: string; className: string; label: string }> = {
  added: { letter: "A", className: "bg-success/15 text-success", label: "Added" },
  deleted: { letter: "D", className: "bg-destructive/15 text-destructive", label: "Deleted" },
  modified: { letter: "M", className: "bg-warning/15 text-warning", label: "Modified" },
  renamed: { letter: "R", className: "bg-info/15 text-info", label: "Renamed" },
}

/** Identifies a file within one parsed diff; the same path can appear under two repositories. */
export const diffFileKey = (file: DiffFile): string => `${file.oldPath}\0${file.newPath}`

export const isLargeDiffFile = (file: DiffFile): boolean => file.additions + file.deletions > LARGE_FILE_LINES

/**
 * One parsed diff as a scrollable buffer with a collapsible section per file. The caller owns the open/closed state,
 * so a section can offer its own controls (DiffPanel's Expand all, the pull request view's Viewed checkbox).
 */
export function DiffFileList({
  files,
  isCollapsed,
  onToggle,
  fileAction,
  emptyText = "No changes.",
}: {
  files: readonly DiffFile[]
  isCollapsed: (file: DiffFile) => boolean
  onToggle: (file: DiffFile) => void
  /** Rendered beside a file's header, outside its toggle button (e.g. a Viewed checkbox). */
  fileAction?: (file: DiffFile) => ReactNode
  emptyText?: string
}) {
  return (
    <div className="overflow-clip rounded-xl bg-code font-mono text-xs shadow-well">
      {files.length === 0 && <p className="px-3 py-2.5 text-muted-foreground">{emptyText}</p>}
      {files.map((file) => (
        <FileSection
          key={diffFileKey(file)}
          file={file}
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
  collapsed,
  onToggle,
  action,
}: {
  file: DiffFile
  collapsed: boolean
  onToggle: () => void
  action: ReactNode
}) {
  const section = useRef<HTMLElement>(null)
  const status = STATUS[file.status]
  const path = displayPath(file)
  const slash = path.lastIndexOf("/")

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
          title={file.status === "renamed" ? `${file.oldPath} → ${file.newPath}` : path}
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
            {file.status === "renamed" && <span className="text-muted-foreground">{file.oldPath} → </span>}
            <span className="text-muted-foreground">{path.slice(0, slash + 1)}</span>
            <span className="font-medium text-foreground">{path.slice(slash + 1)}</span>
          </span>
          {file.binary ? (
            <span className="shrink-0 text-muted-foreground">binary</span>
          ) : (
            <span className="shrink-0 font-mono">
              <span className="text-success">+{file.additions}</span>{" "}
              <span className="text-destructive">−{file.deletions}</span>
            </span>
          )}
        </button>
        {action}
      </div>
      {!collapsed && <FileBody file={file} />}
    </section>
  )
}

function FileBody({ file }: { file: DiffFile }) {
  const notes: string[] = []
  if (file.modeChange) notes.push(`Mode ${file.modeChange.from} → ${file.modeChange.to}`)
  if (file.binary) notes.push("Binary file not shown.")
  else if (file.hunks.length === 0 && file.status === "renamed") notes.push("Renamed without changes.")
  else if (file.hunks.length === 0 && file.status === "added") notes.push("Empty file.")
  else if (file.hunks.length === 0 && file.status === "deleted") notes.push("Empty file deleted.")

  return (
    <div className="overflow-x-auto">
      {notes.map((note) => (
        <p key={note} className="px-3 py-1.5 font-sans text-muted-foreground">
          {note}
        </p>
      ))}
      {file.hunks.length > 0 && (
        <table className="min-w-full border-collapse">
          {file.hunks.map((hunk, i) => (
            <tbody key={i}>
              <tr>
                <td colSpan={4} className="bg-info/[0.07] px-3 py-0.5 whitespace-pre text-info/80">
                  {hunk.range}
                  {hunk.section && <span className="text-muted-foreground"> {hunk.section}</span>}
                </td>
              </tr>
              {hunk.lines.map((line, j) => (
                <LineRow key={j} line={line} />
              ))}
            </tbody>
          ))}
        </table>
      )}
    </div>
  )
}

const LINE_STYLE: Record<DiffLine["kind"], { row: string; gutter: string; marker: string }> = {
  add: { row: "bg-success/10", gutter: "bg-success/10 text-success/60", marker: "+" },
  del: { row: "bg-destructive/10", gutter: "bg-destructive/10 text-destructive/60", marker: "-" },
  context: { row: "", gutter: "text-muted-foreground/50", marker: " " },
}

function LineRow({ line }: { line: DiffLine }) {
  const style = LINE_STYLE[line.kind]
  const gutter = cn("w-px select-none px-2 text-right align-top whitespace-nowrap", style.gutter)
  return (
    <tr className={style.row}>
      <td className={gutter}>{line.oldLine ?? ""}</td>
      <td className={gutter}>{line.newLine ?? ""}</td>
      <td className={cn("w-px select-none pl-2 align-top", line.kind === "context" ? "" : style.gutter)}>
        {style.marker}
      </td>
      <td className="pr-4 pl-1 whitespace-pre text-foreground/90">
        {line.text}
        {line.noNewline && (
          <span className="ml-2 font-sans text-[10px] text-muted-foreground select-none">no newline at end of file</span>
        )}
      </td>
    </tr>
  )
}
