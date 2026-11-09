import type { Run, Task } from "@cloudagents/protocol"

/**
 * The one "is this thread still working?" selector, shared by the sidebar and the chat/delegation cards. A thread is
 * working while the agent is engaged: the box reports `running`, the agent is waiting on an unanswered question
 * (`needs_input`), or a cached run is still live (a status frame can lag the run it describes).
 *
 * Archived threads are filtered by the caller: `archivedAt` is a separate gate, not a phase.
 */
export function isTaskWorking(task: Task, runs?: readonly Run[]): boolean {
  return task.status === "running" || task.status === "needs_input" || runs?.some((run) => run.status === "running") === true
}
