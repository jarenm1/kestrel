import { useRef } from "react"

const STORAGE_KEY = "kestrel.prompt-history"
const HISTORY_LIMIT = 100

function readHistory(): string[] {
  try {
    const stored: unknown = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "[]")
    return Array.isArray(stored)
      ? stored.filter((entry): entry is string => typeof entry === "string" && entry.trim() !== "").slice(-HISTORY_LIMIT)
      : []
  } catch {
    return []
  }
}

/** Accepted prompt text only: attachments and generated context are never replayed. */
export function usePromptHistory(draftKey: string) {
  const browsing = useRef<{
    key: string
    entries: string[]
    index: number
    draft: string
    shown: string
  } | undefined>(undefined)

  function remember(prompt: string) {
    browsing.current = undefined
    if (prompt.trim() === "") return
    const entries = readHistory()
    if (entries.at(-1) === prompt) return
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify([...entries, prompt].slice(-HISTORY_LIMIT)))
    } catch {
      // History is optional; unavailable/full storage must not turn an accepted send into an error.
    }
  }

  function isBrowsing(text: string): boolean {
    return browsing.current?.key === draftKey && browsing.current.shown === text
  }

  function navigate(direction: -1 | 1, text: string): string | undefined {
    let cursor = browsing.current
    // Editing a recalled prompt starts a new draft rather than silently discarding that edit on Down.
    if (!isBrowsing(text)) cursor = undefined
    if (cursor === undefined) {
      if (direction === 1) return undefined
      const entries = readHistory()
      if (entries.length === 0) return undefined
      cursor = { key: draftKey, entries, index: entries.length, draft: text, shown: text }
    }
    cursor.index = Math.max(0, Math.min(cursor.entries.length, cursor.index + direction))
    cursor.shown = cursor.entries[cursor.index] ?? cursor.draft
    browsing.current = cursor.index === cursor.entries.length ? undefined : cursor
    return cursor.shown
  }

  return { remember, navigate, isBrowsing }
}
