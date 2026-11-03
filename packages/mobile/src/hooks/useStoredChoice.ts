import { useCallback, useEffect, useState } from "react";
import { storage } from "@/lib/storage";
import { Schema } from "effect";

/**
 * One pick (model or thinking level), remembered on the device so it survives switching threads and restarts.
 * `undefined` means the harness default and is stored as absence.
 */
export function useStoredChoice<A extends string>(key: string, schema: Schema.Schema<A>) {
  const [value, setValue] = useState<A | undefined>(undefined);

  useEffect(() => {
    let cancelled = false;
    storage.getItem(key).then((stored) => {
      if (!cancelled && stored !== null && Schema.is(schema)(stored)) setValue(stored);
    });
    return () => {
      cancelled = true;
    };
  }, [key, schema]);

  const choose = useCallback(
    (next: A | undefined) => {
      setValue(next);
      if (next === undefined) void storage.deleteItem(key);
      else void storage.setItem(key, next);
    },
    [key]
  );

  return [value, choose] as const;
}
