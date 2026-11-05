import type { SaveQueue } from "./saveQueue";

/**
 * Saves a just-closed settings form still owes its box, by box-scoped cache key. A form reopened for the same box waits
 * for them before hydrating, so it cannot start from the GET it issued while an earlier PUT was still landing.
 */
const pending = new Map<string, Promise<void>>();

/** Registers a queue's current work under `key`; the entry clears when the queue goes quiet. */
export function trackSaveQueue(key: string, queue: Pick<SaveQueue<unknown>, "idle">): void {
  track(key, queue.idle());
}

/** Registers one write (a mutation that is not a queue) under `key`. */
export function trackSave(key: string, work: Promise<unknown>): void {
  track(key, work);
}

function track(key: string, work: Promise<unknown>): void {
  const previous = pending.get(key);
  const settled = (previous ?? Promise.resolve())
    .then(() => work)
    .then(
      () => undefined,
      () => undefined
    );
  pending.set(key, settled);
  void settled.finally(() => {
    if (pending.get(key) === settled) pending.delete(key);
  });
}

/** The work still owed to `key` by a form that closed, if any. */
export function pendingSaves(key: string): Promise<void> | undefined {
  return pending.get(key);
}
