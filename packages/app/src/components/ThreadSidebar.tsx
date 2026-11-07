import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode, type Ref } from "react"
import { AnimatePresence, LayoutGroup, MotionConfig, motion, useReducedMotion } from "framer-motion"
import { NavLink, useNavigate, useParams } from "react-router-dom"
import { Archive, ChevronDown, GitBranch, GitPullRequest, PanelLeftClose, SquarePen, Workflow } from "lucide-react"
import type { Task } from "@cloudagents/protocol"
import { AccountMenu } from "@/components/AccountMenu"
import { KestrelMark } from "@/components/KestrelMark"
import { ThreadAvatar } from "@/components/ThreadAvatar"
import { StatusIcon } from "@/components/StatusIcon"
import { Alert } from "@cloudagents/ui/alert"
import { Button } from "@cloudagents/ui/button"
import { useThreadArchive } from "@/hooks/useThreadArchive"
import { groupSubThreads } from "@/lib/subThreads"
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
/** Remembers that the user folded the working dock. */
const DOCK_COLLAPSED_KEY = "kestrel.workingDockCollapsed"

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
 * the hidden rest into view; the trailing padding lets the last characters land clear of the fade. `working`
 * sweeps a highlight across the text while the agent runs.
 */
function FadingTitle({ text, working }: { text: string; working: boolean }) {
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
        {/* Its own element: hover restyles the scrolling span, which would jolt an animation running on it. */}
        <span
          className={cn(
            working &&
              "motion-safe:animate-title-shimmer motion-safe:bg-[linear-gradient(90deg,var(--color-muted-foreground)_40%,var(--color-foreground)_50%,var(--color-muted-foreground)_60%)] motion-safe:bg-[length:250%_100%] motion-safe:bg-clip-text motion-safe:text-transparent",
          )}
        >
          {text}
        </span>
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
 * The user's threads (tasks) as vertical tabs, most recent first. Working threads need nothing from the user, so
 * they leave the list for a foldable dock at the bottom, above the account menu, and return to the list when the run
 * ends. Collapsed, it is an icon rail; the button that expands it again lives in the page panel (`WorkspaceLayout`).
 */
export function ThreadSidebar({ tasks, error, collapsed, onCollapse }: Props) {
  const now = useNow(CLOCK_TICK_MS)
  const navigate = useNavigate()
  const { taskId: openTaskId } = useParams()
  const { archive } = useThreadArchive()
  const [dockCollapsed, setDockCollapsed] = useState(() => localStorage.getItem(DOCK_COLLAPSED_KEY) === "1")
  useEffect(() => {
    if (dockCollapsed) localStorage.setItem(DOCK_COLLAPSED_KEY, "1")
    else localStorage.removeItem(DOCK_COLLAPSED_KEY)
  }, [dockCollapsed])

  // TODO: order by the user's last message, not updatedAt (which also moves when a run finishes);
  // needs a `lastMessageAt` on Task from the server. The "ago" label has the same caveat.
  const byRecent = [...(tasks ?? [])].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
  const active = byRecent.filter((task) => task.archivedAt === undefined)
  const archivedCount = byRecent.length - active.length
  const { roots, children } = groupSubThreads(active)
  const threads = roots.filter((task) => task.status !== "running")
  const working = roots.filter((task) => task.status === "running")

  function archiveThread(task: Task) {
    archive.mutate(task.id, {
      // The open thread leaves the list; go back to the empty chat.
      onSuccess: () => {
        if (task.id === openTaskId) navigate(APP_HOME)
      },
    })
  }

  function railTab(task: Task) {
    return (
      <motion.div
        key={task.id}
        layout="position"
        layoutId={`rail-${task.id}`}
        {...FADE}
        className="flex shrink-0 flex-col"
      >
        <NavLink
          to={threadPath(task.id)}
          aria-label={`${task.title || "Untitled thread"} — ${STATUS_LABEL[task.status]}`}
          title={`${task.title || "Untitled thread"}\n${STATUS_LABEL[task.status]} · ${formatAgo(task.updatedAt, now)}`}
          className={(s) => cn(tabClass(s), "justify-center py-1.5")}
        >
          <span className="relative inline-flex">
            <ThreadAvatar task={task} />
            <span className="absolute -right-1.5 -bottom-1.5 flex size-5 items-center justify-center rounded-full bg-[radial-gradient(closest-side,var(--secondary)_55%,transparent)]">
              <StatusIcon status={task.status} className="[&>svg]:size-3" />
            </span>
          </span>
        </NavLink>
      </motion.div>
    )
  }

  function threadTab(task: Task) {
    return (
      <ThreadGroup
        key={task.id}
        task={task}
        now={now}
        openTaskId={openTaskId}
        childrenByParent={children}
        archivingId={archive.isPending ? archive.variables : undefined}
        onArchive={archiveThread}
      />
    )
  }

  if (collapsed) {
    return (
      <SidebarMotion>
        <div className="flex w-12 shrink-0 flex-col gap-1 pb-3 pl-2">
          <HomeMark className="self-center py-0.5" />
          <motion.nav
            layoutScroll
            aria-label="Threads"
            className="relative flex min-h-0 flex-1 flex-col items-stretch gap-1 overflow-auto"
          >
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
            <AnimatePresence initial={false} mode="popLayout">
              {threads.map(railTab)}
            </AnimatePresence>
          </motion.nav>
          <AnimatePresence initial={false}>
            {working.length > 0 && (
              <motion.nav
                key="working"
                layoutScroll
                aria-label="Working threads"
                {...REVEAL}
                className="relative mr-1 flex max-h-[40%] shrink-0 flex-col items-stretch gap-1 overflow-auto border-t border-border/60 pt-1"
              >
                <AnimatePresence initial={false} mode="popLayout">
                  {working.map(railTab)}
                </AnimatePresence>
              </motion.nav>
            )}
          </AnimatePresence>
          <AccountMenu compact />
        </div>
      </SidebarMotion>
    )
  }

  return (
    <SidebarMotion>
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
        <motion.nav
          layoutScroll
          aria-label="Threads"
          className="relative flex min-h-0 flex-1 flex-col gap-0.5 overflow-auto"
        >
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
          {threads.length > 0 && (
            <h2 className="px-2.5 pt-4 pb-1 text-xs font-medium text-muted-foreground/80">Threads</h2>
          )}
          <AnimatePresence initial={false} mode="popLayout">
            {threads.map(threadTab)}
          </AnimatePresence>
        </motion.nav>
        <AnimatePresence initial={false}>
          {working.length > 0 && (
            <motion.section
              key="working"
              aria-label="Working threads"
              {...REVEAL}
              className="flex max-h-[45%] shrink-0 flex-col overflow-hidden border-t border-border/60"
            >
              <button
                type="button"
                aria-expanded={!dockCollapsed}
                aria-controls="working-dock"
                onClick={() => setDockCollapsed((c) => !c)}
                className="mt-1 mr-3 flex items-center gap-1.5 rounded-[0.5rem] px-2.5 py-1.5 text-xs font-medium text-muted-foreground/80 transition-colors hover:bg-white/[0.03] hover:text-foreground"
              >
                <StatusIcon status="running" className="[&>svg]:size-3.5" />
                <span className="flex-1 text-left">Working</span>
                <span className="tabular-nums">{working.length}</span>
                <ChevronDown
                  aria-hidden="true"
                  className={cn("size-3.5 shrink-0 transition-transform", dockCollapsed && "-rotate-90")}
                />
              </button>
              {/* Folds to zero height but stays mounted, so the toggle's `aria-controls` always names an element;
                  `inert` takes the folded rows out of the tab order and the accessibility tree. */}
              <motion.div
                id="working-dock"
                layoutScroll
                inert={dockCollapsed}
                initial={false}
                animate={dockCollapsed ? { height: 0, opacity: 0 } : { height: "auto", opacity: 1 }}
                className="relative flex min-h-0 flex-col gap-0.5 overflow-auto"
              >
                <AnimatePresence initial={false} mode="popLayout">
                  {working.map(threadTab)}
                </AnimatePresence>
              </motion.div>
            </motion.section>
          )}
        </AnimatePresence>
        <div className="pt-2 pr-3">
          <AccountMenu />
        </div>
      </div>
    </SidebarMotion>
  )
}

function hasActiveDescendant(id: string, childrenByParent: Map<string, Task[]>): boolean {
  return (childrenByParent.get(id) ?? []).some((child) => child.status === "running" || child.status === "needs_input" || hasActiveDescendant(child.id, childrenByParent))
}

function ThreadGroup({ task, sub = false, now, openTaskId, childrenByParent, archivingId, onArchive }: {
  task: Task
  sub?: boolean
  now: number
  openTaskId: string | undefined
  childrenByParent: Map<string, Task[]>
  archivingId: string | undefined
  onArchive: (task: Task) => void
}) {
  const children = childrenByParent.get(task.id) ?? []
  const hasActive = hasActiveDescendant(task.id, childrenByParent)
  const [expanded, setExpanded] = useState(hasActive)
  const previousActive = useRef(hasActive)
  useEffect(() => {
    if (previousActive.current !== hasActive) setExpanded(hasActive)
    previousActive.current = hasActive
  }, [hasActive])
  return (
    <div className="min-w-0">
      {sub ? (
        <SubThreadTab task={task} />
      ) : (
        <ThreadTab task={task} now={now} isOpen={task.id === openTaskId} archiving={archivingId === task.id} onArchive={() => onArchive(task)} />
      )}
      {children.length > 0 && (
        <div className="ml-4 border-l border-border/70 pl-2">
          <button type="button" aria-expanded={expanded} onClick={() => setExpanded(!expanded)} className="flex w-full items-center gap-1 rounded px-1 py-1 text-left text-xs text-muted-foreground hover:text-foreground">
            <ChevronDown aria-hidden="true" className={cn("size-3 transition-transform", !expanded && "-rotate-90")} />
            {children.length} {children.length === 1 ? "sub-thread" : "sub-threads"}
          </button>
          {expanded && children.map((child) => <ThreadGroup key={child.id} sub task={child} now={now} openTaskId={openTaskId} childrenByParent={childrenByParent} archivingId={archivingId} onArchive={onArchive} />)}
        </div>
      )}
    </div>
  )
}

/** Rows fade in and out as they join or leave a list; `layout` slides the rest into place. */
const FADE = { initial: { opacity: 0 }, animate: { opacity: 1 }, exit: { opacity: 0 } } as const
/**
 * The working dock fades in at full height: growing it would move the row sliding into it after that row measured
 * its destination, so the row would land short and snap. Leaving, nothing slides into it, so it folds away.
 */
const REVEAL = {
  initial: { opacity: 0 },
  animate: { opacity: 1 },
  exit: { height: 0, opacity: 0 },
} as const
const SPRING = { type: "spring", bounce: 0, duration: 0.3 } as const

/**
 * Shares one `LayoutGroup` across the list, the dock and the rail, so a thread whose run starts or ends slides
 * between them (rows carry a `layoutId`) instead of vanishing from one and appearing in the other. Users who ask
 * for reduced motion get the end state at once.
 */
function SidebarMotion({ children }: { children: ReactNode }) {
  const reduce = useReducedMotion()
  return (
    <MotionConfig transition={reduce ? { duration: 0 } : SPRING}>
      <LayoutGroup>{children}</LayoutGroup>
    </MotionConfig>
  )
}

interface ThreadTabProps {
  ref?: Ref<HTMLDivElement>
  task: Task
  now: number
  isOpen: boolean
  archiving: boolean
  onArchive: () => void
}

/**
 * One thread in the expanded sidebar: repo and age, title, branch and status, with an archive button on hover.
 * Takes a `ref` because `AnimatePresence`'s `popLayout` measures the row it lifts out.
 */
function ThreadTab({ ref, task, now, isOpen, archiving, onArchive }: ThreadTabProps) {
  const [checkout, ...otherCheckouts] = task.checkouts
  return (
    <motion.div
      ref={ref}
      layout="position"
      layoutId={`thread-${task.id}`}
      {...FADE}
      className="group/thread relative mt-0.5 flex min-w-0 shrink-0"
    >
      <NavLink
        to={threadPath(task.id)}
        title={[task.title, ...task.checkouts.map((c) => `${c.repo} · ${c.branch}`)].join("\n")}
        className={(s) => cn(tabClass(s), "flex-1 flex-col gap-1 py-2 pr-2.5 pl-2.5")}
      >
        <span className="flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground">
          <ThreadAvatar task={task} small />
          <span className="min-w-0 flex-1 truncate">
            {checkout ? repoShortName(checkout.repo) : null}
            {otherCheckouts.length > 0 ? ` +${otherCheckouts.length}` : null}
          </span>
          {/* The archive button takes this corner on hover and on the open thread. */}
          <span
            className={cn(
              "shrink-0 tabular-nums transition-opacity",
              isOpen ? "opacity-0" : "group-hover/thread:opacity-0 group-has-[button:focus-visible]/thread:opacity-0",
            )}
          >
            {formatAgo(task.updatedAt, now)}
          </span>
        </span>
        <FadingTitle text={task.title} working={task.status === "running"} />
        <span className="flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground">
          {checkout ? (
            <>
              {checkout.pullRequest ? (
                <GitPullRequest aria-hidden="true" className="size-3.5 shrink-0" />
              ) : (
                <GitBranch aria-hidden="true" className="size-3.5 shrink-0" />
              )}
              <span className="min-w-0 flex-1 truncate">
                {checkout.branch}
                {checkout.pullRequest ? ` #${checkout.pullRequest.number}` : null}
              </span>
            </>
          ) : (
            <span className="min-w-0 flex-1 truncate">{STATUS_LABEL[task.status]}</span>
          )}
          <StatusIcon status={task.status} className="[&>svg]:size-3.5" />
        </span>
      </NavLink>
      <Button
        variant="ghost"
        size="icon"
        className={cn(
          "absolute top-1 right-1 size-6 transition-opacity",
          isOpen ? "opacity-100" : "opacity-0 group-hover/thread:opacity-100 focus-visible:opacity-100",
        )}
        aria-label="Archive thread"
        title="Archive thread"
        disabled={archiving}
        onClick={onArchive}
      >
        <ArchiveBoxIcon />
      </Button>
    </motion.div>
  )
}

/** A sub-thread under its parent: only the title and its status, so the list stays short while work runs. */
function SubThreadTab({ task }: { task: Task }) {
  const title = task.title || "Untitled thread"
  return (
    <NavLink
      to={threadPath(task.id)}
      title={`${title}\n${STATUS_LABEL[task.status]}`}
      className={(s) => cn(tabClass(s), "items-center py-1.5 pr-2.5 pl-2 text-xs")}
    >
      <span className="min-w-0 flex-1 truncate">{title}</span>
      <StatusIcon status={task.status} className="shrink-0 [&>svg]:size-3.5" />
    </NavLink>
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
