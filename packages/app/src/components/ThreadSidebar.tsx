import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from "react"
import { NavLink } from "react-router-dom"
import { PanelLeftClose, PanelLeftOpen, SquarePen } from "lucide-react"
import type { Task } from "@cloudagents/protocol"
import { StatusIcon } from "@/components/StatusIcon"
import { Alert } from "@/components/ui/alert"
import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"
import { errorText, formatAgo } from "@/util"

const STATUS_LABEL: Record<Task["status"], string> = {
  idle: "Idle",
  running: "Working",
  needs_input: "Needs input",
  done: "Done",
  failed: "Failed",
}

const COLLAPSED_KEY = "kestrel.threadsCollapsed"
/** Hover scroll speed for long titles. */
const SCROLL_PX_PER_S = 60
/** How often "5m ago" labels refresh. */
const CLOCK_TICK_MS = 30_000

function useNow(intervalMs: number): number {
  const [now, setNow] = useState(Date.now)
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), intervalMs)
    return () => window.clearInterval(id)
  }, [intervalMs])
  return now
}

/**
 * One line of text that fades out at the right edge instead of truncating. Hovering the enclosing `group` scrolls
 * the hidden rest into view; the trailing padding lets the last characters land clear of the fade.
 */
function FadingTitle({ text }: { text: string }) {
  const outerRef = useRef<HTMLSpanElement>(null)
  const innerRef = useRef<HTMLSpanElement>(null)
  const [overflow, setOverflow] = useState(0)

  useLayoutEffect(() => {
    const outer = outerRef.current
    const inner = innerRef.current
    if (!outer || !inner) return
    const measure = () => setOverflow(Math.max(0, inner.scrollWidth - outer.clientWidth))
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(outer)
    return () => observer.disconnect()
  }, [text])

  const style = { "--shift": `-${overflow}px`, "--scroll": `${overflow / SCROLL_PX_PER_S}s` } as CSSProperties
  return (
    <span
      ref={outerRef}
      className={cn(
        "block min-w-0 overflow-hidden whitespace-nowrap",
        overflow > 0 && "[mask-image:linear-gradient(to_right,black_calc(100%-1.5rem),transparent)]",
      )}
    >
      <span
        ref={innerRef}
        style={style}
        className="inline-block pr-6 transition-transform duration-300 ease-in-out group-hover:[transform:translateX(var(--shift))] group-hover:delay-300 group-hover:[transition-duration:var(--scroll)] motion-reduce:transition-none"
      >
        {text}
      </span>
    </span>
  )
}

/** The active tab takes the panel's colour and loses its right corners, so it reads as part of the panel. */
function tabClass({ isActive }: { isActive: boolean }) {
  return cn(
    "group flex min-w-0 gap-2.5 rounded-[0.5rem] text-muted-foreground transition-colors duration-200 hover:bg-white/[0.03] hover:text-foreground",
    isActive && "rounded-r-none bg-card text-foreground hover:bg-card",
  )
}

interface Props {
  repoId: string
  repoName: string | undefined
  repoUrl: string | undefined
  tasks: readonly Task[] | undefined
  error: unknown
}

/** Threads (tasks) as vertical tabs, most recent first; collapses to an icon rail. */
export function ThreadSidebar({ repoId, repoName, repoUrl, tasks, error }: Props) {
  const now = useNow(CLOCK_TICK_MS)
  const [collapsed, setCollapsed] = useState(() => localStorage.getItem(COLLAPSED_KEY) === "1")
  useEffect(() => {
    if (collapsed) localStorage.setItem(COLLAPSED_KEY, "1")
    else localStorage.removeItem(COLLAPSED_KEY)
  }, [collapsed])

  // TODO: order by the user's last message, not updatedAt (which also moves when a run finishes);
  // needs a `lastMessageAt` on Task from the server. The "ago" label has the same caveat.
  const sorted = [...(tasks ?? [])].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))

  if (collapsed) {
    return (
      <nav aria-label="Threads" className="flex w-12 shrink-0 flex-col items-stretch gap-1 overflow-auto pb-3 pl-2">
        <Button
          variant="ghost"
          size="icon"
          className="self-center"
          aria-label="Expand threads"
          title="Expand threads"
          onClick={() => setCollapsed(false)}
        >
          <PanelLeftOpen />
        </Button>
        <NavLink
          to={`/repos/${repoId}`}
          end
          aria-label="New thread"
          title="New thread"
          className={(s) => cn(tabClass(s), "justify-center py-2")}
        >
          <SquarePen className="size-4" />
        </NavLink>
        {sorted.map((task) => (
          <NavLink
            key={task.id}
            to={`/repos/${repoId}/threads/${task.id}`}
            aria-label={task.title}
            title={`${task.title}\n${STATUS_LABEL[task.status]} · ${formatAgo(task.updatedAt, now)}`}
            className={(s) => cn(tabClass(s), "justify-center py-2")}
          >
            <StatusIcon status={task.status} />
          </NavLink>
        ))}
        {/* TODO: thread actions (rename, archive/delete via DELETE /api/tasks/:id) from a tab context menu. */}
      </nav>
    )
  }

  return (
    <nav aria-label="Threads" className="flex w-64 shrink-0 flex-col gap-0.5 overflow-auto pb-3 pl-3">
      <div className="flex items-center gap-1 pb-2 pl-2.5">
        <span className="min-w-0 flex-1 truncate font-medium" title={repoUrl}>
          {repoName ?? "Repository"}
        </span>
        <Button
          variant="ghost"
          size="icon"
          className="size-7"
          aria-label="Collapse threads"
          title="Collapse threads"
          onClick={() => setCollapsed(true)}
        >
          <PanelLeftClose />
        </Button>
      </div>
      <NavLink to={`/repos/${repoId}`} end className={(s) => cn(tabClass(s), "items-center py-2 pr-3 pl-2.5")}>
        <SquarePen className="size-4 shrink-0" />
        New thread
      </NavLink>
      {Boolean(error) && <Alert className="mt-2 mr-3 w-auto">{errorText(error)}</Alert>}
      {sorted.length > 0 && <div className="px-2.5 pt-4 pb-1 text-xs text-muted-foreground">Threads</div>}
      {sorted.map((task) => (
        <NavLink
          key={task.id}
          to={`/repos/${repoId}/threads/${task.id}`}
          title={`${task.title}\n${task.branch}`}
          className={(s) => cn(tabClass(s), "items-start py-2 pr-3 pl-2.5")}
        >
          <StatusIcon status={task.status} className="mt-0.5" />
          <span className="flex min-w-0 flex-1 flex-col gap-0.5">
            <FadingTitle text={task.title} />
            <span className="text-xs text-muted-foreground">
              {STATUS_LABEL[task.status]} · {formatAgo(task.updatedAt, now)}
            </span>
          </span>
        </NavLink>
      ))}
      {/* TODO: thread actions (rename, archive/delete via DELETE /api/tasks/:id) from a tab context menu. */}
    </nav>
  )
}
