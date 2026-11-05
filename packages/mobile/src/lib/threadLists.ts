import type { Task } from "@cloudagents/protocol";

export interface ThreadGroups<E> {
  /** Active threads waiting on the user, newest first: the sidebar's list. */
  threads: E[];
  /** Active threads whose run is going, newest first: the working dock. */
  working: E[];
  /** Archived threads, which the sidebar only counts. */
  archivedCount: number;
}

/**
 * Splits every box's threads into the sidebar list and the working dock. A running thread leaves the list and appears
 * once in the dock; when its run ends (done, failed, needs input, idle) it returns to the list. Archived threads are
 * counted but never listed. Entries keep their box, so two boxes can hold threads with the same id without either one
 * being dropped. Both groups stay newest first by `updatedAt`, the field the thread list sorts by until `Task` grows a
 * `lastMessageAt`.
 */
export function groupThreads<E extends { task: Task }>(entries: readonly E[]): ThreadGroups<E> {
  const byRecent = [...entries].sort((a, b) => b.task.updatedAt.localeCompare(a.task.updatedAt));
  const active = byRecent.filter(({ task }) => task.archivedAt === undefined);
  return {
    threads: active.filter(({ task }) => task.status !== "running"),
    working: active.filter(({ task }) => task.status === "running"),
    archivedCount: byRecent.length - active.length,
  };
}
