import type { Task } from "@cloudagents/protocol"

/**
 * Splits threads into top-level rows and the sub-threads each row lists under it. A thread is a sub-thread of the
 * thread that spawned it (`spawnedByTaskId`) or delegated it (`delegation.parentTaskId`) while that parent is in the
 * same list. A thread whose parent is archived, missing, or part of a parent cycle stays at the top level.
 */
export function groupSubThreads(active: readonly Task[]): { roots: Task[]; children: Map<string, Task[]> } {
  const ids = new Set(active.map((task) => task.id))
  const parents = new Map<string, string>()
  for (const task of active) {
    const parent = task.delegation?.parentTaskId ?? task.spawnedByTaskId
    if (parent !== undefined && parent !== task.id && ids.has(parent)) parents.set(task.id, parent)
  }
  const children = new Map<string, Task[]>()
  const roots = active.filter((task) => {
    const parent = parents.get(task.id)
    if (parent === undefined || inParentCycle(task.id, parents)) return true
    children.set(parent, [...(children.get(parent) ?? []), task])
    return false
  })
  return { roots, children }
}

/** Walks up from `id`; a thread in a cycle reaches itself again. */
function inParentCycle(id: string, parents: ReadonlyMap<string, string>): boolean {
  let current = parents.get(id)
  for (let steps = 0; current !== undefined && steps <= parents.size; steps++) {
    if (current === id) return true
    current = parents.get(current)
  }
  return false
}
