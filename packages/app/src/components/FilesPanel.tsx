import { useDeferredValue, useEffect, useMemo, useRef, useState, type ReactNode } from "react"
import { keepPreviousData, useQuery } from "@tanstack/react-query"
import { ChevronRight, Download, Eye, EyeOff, File, Folder, FolderOpen, Search } from "lucide-react"
import type { FileRoot, FilesResponse, FolderFiles } from "@cloudagents/protocol"
import { api } from "@/api/client"
import { queries } from "@/api/queries"
import { Alert } from "@cloudagents/ui/alert"
import { Button } from "@cloudagents/ui/button"
import { Input } from "@/components/ui/input"
import { cn } from "@/lib/utils"
import { errorText, formatAgo } from "@/util"

/** A directory of the tree: subdirectories, then file names, each sorted by name. */
interface DirNode {
  readonly name: string
  /** Path from the root, the key of its open/closed state. */
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

/** A filter shows at most this many matches per root, all expanded, so a one-letter query stays cheap to render. */
const MAX_FILTER_MATCHES = 500

/** Recent lists at most this many files. */
const RECENT_LIMIT = 8

const NO_PATHS: ReadonlySet<string> = new Set()

const ROOT_LABEL = { workspace: "Workspace", home: "Home" } as const

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  const units = ["KB", "MB", "GB", "TB"]
  let value = bytes / 1024
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024
    unit++
  }
  return `${value < 10 ? value.toFixed(1) : Math.round(value)} ${units[unit]}`
}

type StartDownload = (root: FileRoot, path: string) => void

/** Sections the user folded away (`recent`, `workspace`, `home`, `repo:<owner/name>`), remembered across threads. */
const COLLAPSED_SECTIONS_KEY = "kestrel.filesCollapsed"

function storedCollapsedSections(): ReadonlySet<string> {
  try {
    const stored: unknown = JSON.parse(localStorage.getItem(COLLAPSED_SECTIONS_KEY) ?? "[]")
    return new Set(Array.isArray(stored) ? stored.filter((id): id is string => typeof id === "string") : [])
  } catch {
    return new Set()
  }
}

/**
 * The thread's files: what changed outside its repositories during the thread (Recent), the tree of each repository it
 * has checked out (ignored files left out), its working folder outside them (Workspace), and the agent's home, where
 * desktop apps save (Home). Hidden files (dot names, dependency folders) show only on request. A filter narrows every
 * list. Any file downloads. Refetched when the thread's run events invalidate it.
 */
export function FilesPanel({ taskId }: { taskId: string }) {
  const [hidden, setHidden] = useState(false)
  // Toggling hidden files keeps showing the current listing until the other one arrives.
  const files = useQuery({ ...queries.files(taskId, hidden), placeholderData: keepPreviousData })
  // The placeholder lasts only while loading: if the other listing then fails, the last one stays on screen (with the
  // error above it) instead of every section vanishing.
  const lastListing = useRef<FilesResponse | undefined>(undefined)
  if (files.data !== undefined) lastListing.current = files.data
  const task = useQuery(queries.task(taskId))
  const [filter, setFilter] = useState("")
  // Typing stays responsive on a large tree: the trees catch up with the input instead of blocking it.
  const query = useDeferredValue(filter.trim().toLowerCase())
  const [downloadError, setDownloadError] = useState<string | null>(null)
  const [collapsed, setCollapsed] = useState(storedCollapsedSections)
  useEffect(() => {
    localStorage.setItem(COLLAPSED_SECTIONS_KEY, JSON.stringify([...collapsed]))
  }, [collapsed])

  /** Props that make a section foldable under `id`. */
  const foldable = (id: string) => ({
    collapsed: collapsed.has(id),
    onToggleSection: () =>
      setCollapsed((prev) => {
        const next = new Set(prev)
        if (!next.delete(id)) next.add(id)
        return next
      }),
  })

  const download: StartDownload = (root, path) => {
    setDownloadError(null)
    api.downloadFile(taskId, root, path).catch((e: unknown) => setDownloadError(errorText(e)))
  }

  const data = files.data ?? lastListing.current
  const empty =
    data !== undefined && data.checkouts.length === 0 && data.workspace.files.length === 0 && data.home.files.length === 0

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
        <Button
          variant={hidden ? "soft" : "ghost"}
          size="icon"
          aria-pressed={hidden}
          aria-label="Show hidden files"
          title={hidden ? "Hide hidden files" : "Show hidden files (dotfiles, caches, node_modules)"}
          onClick={() => setHidden((h) => !h)}
        >
          {hidden ? <Eye /> : <EyeOff />}
        </Button>
        <Button variant="soft" size="sm" onClick={() => void files.refetch()} disabled={files.isFetching}>
          {files.isFetching ? "Refreshing…" : "Refresh"}
        </Button>
      </div>
      {files.error && (
        <Alert className="mx-3 mb-2 w-auto">
          {hidden ? "Hidden files could not be listed: " : ""}
          {errorText(files.error)}
        </Alert>
      )}
      {downloadError && <Alert className="mx-3 mb-2 w-auto">{downloadError}</Alert>}
      <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto px-3 pb-3">
        {files.isPending && <p className="text-muted-foreground">Loading…</p>}
        {empty && (
          <p className="text-muted-foreground">
            No files yet. Repositories the agent checks out, its working folder and its home show up here.
          </p>
        )}
        {data && task.data && (
          <RecentFiles
            data={data}
            since={task.data.createdAt}
            query={query}
            onDownload={download}
            {...foldable("recent")}
          />
        )}
        {data?.checkouts.map((checkout) => (
          <RootTree
            key={checkout.checkoutId}
            title={checkout.repo}
            root={{ checkoutId: checkout.checkoutId }}
            paths={checkout.files}
            truncated={checkout.truncated}
            query={query}
            onDownload={download}
            {...foldable(`repo:${checkout.repo}`)}
          />
        ))}
        {data &&
          (["workspace", "home"] as const).map(
            (root) =>
              data[root].files.length > 0 && (
                <FolderTree
                  key={root}
                  root={root}
                  folder={data[root]}
                  query={query}
                  onDownload={download}
                  {...foldable(root)}
                />
              ),
          )}
      </div>
    </div>
  )
}

/** What a section needs to fold: whether it is folded, and how to flip that. */
interface Foldable {
  collapsed: boolean
  onToggleSection: () => void
}

/**
 * A titled block of the panel. Its title folds the body away. The header row keeps one height whatever `action` it
 * shows, so the content below never moves when the action appears.
 */
function Section({
  title,
  detail,
  action,
  collapsed,
  onToggleSection,
  children,
}: Foldable & { title: string; detail?: ReactNode; action?: ReactNode; children: ReactNode }) {
  return (
    <section className="flex shrink-0 flex-col gap-1.5">
      <div className="flex h-7 items-center gap-2 text-xs">
        <button
          type="button"
          aria-expanded={!collapsed}
          onClick={onToggleSection}
          className="flex min-w-0 items-center gap-1.5 rounded text-left text-muted-foreground outline-none hover:text-foreground focus-visible:ring-1 focus-visible:ring-ring"
        >
          <ChevronRight className={cn("size-3.5 shrink-0 transition-transform", !collapsed && "rotate-90")} />
          <span className="truncate font-medium text-foreground">{title}</span>
          {detail !== undefined && <span className="truncate">{detail}</span>}
        </button>
        <span className="flex-1" />
        {!collapsed && action}
      </div>
      {!collapsed && children}
    </section>
  )
}

/** Files outside the repositories changed since the thread started, newest first; repository changes are the Diff. */
function RecentFiles({
  data,
  since,
  query,
  onDownload,
  ...fold
}: Foldable & {
  data: { readonly workspace: FolderFiles; readonly home: FolderFiles }
  since: string
  query: string
  onDownload: StartDownload
}) {
  const recent = useMemo(() => {
    const start = new Date(since).getTime()
    return (["workspace", "home"] as const)
      .flatMap((root) => data[root].files.map((file) => ({ root, ...file, at: new Date(file.modifiedAt).getTime() })))
      .filter((f) => f.at >= start && (query === "" || f.path.toLowerCase().includes(query)))
      .sort((a, b) => b.at - a.at)
      .slice(0, RECENT_LIMIT)
  }, [data, since, query])
  if (recent.length === 0) return null
  const now = Date.now()

  return (
    <Section title="Recent" {...fold}>
      <ul className="rounded-xl bg-code py-1 text-xs shadow-well">
        {recent.map((file) => {
          const slash = file.path.lastIndexOf("/")
          const name = file.path.slice(slash + 1)
          return (
            <li
              key={`${file.root}/${file.path}`}
              title={`${ROOT_LABEL[file.root]} · ${file.path}`}
              className="group flex items-center gap-2 px-3 py-1"
            >
              <File className="size-3.5 shrink-0 text-muted-foreground" />
              <span className="min-w-0 shrink truncate text-foreground">
                <Highlighted name={name} query={query} />
              </span>
              <span className="min-w-0 flex-1 truncate text-muted-foreground">
                {ROOT_LABEL[file.root]}
                {slash > 0 && ` · ${file.path.slice(0, slash)}/`}
              </span>
              <span className="shrink-0 text-muted-foreground">{formatAgo(file.modifiedAt, now)}</span>
              <span className="w-14 shrink-0 text-right text-muted-foreground">{formatSize(file.size)}</span>
              <DownloadButton name={name} onClick={() => onDownload(file.root, file.path)} />
            </li>
          )
        })}
      </ul>
    </Section>
  )
}

/** The workspace or home folder as a tree; each file's size shows in its tooltip. */
function FolderTree({
  root,
  folder,
  query,
  onDownload,
  ...fold
}: Foldable & {
  root: "workspace" | "home"
  folder: FolderFiles
  query: string
  onDownload: StartDownload
}) {
  const paths = useMemo(() => folder.files.map((f) => f.path), [folder.files])
  const sizes = useMemo(() => new Map(folder.files.map((f) => [f.path, f.size])), [folder.files])
  return (
    <RootTree
      title={ROOT_LABEL[root]}
      root={root}
      paths={paths}
      sizes={sizes}
      truncated={folder.truncated}
      query={query}
      onDownload={onDownload}
      {...fold}
    />
  )
}

/**
 * One root's tree (a repository, the workspace or the home). Open directories live here, since two roots can have the
 * same paths. Unfiltered, every directory starts closed; filtered, the matches' directories start open and closing one
 * lasts until the query changes.
 */
function RootTree({
  title,
  root,
  paths,
  sizes,
  truncated,
  query,
  onDownload,
  ...fold
}: Foldable & {
  title: string
  root: FileRoot
  paths: readonly string[]
  sizes?: ReadonlyMap<string, number>
  truncated: boolean
  query: string
  onDownload: StartDownload
}) {
  const matches = useMemo(
    () => (query === "" ? null : paths.filter((path) => path.toLowerCase().includes(query))),
    [paths, query],
  )
  const tree = useMemo(
    () => buildTree(matches === null ? paths : matches.slice(0, MAX_FILTER_MATCHES)),
    [paths, matches],
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
    <Section
      title={title}
      detail={`${matches !== null ? `${matches.length} of ` : ""}${truncated ? "first " : ""}${paths.length} ${paths.length === 1 ? "file" : "files"}`}
      action={
        matches === null &&
        open.size > 0 && (
          <Button variant="ghost" size="sm" className="h-6" onClick={() => setOpen(new Set())}>
            Collapse all
          </Button>
        )
      }
      {...fold}
    >
      <div
        role="tree"
        aria-label={`Files of ${title}`}
        className="max-h-[60vh] overflow-x-hidden overflow-y-auto rounded-xl bg-code py-1 text-xs shadow-well"
      >
        {paths.length === 0 && <p className="px-3 py-1.5 text-muted-foreground">No files.</p>}
        {matches?.length === 0 && paths.length > 0 && <p className="px-3 py-1.5 text-muted-foreground">No matches.</p>}
        <DirChildren
          dir={tree}
          depth={0}
          query={query}
          isOpen={isOpen}
          onToggle={toggle}
          onDownload={(path) => onDownload(root, path)}
          sizes={sizes}
        />
        {matches !== null && matches.length > MAX_FILTER_MATCHES && (
          <p className="px-3 py-1.5 text-muted-foreground">
            Showing the first {MAX_FILTER_MATCHES} matches; type more to narrow it down.
          </p>
        )}
        {truncated && (
          <p className="px-3 py-1.5 text-muted-foreground">The tree has more files than this; the rest are not shown.</p>
        )}
      </div>
    </Section>
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

/** Shown on hover or keyboard focus of its row, so the tree stays quiet. */
function DownloadButton({ name, onClick }: { name: string; onClick: () => void }) {
  return (
    <button
      type="button"
      aria-label={`Download ${name}`}
      title="Download"
      onClick={onClick}
      className="shrink-0 rounded p-0.5 text-muted-foreground opacity-0 outline-none group-hover:opacity-100 hover:text-foreground focus-visible:opacity-100 focus-visible:ring-1 focus-visible:ring-ring"
    >
      <Download className="size-3.5" />
    </button>
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
  onDownload,
  sizes,
}: {
  dir: DirNode
  depth: number
  query: string
  isOpen: (path: string) => boolean
  onToggle: (path: string) => void
  onDownload: (path: string) => void
  sizes: ReadonlyMap<string, number> | undefined
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
                <DirChildren
                  dir={child}
                  depth={depth + 1}
                  query={query}
                  isOpen={isOpen}
                  onToggle={onToggle}
                  onDownload={onDownload}
                  sizes={sizes}
                />
              </div>
            )}
          </div>
        )
      })}
      {dir.files.map((name) => {
        const path = dir.path === "" ? name : `${dir.path}/${name}`
        const size = sizes?.get(path)
        return (
          <div
            key={path}
            role="treeitem"
            title={size === undefined ? path : `${path} · ${formatSize(size)}`}
            style={indent(depth)}
            className="group flex items-center gap-1.5 py-0.5 pr-3 text-muted-foreground hover:bg-accent/40"
          >
            {/* Lines file names up with directory names, past the chevron column. */}
            <span className="size-3.5 shrink-0" />
            <File className="size-3.5 shrink-0" />
            <span className="min-w-0 flex-1 truncate">
              <Highlighted name={name} query={query} />
            </span>
            <DownloadButton name={name} onClick={() => onDownload(path)} />
          </div>
        )
      })}
    </>
  )
}
