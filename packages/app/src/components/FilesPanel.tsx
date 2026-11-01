import { useDeferredValue, useMemo, useState } from "react"
import { useQuery } from "@tanstack/react-query"
import { ChevronRight, File, Folder, FolderOpen, Search } from "lucide-react"
import type { CheckoutFiles } from "@cloudagents/protocol"
import { queries } from "@/api/queries"
import { Alert } from "@/components/ui/alert"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
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

/** A filter shows at most this many matches per checkout, all expanded, so a one-letter query stays cheap to render. */
const MAX_FILTER_MATCHES = 500

const NO_PATHS: ReadonlySet<string> = new Set()

/**
 * The file tree of each repository the thread has checked out, as it is in the working tree now (ignored files left
 * out), with a filter over every checkout's paths. View only: files do not open. Refetched when the thread's run
 * events invalidate it.
 */
export function FilesPanel({ taskId }: { taskId: string }) {
  const files = useQuery(queries.files(taskId))
  const checkouts = files.data?.checkouts ?? []
  const [filter, setFilter] = useState("")
  // Typing stays responsive on a large tree: the trees catch up with the input instead of blocking it.
  const query = useDeferredValue(filter.trim().toLowerCase())

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex items-center gap-2 px-4 pb-2">
        <div className="relative min-w-0 flex-1">
          <Search className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Escape") setFilter("")
            }}
            placeholder="Filter files…"
            aria-label="Filter files"
            className="h-8 pl-8 text-sm"
          />
        </div>
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
          <CheckoutTree key={checkout.checkoutId} checkout={checkout} query={query} />
        ))}
      </div>
    </div>
  )
}

/**
 * One checkout's tree. Open directories live here, since two repositories can have the same paths. Unfiltered, every
 * directory starts closed; filtered, the matches' directories start open and closing one lasts until the query changes.
 */
function CheckoutTree({ checkout, query }: { checkout: CheckoutFiles; query: string }) {
  const matches = useMemo(
    () => (query === "" ? null : checkout.files.filter((path) => path.toLowerCase().includes(query))),
    [checkout.files, query],
  )
  const root = useMemo(
    () => buildTree(matches === null ? checkout.files : matches.slice(0, MAX_FILTER_MATCHES)),
    [checkout.files, matches],
  )
  const [open, setOpen] = useState<ReadonlySet<string>>(new Set())
  const [filterClosed, setFilterClosed] = useState<{ query: string; paths: ReadonlySet<string> }>({
    query: "",
    paths: NO_PATHS,
  })
  const closed = filterClosed.query === query ? filterClosed.paths : NO_PATHS

  const isOpen = (path: string): boolean => (matches === null ? open.has(path) : !closed.has(path))

  function toggle(path: string) {
    const flip = (prev: ReadonlySet<string>) => {
      const next = new Set(prev)
      if (!next.delete(path)) next.add(path)
      return next
    }
    if (matches === null) setOpen(flip)
    else setFilterClosed({ query, paths: flip(closed) })
  }

  return (
    <section className="flex shrink-0 flex-col gap-2">
      <div className="flex items-center gap-3 text-xs">
        <span className="flex min-w-0 items-center gap-2 text-muted-foreground">
          <span className="truncate font-medium text-foreground">{checkout.repo}</span>
          <span className="truncate">
            {matches !== null && `${matches.length} of `}
            {checkout.truncated ? "first " : ""}
            {checkout.files.length} {checkout.files.length === 1 ? "file" : "files"}
          </span>
        </span>
        <span className="flex-1" />
        {matches === null && open.size > 0 && (
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
        {matches?.length === 0 && checkout.files.length > 0 && (
          <p className="px-3 py-1.5 text-muted-foreground">No matches.</p>
        )}
        <DirChildren dir={root} depth={0} query={query} isOpen={isOpen} onToggle={toggle} />
        {matches !== null && matches.length > MAX_FILTER_MATCHES && (
          <p className="px-3 py-1.5 text-muted-foreground">
            Showing the first {MAX_FILTER_MATCHES} matches; type more to narrow it down.
          </p>
        )}
        {checkout.truncated && (
          <p className="px-3 py-1.5 text-muted-foreground">
            The tree has more files than this; the rest are not shown.
          </p>
        )}
      </div>
    </section>
  )
}

/** `name` with the first case-insensitive occurrence of `query` marked. */
function Highlighted({ name, query }: { name: string; query: string }) {
  const at = query === "" ? -1 : name.toLowerCase().indexOf(query)
  if (at === -1) return name
  return (
    <>
      {name.slice(0, at)}
      <mark className="rounded-sm bg-warning/25 text-foreground">{name.slice(at, at + query.length)}</mark>
      {name.slice(at + query.length)}
    </>
  )
}

/** Rows are indented by depth: the chevron column plus this much per level. */
const indent = (depth: number) => ({ paddingLeft: `${0.75 + depth * 0.875}rem` })

function DirChildren({
  dir,
  depth,
  query,
  isOpen,
  onToggle,
}: {
  dir: DirNode
  depth: number
  query: string
  isOpen: (path: string) => boolean
  onToggle: (path: string) => void
}) {
  return (
    <>
      {dir.dirs.map((child) => {
        const expanded = isOpen(child.path)
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
              <span className="min-w-0 truncate text-foreground">
                <Highlighted name={child.name} query={query} />
              </span>
            </button>
            {expanded && (
              <div role="group">
                <DirChildren dir={child} depth={depth + 1} query={query} isOpen={isOpen} onToggle={onToggle} />
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
            <span className="min-w-0 truncate">
              <Highlighted name={name} query={query} />
            </span>
          </div>
        )
      })}
    </>
  )
}
