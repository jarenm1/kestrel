import { useCallback, useEffect, useRef, useState } from "react";
import { storage } from "@/lib/storage";
import { Schema } from "effect";

/**
 * One pick (model or thinking level), remembered on the device so it survives switching threads and restarts.
 * `undefined` means the harness default and is stored as absence.
 */
export function useStoredChoice<A extends string>(key: string, schema: Schema.Schema<A>) {
  const [value, setValue] = useState<A | undefined>(undefined);
  const current = useRef<A | undefined>(undefined);
  const revision = useRef(0);

  useEffect(() => {
    let cancelled = false;
    const startedAt = revision.current;
    storage.getItem(key).then((stored) => {
      if (!cancelled && revision.current === startedAt && stored !== null && Schema.is(schema)(stored)) {
        current.current = stored;
        setValue(stored);
      }
    });
    return () => {
      cancelled = true;
    };
  }, [key, schema]);

  const choose = useCallback(
    (next: A | undefined) => {
      revision.current++;
      current.current = next;
      setValue(next);
      if (next === undefined) void storage.deleteItem(key);
      else void storage.setItem(key, next);
    },
    [key]
  );

  const clearIfUnchanged = useCallback(async (expected: A | undefined) => {
    const stored = await storage.getItem(key);
    if (current.current === expected && stored === (expected ?? null)) choose(undefined);
  }, [key, choose]);
  return [value, choose, clearIfUnchanged] as const;
}
