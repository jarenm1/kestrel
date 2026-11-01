import { useCallback, useState } from "react"

/**
 * The unsent text of one composer, kept in localStorage so it survives switching threads and reloads. Writes go to
 * storage directly rather than from an effect: a send can resolve after its composer has unmounted (it navigates on
 * success), and that clear must still reach storage.
 */
export function useStoredDraft(key: string) {
  const storageKey = `kestrel.draft.${key}`
  const [text, setTextState] = useState(() => localStorage.getItem(storageKey) ?? "")
  const setText = useCallback(
    (next: string) => {
      setTextState(next)
      if (next === "") localStorage.removeItem(storageKey)
      else localStorage.setItem(storageKey, next)
    },
    [storageKey],
  )
  return [text, setText] as const
}
