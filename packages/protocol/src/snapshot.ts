/** A value a snapshot and a live-event cache both store by `id`. */
export interface Identified {
  readonly id: string
}

/**
 * Merges one live run update into its cached run. A `run.updated` event carries the run as the state store has it,
 * and the store never holds saved evidence: clips live on the box's disk and are filled into run snapshots only. So
 * an update without `evidence` keeps the cached clips, and one that has evidence is a full snapshot and replaces them.
 */
export const mergeRunUpdate = <T extends Identified & { readonly evidence?: unknown }>(
  cached: T | undefined,
  update: T,
): T => (update.evidence === undefined && cached?.evidence !== undefined ? { ...update, evidence: cached.evidence } : update)

/**
 * Merges a list snapshot with the cache entries live events wrote while the snapshot was in flight.
 *
 * The caller takes `before` from the cache immediately before starting the fetch. Event writes replace an entry's
 * object (never mutate it), so a cached entry whose identity is not in `before` was written during the fetch and is
 * newer than the snapshot. Entries the snapshot lacks are kept after the snapshot's own, and an entry that was cached
 * before the fetch but is gone from the cache afterwards is not resurrected: its removal is newer than the snapshot.
 *
 * This is the pure half of `fetchSnapshot` in `packages/app/src/api/snapshot.ts`; the web and phone clients should
 * call it rather than maintaining separate copies.
 */
export const mergeSnapshot = <T extends Identified>(
  snapshot: readonly T[],
  cached: readonly T[],
  before: ReadonlySet<T>,
): T[] => {
  const byId = new Map<string, T>()
  for (const item of snapshot) byId.set(item.id, item)
  for (const item of cached) {
    if (!byId.has(item.id) || !before.has(item)) byId.set(item.id, item)
  }
  const cachedIds = new Set(cached.map((item) => item.id))
  const removed = new Set([...before].filter((item) => !cachedIds.has(item.id)).map((item) => item.id))
  return [...byId.values()].filter((item) => !removed.has(item.id))
}
