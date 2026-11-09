/** A value a snapshot and a live-event cache both store by `id`. */
export interface Identified {
  readonly id: string
}

/**
 * Merges a list snapshot with the cache entries live events wrote while the snapshot was in flight.
 *
 * The caller takes `before` from the cache immediately before starting the fetch. Event writes replace an entry's
 * object (never mutate it), so a cached entry whose identity is not in `before` was written during the fetch and is
 * newer than the snapshot. Entries the snapshot lacks are kept after the snapshot's own, and entries the cache no
 * longer has are not resurrected.
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
  return [...byId.values()]
}
