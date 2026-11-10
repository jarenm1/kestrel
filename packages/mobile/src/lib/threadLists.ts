import { isTaskAwaitingUser, isTaskWorking, type Task } from "@cloudagents/protocol";

export interface ThreadGroups<E> {
  /**
   * Top-level threads waiting on the user (`needs_input`), themselves or through a sub-thread, newest first: the
   * "Needs input" group.
   */
  awaiting: E[];
  /** The other settled top-level threads, newest first: the sidebar's list. */
  threads: E[];
  /** Top-level threads whose run is going, newest first: the working dock. */
  working: E[];
  /** The sub-threads each thread lists under it, keyed by the parent's `threadKey`, newest first. */
  children: Map<string, E[]>;
}

/** Identifies a thread across boxes: two boxes can hold threads with the same id. */
export function threadKey(scope: string, taskId: string): string {
  return `${scope}:${taskId}`;
}

/**
 * Splits every box's threads the way the web sidebar does. Archived threads are never listed. A thread is a sub-thread
 * of the thread that spawned it (`spawnedByTaskId`) or delegated it (`delegation.parentTaskId`) while that parent is
 * listed on the same box; it moves with its parent instead of getting its own row. A sub-thread whose parent is
 * archived, missing or part of a parent cycle stays at the top level. Top-level threads split into those waiting on
 * the user, the working dock (running, or with a live run) and the rest; each returns to the list when it settles.
 * A thread with a sub-thread waiting on the user counts as waiting itself, even while it runs, so a question asked
 * deep in a delegation never hides under a settled or working parent.
 * Every group stays newest first by `updatedAt`, the field the thread list sorts by until `Task` grows a
 * `lastMessageAt`. `scope` names an entry's box.
 */
export function groupThreads<E extends { task: Task }>(entries: readonly E[], scope: (entry: E) => string): ThreadGroups<E> {
  const byRecent = [...entries].sort((a, b) => b.task.updatedAt.localeCompare(a.task.updatedAt));
  const active = byRecent.filter(({ task }) => task.archivedAt === undefined);
  const listed = new Set(active.map((entry) => threadKey(scope(entry), entry.task.id)));
  const parents = new Map<string, string>();
  for (const entry of active) {
    const parent = entry.task.delegation?.parentTaskId ?? entry.task.spawnedByTaskId;
    if (parent === undefined || parent === entry.task.id) continue;
    const parentKey = threadKey(scope(entry), parent);
    if (listed.has(parentKey)) parents.set(threadKey(scope(entry), entry.task.id), parentKey);
  }
  const children = new Map<string, E[]>();
  const roots = active.filter((entry) => {
    const key = threadKey(scope(entry), entry.task.id);
    const parent = parents.get(key);
    if (parent === undefined || inParentCycle(key, parents)) return true;
    children.set(parent, [...(children.get(parent) ?? []), entry]);
    return false;
  });
  const awaits = (entry: E) => isTaskAwaitingUser(entry.task) || hasSubThreadAwaitingUser(entry, children, scope);
  return {
    awaiting: roots.filter(awaits),
    threads: roots.filter((entry) => !awaits(entry) && !isTaskWorking(entry.task)),
    working: roots.filter((entry) => !awaits(entry) && isTaskWorking(entry.task)),
    children,
  };
}

/** Whether a sub-thread of `entry`, at any depth, is waiting on the user (`needs_input`). */
export function hasSubThreadAwaitingUser<E extends { task: Task }>(
  entry: E,
  children: ReadonlyMap<string, E[]>,
  scope: (entry: E) => string
): boolean {
  return (children.get(threadKey(scope(entry), entry.task.id)) ?? []).some(
    (child) => isTaskAwaitingUser(child.task) || hasSubThreadAwaitingUser(child, children, scope)
  );
}

/** Walks up from `key`; a thread in a cycle reaches itself again. */
function inParentCycle(key: string, parents: ReadonlyMap<string, string>): boolean {
  let current = parents.get(key);
  for (let steps = 0; current !== undefined && steps <= parents.size; steps++) {
    if (current === key) return true;
    current = parents.get(current);
  }
  return false;
}

/**
 * The sidebar search: a thread matches when its title, a checkout's repository or branch, or one of its sub-threads
 * does. `query` is already trimmed and lower-cased.
 */
export function matchesThreadQuery<E extends { task: Task }>(
  entry: E,
  query: string,
  children: ReadonlyMap<string, E[]>,
  scope: (entry: E) => string
): boolean {
  const { task } = entry;
  const fields = [task.title, ...task.checkouts.flatMap((c) => [c.repo, c.branch])];
  if (fields.some((field) => field.toLowerCase().includes(query))) return true;
  return (children.get(threadKey(scope(entry), task.id)) ?? []).some((child) =>
    matchesThreadQuery(child, query, children, scope)
  );
}
