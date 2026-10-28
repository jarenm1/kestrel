import { useMemo, useRef, useState } from "react"
import { useQuery } from "@tanstack/react-query"
import { ChevronRight } from "lucide-react"
import type { CheckoutDiff } from "@cloudagents/protocol"
import { queries } from "@/api/queries"
import { Alert } from "@/components/ui/alert"
import { Button } from "@/components/ui/button"
import { type DiffFile, type DiffFileStatus, type DiffLine, displayPath, parseDiff } from "@/lib/diff"
import { cn } from "@/lib/utils"
import { errorText } from "@/util"

/** Files with more changed lines than this start collapsed, so one huge file does not bury the rest. */
const LARGE_FILE_LINES = 1500

const STATUS: Record<DiffFileStatus, { letter: string; className: string; label: string }> = {
  added: { letter: "A", className: "bg-success/15 text-success", label: "Added" },
  deleted: { letter: "D", className: "bg-destructive/15 text-destructive", label: "Deleted" },
  modified: { letter: "M", className: "bg-warning/15 text-warning", label: "Modified" },
  renamed: { letter: "R", className: "bg-info/15 text-info", label: "Renamed" },
}

const fileKey = (file: DiffFile): string => `${file.oldPath}\0${file.newPath}`

const isLarge = (file: DiffFile): boolean => file.additions + file.deletions > LARGE_FILE_LINES

/**
 * The thread's changes, one section per checked-out repository: every change on that checkout's branch (commits,
 * uncommitted and untracked files) against its base branch. `running` polls while the agent works.
 */
export function DiffPanel({ taskId, running }: { taskId: string; running: boolean }) {
  const diff = useQuery(queries.diff(taskId, running))
  const checkouts = diff.data?.checkouts ?? []

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex justify-end px-4 pb-2">
        <Button variant="soft" size="sm" onClick={() => void diff.refetch()} disabled={diff.isFetching}>
          {diff.isFetching ? "Refreshing…" : "Refresh"}
        </Button>
      </div>
      {diff.error && <Alert className="mx-3 mb-2 w-auto">{errorText(diff.error)}</Alert>}
      <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto px-3 pb-3">
        {diff.isPending && <p className="text-muted-foreground">Loading…</p>}
        {diff.isSuccess && checkouts.length === 0 && (
          <p className="text-muted-foreground">
            No repository checked out yet. The agent checks repos out when the work needs one.
          </p>
        )}
        {checkouts.map((checkout) => (
          <CheckoutDiffSection key={checkout.checkoutId} checkout={checkout} />
        ))}
      </div>
    </div>
  )
}

/**
 * One checkout's changes as a scrollable buffer with a collapsible section per file. Open/closed state lives here, not
 * in the panel, because the same file path can appear under two repositories.
 */
function CheckoutDiffSection({ checkout }: { checkout: CheckoutDiff }) {
  const files = useMemo(() => parseDiff(checkout.diff), [checkout.diff])
  // Explicit open/closed choices by file; files without one use their default (large files closed).
  const [collapsedByKey, setCollapsedByKey] = useState<ReadonlyMap<string, boolean>>(new Map())

  const isCollapsed = (file: DiffFile): boolean => collapsedByKey.get(fileKey(file)) ?? isLarge(file)
  const anyExpanded = files.some((f) => !isCollapsed(f))
  const additions = files.reduce((n, f) => n + f.additions, 0)
  const deletions = files.reduce((n, f) => n + f.deletions, 0)

  function setAll(collapsed: boolean) {
    setCollapsedByKey(new Map(files.map((f) => [fileKey(f), collapsed])))
  }

  function toggle(file: DiffFile) {
    setCollapsedByKey((prev) => new Map(prev).set(fileKey(file), !isCollapsed(file)))
  }

  return (
    <section className="flex shrink-0 flex-col gap-2">
      <div className="flex items-center gap-3 text-xs">
        <span className="flex min-w-0 items-center gap-2 text-muted-foreground">
          <span className="truncate font-medium text-foreground">{checkout.repo}</span>
          <span className="truncate">
            {files.length} {files.length === 1 ? "file" : "files"} vs {checkout.baseBranch}
          </span>
          <span className="font-mono text-success">+{additions}</span>
          <span className="font-mono text-destructive">−{deletions}</span>
        </span>
        <span className="flex-1" />
        {files.length > 1 && (
          <Button variant="ghost" size="sm" onClick={() => setAll(anyExpanded)}>
            {anyExpanded ? "Collapse all" : "Expand all"}
          </Button>
        )}
      </div>
      <div className="max-h-[60vh] overflow-x-hidden overflow-y-auto rounded-xl bg-code font-mono text-xs shadow-well">
        {files.length === 0 && <p className="px-3 py-2.5 text-muted-foreground">No changes.</p>}
        {files.map((file) => (
          <FileSection key={fileKey(file)} file={file} collapsed={isCollapsed(file)} onToggle={() => toggle(file)} />
        ))}
      </div>
    </section>
  )
}

function FileSection({ file, collapsed, onToggle }: { file: DiffFile; collapsed: boolean; onToggle: () => void }) {
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
      <button
        type="button"
        onClick={onClick}
        aria-expanded={!collapsed}
        title={file.status === "renamed" ? `${file.oldPath} → ${file.newPath}` : path}
        className="sticky top-0 z-10 flex w-full items-center gap-2 bg-card/95 px-3 py-1.5 text-left font-sans backdrop-blur hover:bg-accent/95"
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
