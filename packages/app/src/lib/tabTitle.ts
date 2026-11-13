import { isTaskAwaitingUser, isTaskWorking, type Task } from "@cloudagents/protocol"
import { groupSubThreads } from "@/lib/subThreads"

export const APP_TITLE = "Kestrel"

/** What the tab title counts: the sidebar's top-level threads, so the numbers match its Working dock and Needs input. */
export interface TitleThreads {
  readonly working: ReadonlySet<string>
  readonly awaiting: ReadonlySet<string>
  /** Every unarchived top-level thread by id. */
  readonly byId: ReadonlyMap<string, Task>
}

export function titleThreads(tasks: readonly Task[]): TitleThreads {
  const { roots } = groupSubThreads(tasks.filter((task) => task.archivedAt === undefined))
  return {
    working: new Set(roots.filter((task) => isTaskWorking(task)).map((task) => task.id)),
    awaiting: new Set(roots.filter(isTaskAwaitingUser).map((task) => task.id)),
    byId: new Map(roots.map((task) => [task.id, task])),
  }
}

/**
 * Threads that finished since this tab saw them working and that the user has not opened since. A thread joins when it
 * leaves `previousWorking` as done or failed, and leaves when it is opened, archived, or starts another run. A thread
 * already done when the tab loaded never counts: the tab cannot tell whether the user has seen it.
 */
export function nextFinished(
  finished: ReadonlySet<string>,
  previousWorking: ReadonlySet<string>,
  threads: TitleThreads,
  openTaskId: string | undefined,
): ReadonlySet<string> {
  const next = new Set<string>()
  for (const id of [...finished, ...previousWorking]) {
    if (id === openTaskId || threads.working.has(id)) continue
    const status = threads.byId.get(id)?.status
    if (status === "done" || status === "failed") next.add(id)
  }
  return next
}

/** `Kestrel • 3 Working, 1 Needs input, 1 Done`; plain `Kestrel` when nothing is going on. */
export function tabTitle(threads: TitleThreads, finished: ReadonlySet<string>): string {
  let done = 0
  let failed = 0
  for (const id of finished) {
    if (threads.byId.get(id)?.status === "failed") failed++
    else done++
  }
  const parts = [
    [threads.working.size, "Working"],
    [threads.awaiting.size, "Needs input"],
    [done, "Done"],
    [failed, "Failed"],
  ] as const
  const status = parts
    .filter(([count]) => count > 0)
    .map(([count, label]) => `${count} ${label}`)
    .join(", ")
  return status ? `${APP_TITLE} • ${status}` : APP_TITLE
}
