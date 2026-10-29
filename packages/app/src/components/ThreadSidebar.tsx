import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from "react"
import { NavLink, useNavigate, useParams } from "react-router-dom"
import { Archive, PanelLeftClose, SquarePen, Workflow } from "lucide-react"
import type { Task } from "@cloudagents/protocol"
import { AccountMenu } from "@/components/AccountMenu"
import { KestrelMark } from "@/components/KestrelMark"
import { StatusIcon } from "@/components/StatusIcon"
import { Alert } from "@/components/ui/alert"
import { Button } from "@/components/ui/button"
import { useThreadArchive } from "@/hooks/useThreadArchive"
import { cn } from "@/lib/utils"
import { APP_HOME, threadPath } from "@/routes"
import { errorText, formatAgo, repoShortName } from "@/util"

const STATUS_LABEL: Record<Task["status"], string> = {
  idle: "Idle",
  running: "Working",
  needs_input: "Needs input",
  done: "Done",
  failed: "Failed",
}

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
  tasks: readonly Task[] | undefined
  error: unknown
  collapsed: boolean
  onCollapse: () => void
}

/**
 * The user's threads (tasks) as vertical tabs, most recent first. Collapsed, it is an icon rail; the button that
 * expands it again lives in the page panel (`WorkspaceLayout`).
 */
export function ThreadSidebar({ tasks, error, collapsed, onCollapse }: Props) {
  const now = useNow(CLOCK_TICK_MS)
  const navigate = useNavigate()
  const { taskId: openTaskId } = useParams()
  const { archive } = useThreadArchive()

  // TODO: order by the user's last message, not updatedAt (which also moves when a run finishes);
  // needs a `lastMessageAt` on Task from the server. The "ago" label has the same caveat.
  const byRecent = [...(tasks ?? [])].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
  const sorted = byRecent.filter((task) => task.archivedAt === undefined)
  const archivedCount = byRecent.length - sorted.length

  function archiveThread(task: Task) {
    archive.mutate(task.id, {
      // The open thread leaves the list; go back to the empty chat.
      onSuccess: () => {
        if (task.id === openTaskId) navigate(APP_HOME)
      },
    })
  }

  if (collapsed) {
    return (
      <div className="flex w-12 shrink-0 flex-col gap-1 pb-3 pl-2">
        <HomeMark className="self-center py-0.5" />
        <nav aria-label="Threads" className="flex min-h-0 flex-1 flex-col items-stretch gap-1 overflow-auto">
          <NavLink
            to={APP_HOME}
            end
            aria-label="New thread"
            title="New thread"
            className={(s) => cn(tabClass(s), "justify-center py-2")}
          >
            <SquarePen className="size-4" />
          </NavLink>
          <NavLink
            to="/automations"
            aria-label="Automations"
            title="Automations"
            className={(s) => cn(tabClass(s), "justify-center py-2")}
          >
            <Workflow className="size-4" />
          </NavLink>
          <NavLink
            to="/archived"
            aria-label="Archived"
            title="Archived"
            className={(s) => cn(tabClass(s), "justify-center py-2")}
          >
            <Archive className="size-4" />
          </NavLink>
          {sorted.map((task) => (
            <NavLink
              key={task.id}
              to={threadPath(task.id)}
              aria-label={task.title}
              title={`${task.title}\n${STATUS_LABEL[task.status]} · ${formatAgo(task.updatedAt, now)}`}
              className={(s) => cn(tabClass(s), "justify-center py-2")}
            >
              <StatusIcon status={task.status} />
            </NavLink>
          ))}
        </nav>
        <AccountMenu compact />
      </div>
    )
  }

  return (
    <div className="flex w-64 shrink-0 flex-col pb-3 pl-3">
      <div className="flex items-center gap-2 pb-2 pl-1.5">
        <HomeMark />
        <span className="min-w-0 flex-1 truncate font-semibold tracking-tight">Kestrel</span>
        <Button
          variant="ghost"
          size="icon"
          className="size-7"
          aria-label="Collapse threads"
          title="Collapse threads"
          onClick={onCollapse}
        >
          <PanelLeftClose />
        </Button>
      </div>
      <nav aria-label="Threads" className="flex min-h-0 flex-1 flex-col gap-0.5 overflow-auto">
        <NavLink to={APP_HOME} end className={(s) => cn(tabClass(s), "items-center py-2 pr-3 pl-2.5")}>
          <SquarePen className="size-4 shrink-0" />
          New thread
        </NavLink>
        <NavLink to="/automations" className={(s) => cn(tabClass(s), "items-center py-2 pr-3 pl-2.5")}>
          <Workflow className="size-4 shrink-0" />
          Automations
        </NavLink>
        <NavLink to="/archived" className={(s) => cn(tabClass(s), "items-center py-2 pr-3 pl-2.5")}>
          <Archive className="size-4 shrink-0" />
          Archived{archivedCount > 0 ? ` (${archivedCount})` : null}
        </NavLink>
        {Boolean(error) && <Alert className="mt-2 mr-3 w-auto">{errorText(error)}</Alert>}
        {archive.error && <Alert className="mr-3 w-auto">{errorText(archive.error)}</Alert>}
        {sorted.length > 0 && (
          <h2 className="px-2.5 pt-4 pb-1 text-xs font-medium text-muted-foreground/80">Threads</h2>
        )}
        {sorted.map((task) => {
          const isOpen = task.id === openTaskId
          return (
            <div key={task.id} className="group/thread relative mt-0.5 flex min-w-0">
              <NavLink
                to={threadPath(task.id)}
                title={[task.title, ...task.checkouts.map((checkout) => `${checkout.repo} · ${checkout.branch}`)].join(
                  "\n",
                )}
                className={(s) => cn(tabClass(s), "flex-1 items-start py-2 pr-9 pl-2.5")}
              >
                <StatusIcon status={task.status} className="mt-0.5" />
                <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                  <FadingTitle text={task.title} />
                  <span className="text-xs text-muted-foreground">
                    {STATUS_LABEL[task.status]} · {formatAgo(task.updatedAt, now)}
                  </span>
                  {task.checkouts.length > 0 && (
                    <span className="flex flex-wrap gap-1 pt-0.5">
                      {task.checkouts.map((checkout) => (
                        <span
                          key={checkout.id}
                          title={checkout.repo}
                          className="rounded-full bg-white/[0.06] px-1.5 py-px font-mono text-[0.65rem] text-muted-foreground"
                        >
                          {repoShortName(checkout.repo)}
                          {checkout.pullRequest ? ` #${checkout.pullRequest.number}` : null}
                        </span>
                      ))}
                    </span>
                  )}
                </span>
              </NavLink>
              <Button
                variant="ghost"
                size="icon"
                className={cn(
                  "absolute top-1.5 right-1.5 size-7 transition-opacity",
                  isOpen ? "opacity-100" : "opacity-0 group-hover/thread:opacity-100 focus-visible:opacity-100",
                )}
                aria-label="Archive thread"
                title="Archive thread"
                disabled={archive.isPending && archive.variables === task.id}
                onClick={() => archiveThread(task)}
              >
                <ArchiveBoxIcon />
              </Button>
            </div>
          )
        })}
      </nav>
      <div className="pt-2 pr-3">
        <AccountMenu />
      </div>
    </div>
  )
}

/** The Kestrel mark, linking to a new chat. */
function HomeMark({ className }: { className?: string }) {
  return (
    <NavLink
      to={APP_HOME}
      aria-label="Kestrel home"
      className={cn("shrink-0 rounded text-foreground/90 transition-colors duration-200 hover:text-foreground", className)}
    >
      <KestrelMark className="h-6" />
    </NavLink>
  )
}

/** Archive box: lid, body and handle slot. Drawn inline so the row button needs no icon import. */
function ArchiveBoxIcon() {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 24 24"
      width="16"
      height="16"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <rect x="2.5" y="3.5" width="19" height="5" rx="1" />
      <path d="M4.5 8.5v10a2 2 0 0 0 2 2h11a2 2 0 0 0 2-2v-10" />
      <path d="M10 12.5h4" />
    </svg>
  )
}
