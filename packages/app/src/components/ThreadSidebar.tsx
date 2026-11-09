import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode, type Ref } from "react"
import { AnimatePresence, LayoutGroup, MotionConfig, motion, useReducedMotion } from "framer-motion"
import { NavLink, useNavigate, useParams } from "react-router-dom"
import {
  Archive,
  ChevronDown,
  GitBranch,
  GitPullRequest,
  PanelLeftClose,
  PanelLeftOpen,
  SquarePen,
  Workflow,
  type LucideIcon,
} from "lucide-react"
import type { Task } from "@cloudagents/protocol"
import { AccountMenu } from "@/components/AccountMenu"
import { KestrelMark } from "@/components/KestrelMark"
import { ThreadAvatar } from "@/components/ThreadAvatar"
import { StatusIcon } from "@/components/StatusIcon"
import { Alert } from "@cloudagents/ui/alert"
import { Button } from "@cloudagents/ui/button"
import { useSidebarAnimation } from "@/hooks/useSidebarAnimation"
import { useThreadArchive } from "@/hooks/useThreadArchive"
import { groupSubThreads } from "@/lib/subThreads"
import { isTaskAwaitingUser, isTaskWorking } from "@cloudagents/protocol"
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
  onExpand: () => void
}

/**
 * The user's threads (tasks) as vertical tabs, most recent first. Working threads (running, or with a live run) leave
 * the list for a foldable dock at the bottom, above the account menu; threads waiting on the user (`needs_input`) get
 * their own always-visible group. Both return to the list when they settle. Collapsed, the sidebar is an icon rail;
 * the Kestrel mark doubles as the toggle that collapses and expands it. On wide screens the strip slides between the
 * two widths while the list and the rail crossfade.
 */
export function ThreadSidebar({ tasks, error, collapsed, onCollapse, onExpand }: Props) {
  const now = useNow(CLOCK_TICK_MS)
  const navigate = useNavigate()
  const { taskId: openTaskId } = useParams()
  const { archive } = useThreadArchive()
  const animated = useSidebarAnimation()
  // The list and the rail swap through `SidebarMotion`'s `AnimatePresence`; on narrow screens they swap at once.
  const swap = { ...FADE, transition: animated ? SLIDE : INSTANT }
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
  const awaiting = roots.filter((task) => isTaskAwaitingUser(task))
  const threads = roots.filter((task) => !isTaskWorking(task) && !isTaskAwaitingUser(task))
  const working = roots.filter((task) => isTaskWorking(task))

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
      <SidebarMotion collapsed>
        <motion.div key="rail" {...swap} className="absolute inset-y-0 left-0 flex w-12 flex-col gap-1 pb-3 pl-2">
          <BrandToggle label="Expand threads" Icon={PanelLeftOpen} onClick={onExpand} className="self-center" />
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
            {awaiting.length > 0 && (
              <motion.nav
                key="awaiting"
                layoutScroll
                aria-label="Threads needing input"
                {...REVEAL}
                className="relative mr-1 flex max-h-[30%] shrink-0 flex-col items-stretch gap-1 overflow-auto border-t border-border/60 pt-1"
              >
                <AnimatePresence initial={false} mode="popLayout">
                  {awaiting.map(railTab)}
                </AnimatePresence>
              </motion.nav>
            )}
          </AnimatePresence>
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
        </motion.div>
      </SidebarMotion>
    )
  }

  return (
    <SidebarMotion collapsed={false}>
      <motion.div key="list" {...swap} className="absolute inset-y-0 left-0 flex w-64 flex-col pb-3 pl-3">
        <div className="flex items-center gap-2 pb-2 pl-1.5">
          <BrandToggle label="Collapse threads" Icon={PanelLeftClose} onClick={onCollapse} />
          <span className="min-w-0 flex-1 truncate font-semibold tracking-tight">Kestrel</span>
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
          {awaiting.length > 0 && (
            <>
              <h2 className="flex items-center gap-1.5 px-2.5 pt-4 pb-1 text-xs font-medium text-muted-foreground/80">
                <StatusIcon status="needs_input" className="[&>svg]:size-3.5" />
                Needs input
                <span className="tabular-nums">{awaiting.length}</span>
              </h2>
              <AnimatePresence initial={false} mode="popLayout">
                {awaiting.map(threadTab)}
              </AnimatePresence>
            </>
          )}
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
      </motion.div>
    </SidebarMotion>
  )
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
  const [expanded, setExpanded] = useState(false)
  return (
    <div className="min-w-0">
      <div className="relative">
        {sub ? (
          <SubThreadTab task={task} hasChildren={children.length > 0} />
        ) : (
          <ThreadTab task={task} now={now} isOpen={task.id === openTaskId} archiving={archivingId === task.id} onArchive={() => onArchive(task)} hasChildren={children.length > 0} />
        )}
        {children.length > 0 && (
          <button
            type="button"
            aria-label={`${expanded ? "Collapse" : "Expand"} sub-threads for ${task.title || "Untitled thread"}`}
            aria-expanded={expanded}
            onClick={() => setExpanded(!expanded)}
            className="absolute left-1 bottom-1 flex size-6 items-center justify-center rounded text-muted-foreground hover:bg-white/[0.06] hover:text-foreground"
          >
            <ChevronDown aria-hidden="true" className={cn("size-3.5 transition-transform", !expanded && "-rotate-90")} />
          </button>
        )}
      </div>
      {children.length > 0 && expanded && (
        <div className="ml-4 border-l border-border/70 pl-2">
          {children.map((child) => <ThreadGroup key={child.id} sub task={child} now={now} openTaskId={openTaskId} childrenByParent={childrenByParent} archivingId={archivingId} onArchive={onArchive} />)}
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
const INSTANT = { duration: 0 } as const
/** Collapsing and expanding: the same curve and length as the thread sidebar's slide in `ThreadView`. */
const SLIDE = { duration: 0.3, ease: [0.22, 1, 0.36, 1] } as const
/** Widths of the collapsed rail (`w-12`) and the expanded list (`w-64`). */
const RAIL_WIDTH = 48
const LIST_WIDTH = 256

/**
 * Shares one `LayoutGroup` across the list, the dock and the rail, so a thread whose run starts or ends slides
 * between them (rows carry a `layoutId`) instead of vanishing from one and appearing in the other. Users who ask
 * for reduced motion get the end state at once.
 *
 * Both branches of `ThreadSidebar` render it at the same place, so it survives collapsing and expanding: its width
 * slides between the rail and the list (wide screens only) and its `AnimatePresence` keeps the leaving one, pinned
 * to the left edge and clipped, while it fades out.
 */
function SidebarMotion({ collapsed, children }: { collapsed: boolean; children: ReactNode }) {
  const reduce = useReducedMotion()
  const animated = useSidebarAnimation()
  return (
    <MotionConfig transition={reduce ? INSTANT : SPRING}>
      <LayoutGroup>
        <motion.div
          initial={false}
          animate={{ width: collapsed ? RAIL_WIDTH : LIST_WIDTH }}
          transition={animated ? SLIDE : INSTANT}
          className="relative shrink-0 overflow-hidden"
        >
          <AnimatePresence initial={false}>{children}</AnimatePresence>
        </motion.div>
      </LayoutGroup>
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
  hasChildren: boolean
}

/**
 * One thread in the expanded sidebar: repo and age, title, branch and status, with an archive button on hover.
 * Takes a `ref` because `AnimatePresence`'s `popLayout` measures the row it lifts out.
 */
function ThreadTab({ ref, task, now, isOpen, archiving, onArchive, hasChildren }: ThreadTabProps) {
  const [checkout, ...otherCheckouts] = task.checkouts
  const pullRequest = checkout === undefined ? undefined : (task.pullRequests ?? []).filter((pr) => pr.checkoutId === checkout.id).at(-1)
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
        <FadingTitle text={task.title} working={isTaskWorking(task)} />
        <span className={cn("flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground", hasChildren && "pl-6")}>
          {checkout ? (
            <>
              {pullRequest ? (
                <GitPullRequest aria-hidden="true" className="size-3.5 shrink-0" />
              ) : (
                <GitBranch aria-hidden="true" className="size-3.5 shrink-0" />
              )}
              <span className="min-w-0 flex-1 truncate">
                {checkout.branch}
                {pullRequest ? ` #${pullRequest.number}` : null}
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
function SubThreadTab({ task, hasChildren }: { task: Task; hasChildren: boolean }) {
  const title = task.title || "Untitled thread"
  return (
    <NavLink
      to={threadPath(task.id)}
      title={`${title}\n${STATUS_LABEL[task.status]}`}
      className={(s) => cn(tabClass(s), "items-center py-1.5 pr-2.5 text-xs", hasChildren ? "pl-8" : "pl-2")}
    >
      <span className="min-w-0 flex-1 truncate">{title}</span>
      <StatusIcon status={task.status} className="shrink-0 [&>svg]:size-3.5" />
    </NavLink>
  )
}

/**
 * The Kestrel mark doubling as the sidebar toggle: the bird at rest, the toggle icon once hovered or focused.
 */
function BrandToggle({
  label,
  Icon,
  onClick,
  className,
}: {
  label: string
  Icon: LucideIcon
  onClick: () => void
  className?: string
}) {
  return (
    <Button
      variant="ghost"
      size="icon"
      className={cn("group/brand relative size-7 text-foreground/90 hover:text-foreground", className)}
      aria-label={label}
      title={label}
      onClick={onClick}
    >
      <KestrelMark className="h-6 transition-opacity duration-200 group-hover/brand:opacity-0 group-focus-visible/brand:opacity-0" />
      <Icon className="absolute inset-0 m-auto opacity-0 transition-opacity duration-200 group-hover/brand:opacity-100 group-focus-visible/brand:opacity-100" />
    </Button>
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
