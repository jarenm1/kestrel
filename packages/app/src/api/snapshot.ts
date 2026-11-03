import type { QueryClient, QueryKey } from "@tanstack/react-query"
import type { Task } from "@cloudagents/protocol"

/**
 * Fetches a list snapshot, keeping entries live events wrote while it was in flight: those are newer than the snapshot.
 * Every other entry the snapshot has wins, so one cached while no events arrived (a thread left mid-run keeps its run
 * as running) is corrected. Entries only in the cache stay.
 */
export async function fetchSnapshot<T extends { readonly id: string }>(
  client: QueryClient,
  key: QueryKey,
  fetch: () => Promise<readonly T[]>,
): Promise<T[]> {
  // Event writes replace an entry's object and structural sharing keeps untouched ones, so identity tells what changed.
  const before = new Set(client.getQueryData<readonly T[]>(key) ?? [])
  const snapshot = await fetch()
  const byId = new Map<string, T>()
  for (const item of snapshot) byId.set(item.id, item)
  for (const item of client.getQueryData<readonly T[]>(key) ?? []) {
    if (!byId.has(item.id) || !before.has(item)) byId.set(item.id, item)
  }
  return [...byId.values()]
}

/**
 * Fetches one task, keeping the task live events wrote while the fetch was in flight: it is newer than the snapshot.
 * The identity check matters more than for lists: every event writes a whole task object, and a thread opened while a
 * run is reporting context (or a socket reconnecting after the tab was hidden) would otherwise take the snapshot read
 * before that report and show it until the run's next one.
 */
export async function fetchTaskSnapshot(
  client: QueryClient,
  key: QueryKey,
  fetch: () => Promise<Task>,
): Promise<Task> {
  const before = client.getQueryData<Task>(key)
  const task = await fetch()
  const current = client.getQueryData<Task>(key)
  return current !== undefined && current !== before ? current : task
}
