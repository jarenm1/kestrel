import { useCallback, useEffect, useState } from "react";
import * as SecureStore from "expo-secure-store";
import { Schema } from "effect";

/**
 * One pick (model or thinking level), remembered in secure storage so it survives switching threads and restarts.
 * `undefined` means the harness default and is stored as absence.
 */
export function useStoredChoice<A extends string>(key: string, schema: Schema.Schema<A>) {
  const [value, setValue] = useState<A | undefined>(undefined);

  useEffect(() => {
    let cancelled = false;
    SecureStore.getItemAsync(key).then((stored) => {
      if (!cancelled && stored !== null && Schema.is(schema)(stored)) setValue(stored);
    });
    return () => {
      cancelled = true;
    };
  }, [key, schema]);

  const choose = useCallback(
    (next: A | undefined) => {
      setValue(next);
      if (next === undefined) void SecureStore.deleteItemAsync(key);
      else void SecureStore.setItemAsync(key, next);
    },
    [key]
  );

  return [value, choose] as const;
}
