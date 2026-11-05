import { useCallback, useEffect, useState } from "react";
import { createDraftStore } from "@/lib/draftStore";
import { storage } from "@/lib/storage";

// Shared across hook instances: a remount must not read ahead of the previous instance's pending writes.
const drafts = createDraftStore(storage);

/** The same Markdown draft key as desktop; native storage is asynchronous. Mount one composer per key. */
export function useStoredDraft(key: string) {
  const storageKey = `kestrel.draft.${key}`;
  const [text, setTextState] = useState("");
  const [ready, setReady] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void drafts.read(storageKey).then((stored) => {
      if (cancelled) return;
      setTextState(stored ?? "");
      setReady(true);
    });
    return () => { cancelled = true; };
  }, [storageKey]);

  const setText = useCallback((next: string) => {
    setTextState(next);
    // Callers opening another screen can await this write, including every earlier queued edit.
    return drafts.write(storageKey, next);
  }, [storageKey]);

  return [text, setText, ready] as const;
}
