import { useMemo, useState } from "react"
import { useQuery } from "@tanstack/react-query"
import { ChevronRight, File, Folder, FolderOpen } from "lucide-react"
import type { CheckoutFiles } from "@cloudagents/protocol"
import { queries } from "@/api/queries"
import { Alert } from "@/components/ui/alert"
import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"
import { errorText } from "@/util"

/** A directory of the tree: subdirectories, then file names, each sorted by name. */
interface DirNode {
  readonly name: string
  /** Path from the checkout root, the key of its open/closed state. */
  readonly path: string
  readonly dirs: DirNode[]
  readonly files: string[]
}

const byName = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" })

/** Nests `/`-separated file paths into directories. */
function buildTree(paths: readonly string[]): DirNode {
  const root: DirNode = { name: "", path: "", dirs: [], files: [] }
  const dirsByPath = new Map<string, DirNode>([["", root]])
  for (const path of paths) {
    const parts = path.split("/")
    let dir = root
    for (const part of parts.slice(0, -1)) {
      const childPath = dir.path === "" ? part : `${dir.path}/${part}`
      let child = dirsByPath.get(childPath)
      if (child === undefined) {
        child = { name: part, path: childPath, dirs: [], files: [] }
        dirsByPath.set(childPath, child)
        dir.dirs.push(child)
      }
      dir = child
    }
    dir.files.push(parts[parts.length - 1] ?? path)
  }
  for (const dir of dirsByPath.values()) {
    dir.dirs.sort((a, b) => byName.compare(a.name, b.name))
    dir.files.sort(byName.compare)
  }
  return root
}

/**
 * The file tree of each repository the thread has checked out, as it is in the working tree now (ignored files left
 * out). View only: files do not open. Refetched when the thread's run events invalidate it.
 */
export function FilesPanel({ taskId }: { taskId: string }) {
  const files = useQuery(queries.files(taskId))
  const checkouts = files.data?.checkouts ?? []

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex justify-end px-4 pb-2">
        <Button variant="soft" size="sm" onClick={() => void files.refetch()} disabled={files.isFetching}>
          {files.isFetching ? "Refreshing…" : "Refresh"}
        </Button>
      </div>
      {files.error && <Alert className="mx-3 mb-2 w-auto">{errorText(files.error)}</Alert>}
      <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto px-3 pb-3">
        {files.isPending && <p className="text-muted-foreground">Loading…</p>}
        {files.isSuccess && checkouts.length === 0 && (
          <p className="text-muted-foreground">
            No repository checked out yet. The agent checks repos out when the work needs one.
          </p>
        )}
        {checkouts.map((checkout) => (
          <CheckoutTree key={checkout.checkoutId} checkout={checkout} />
        ))}
      </div>
    </div>
  )
}

/** One checkout's tree. Open directories live here, since two repositories can have the same paths. */
function CheckoutTree({ checkout }: { checkout: CheckoutFiles }) {
  const root = useMemo(() => buildTree(checkout.files), [checkout.files])
  const [open, setOpen] = useState<ReadonlySet<string>>(new Set())

  function toggle(path: string) {
    setOpen((prev) => {
      const next = new Set(prev)
      if (!next.delete(path)) next.add(path)
      return next
    })
  }

  return (
    <section className="flex shrink-0 flex-col gap-2">
      <div className="flex items-center gap-3 text-xs">
        <span className="flex min-w-0 items-center gap-2 text-muted-foreground">
          <span className="truncate font-medium text-foreground">{checkout.repo}</span>
          <span className="truncate">
            {checkout.truncated ? "first " : ""}
            {checkout.files.length} {checkout.files.length === 1 ? "file" : "files"}
          </span>
        </span>
        <span className="flex-1" />
        {open.size > 0 && (
          <Button variant="ghost" size="sm" onClick={() => setOpen(new Set())}>
            Collapse all
          </Button>
        )}
      </div>
      <div
        role="tree"
        aria-label={`Files of ${checkout.repo}`}
        className="max-h-[60vh] overflow-x-hidden overflow-y-auto rounded-xl bg-code py-1 text-xs shadow-well"
      >
        {checkout.files.length === 0 && <p className="px-3 py-1.5 text-muted-foreground">No files.</p>}
        <DirChildren dir={root} depth={0} open={open} onToggle={toggle} />
        {checkout.truncated && (
          <p className="px-3 py-1.5 text-muted-foreground">
            The tree has more files than this; the rest are not shown.
          </p>
        )}
      </div>
    </section>
  )
}

/** Rows are indented by depth: the chevron column plus this much per level. */
const indent = (depth: number) => ({ paddingLeft: `${0.75 + depth * 0.875}rem` })

function DirChildren({
  dir,
  depth,
  open,
  onToggle,
}: {
  dir: DirNode
  depth: number
  open: ReadonlySet<string>
  onToggle: (path: string) => void
}) {
  return (
    <>
      {dir.dirs.map((child) => {
        const expanded = open.has(child.path)
        return (
          <div key={child.path} role="treeitem" aria-expanded={expanded}>
            <button
              type="button"
              onClick={() => onToggle(child.path)}
              title={child.path}
              style={indent(depth)}
              className="flex w-full items-center gap-1.5 py-0.5 pr-3 text-left hover:bg-accent/60"
            >
              <ChevronRight
                className={cn("size-3.5 shrink-0 text-muted-foreground transition-transform", expanded && "rotate-90")}
              />
              {expanded ? (
                <FolderOpen className="size-3.5 shrink-0 text-muted-foreground" />
              ) : (
                <Folder className="size-3.5 shrink-0 text-muted-foreground" />
              )}
              <span className="min-w-0 truncate text-foreground">{child.name}</span>
            </button>
            {expanded && (
              <div role="group">
                <DirChildren dir={child} depth={depth + 1} open={open} onToggle={onToggle} />
              </div>
            )}
          </div>
        )
      })}
      {dir.files.map((name) => {
        const path = dir.path === "" ? name : `${dir.path}/${name}`
        return (
          <div
            key={path}
            role="treeitem"
            title={path}
            style={indent(depth)}
            className="flex items-center gap-1.5 py-0.5 pr-3 text-muted-foreground"
          >
            {/* Lines file names up with directory names, past the chevron column. */}
            <span className="size-3.5 shrink-0" />
            <File className="size-3.5 shrink-0" />
            <span className="min-w-0 truncate">{name}</span>
          </div>
        )
      })}
    </>
  )
}
