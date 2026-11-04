interface DraftStorage {
  getItem(key: string): Promise<string | null>;
  setItem(key: string, value: string): Promise<void>;
  deleteItem(key: string): Promise<void>;
}

/** Reads and writes for one draft stay ordered even when its composer unmounts and mounts again. */
export function createDraftStore(storage: DraftStorage) {
  const pending = new Map<string, Promise<unknown>>();

  function enqueue<T>(key: string, operation: () => Promise<T>): Promise<T> {
    const previous = pending.get(key) ?? Promise.resolve();
    // A failed operation rejects its caller, but must not permanently block later edits or reads.
    const result = previous.then(operation, operation);
    pending.set(key, result);
    const settled = () => { if (pending.get(key) === result) pending.delete(key); };
    void result.then(settled, settled);
    return result;
  }

  return {
    read: (key: string) => enqueue(key, () => storage.getItem(key)),
    write: (key: string, text: string) => enqueue(key, () => text === ""
      ? storage.deleteItem(key)
      : storage.setItem(key, text)),
  };
}
