import { useCallback, useEffect, useRef, useState } from "react";
import { storage } from "@/lib/storage";

/** The same Markdown draft key as desktop; native storage is asynchronous. Mount one composer per key. */
export function useStoredDraft(key: string) {
  const storageKey = `kestrel.draft.${key}`;
  const [text, setTextState] = useState("");
  const [ready, setReady] = useState(false);
  const writes = useRef(Promise.resolve());

  useEffect(() => {
    let cancelled = false;
    void storage.getItem(storageKey).then((stored) => {
      if (cancelled) return;
      setTextState(stored ?? "");
      setReady(true);
    });
    return () => { cancelled = true; };
  }, [storageKey]);

  const setText = useCallback((next: string) => {
    setTextState(next);
    // Preserve edit/clear order even if a send navigates away before its storage write finishes.
    writes.current = writes.current.then(() => next === ""
      ? storage.deleteItem(storageKey)
      : storage.setItem(storageKey, next));
  }, [storageKey]);

  return [text, setText, ready] as const;
}
