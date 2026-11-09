import type { Run, Task } from "@cloudagents/protocol"

/**
 * A thread waiting on the user: the agent asked a question (`task_ask`) and will not continue until it is answered.
 * Callers show these threads where the user can see them even when the Working dock is folded; they are not working.
 */
export function isTaskAwaitingUser(task: Task): boolean {
  return task.status === "needs_input"
}

/**
 * The one "is this thread still working?" selector, shared by the sidebar and the chat/delegation cards. A thread is
 * working while the agent is engaged: the box reports `running`, or a cached run is still live (a status frame can lag
 * the run it describes). A pending question is `isTaskAwaitingUser`, a separate state, not working.
 *
 * Archived threads are filtered by the caller: `archivedAt` is a separate gate, not a phase.
 */
export function isTaskWorking(task: Task, runs?: readonly Run[]): boolean {
  if (isTaskAwaitingUser(task)) return false
  return task.status === "running" || runs?.some((run) => run.status === "running") === true
}
