/**
 * Serializes writes to one destination (one box's settings): at most one save is in flight, and changes made while it
 * runs collapse into the latest snapshot, which is saved once the earlier one settles. A failed save is reported and
 * does not block a snapshot queued after it, so a rapid second edit can still reach the box.
 *
 * The queue is not stopped by unmounting: a caller that hands it a box-bound `save` keeps its accepted changes on
 * their way, updating that box even when the screen is gone.
 */
export interface SaveQueue<T> {
  /** Queues the newest snapshot; it replaces any snapshot that has not started saving yet. */
  push(value: T): void;
  /** Resolves when nothing is in flight or queued (used by tests and callers that wait for a quiet queue). */
  idle(): Promise<void>;
  /** Whether a save is in flight or a snapshot is waiting. */
  busy(): boolean;
}

export interface SaveQueueHandlers<T> {
  /** A save settled: `saved` is the box's accepted value, `snapshot` the value sent, `pending` whether more waits. */
  onSaved?: (saved: T, snapshot: T, pending: boolean) => void;
  /** A save failed; a snapshot queued after the failure still saves afterwards. */
  onError?: (error: unknown, pending: boolean) => void;
}

export function createSaveQueue<T>(
  save: (value: T) => Promise<T>,
  handlers: SaveQueueHandlers<T> = {}
): SaveQueue<T> {
  let queued: { value: T } | undefined;
  let draining = false;
  let waiters: (() => void)[] = [];

  function settle() {
    if (draining || queued !== undefined) return;
    const ready = waiters;
    waiters = [];
    for (const resolve of ready) resolve();
  }

  async function drain(): Promise<void> {
    if (draining) return;
    draining = true;
    try {
      while (queued !== undefined) {
        const { value } = queued;
        queued = undefined;
        try {
          const saved = await save(value);
          handlers.onSaved?.(saved, value, queued !== undefined);
        } catch (error) {
          handlers.onError?.(error, queued !== undefined);
        }
      }
    } finally {
      draining = false;
      settle();
      // A push that landed as the loop ended starts its own drain; this is the only way work survives the exit.
      if (queued !== undefined) void drain();
    }
  }

  return {
    push(value) {
      queued = { value };
      void drain();
    },
    idle() {
      if (!draining && queued === undefined) return Promise.resolve();
      const { promise, resolve } = Promise.withResolvers<void>();
      waiters.push(resolve);
      return promise;
    },
    busy() {
      return draining || queued !== undefined;
    },
  };
}
