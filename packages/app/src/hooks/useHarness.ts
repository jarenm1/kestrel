import { useCallback, useEffect, useState } from "react"
import { HARNESS_IDS, type HarnessId } from "@cloudagents/protocol"

/**
 * Which harnesses Connections enabled for this browser, and the harness a thread last used. Both live in
 * localStorage: Connections is the source of truth for availability, while a thread's pick stays with that thread.
 * A model's provider decides its harness, so a thread's harness is recorded when its model is picked; it never
 * changes another thread's route.
 */
const ENABLED_KEY = "kestrel.harnesses"
const THREAD_PREFIX = "kestrel.harness."
const EVENT = "kestrel:harnesses"

const isHarness = (value: unknown): value is HarnessId =>
  typeof value === "string" && (HARNESS_IDS as readonly string[]).includes(value)

const readEnabled = (): readonly HarnessId[] => {
  if (typeof localStorage === "undefined") return HARNESS_IDS
  const raw = localStorage.getItem(ENABLED_KEY)
  if (raw === null) return HARNESS_IDS
  try {
    const parsed: unknown = JSON.parse(raw)
    if (!Array.isArray(parsed)) return HARNESS_IDS
    // Keep catalog order and drop values a newer/older build does not know.
    return HARNESS_IDS.filter((harness) => parsed.includes(harness))
  } catch {
    return HARNESS_IDS
  }
}

const readThread = (taskId: string | undefined): HarnessId | undefined => {
  if (taskId === undefined || typeof localStorage === "undefined") return undefined
  const stored = localStorage.getItem(`${THREAD_PREFIX}${taskId}`)
  return isHarness(stored) ? stored : undefined
}

/** The harnesses enabled in Connections; all are enabled until the user turns one off. */
export function useEnabledHarnesses(): readonly [
  readonly HarnessId[],
  (next: readonly HarnessId[]) => void,
  (harness: HarnessId) => void,
] {
  const [enabled, setEnabledState] = useState<readonly HarnessId[]>(readEnabled)

  useEffect(() => {
    const sync = () => setEnabledState(readEnabled())
    window.addEventListener(EVENT, sync)
    window.addEventListener("storage", sync)
    return () => {
      window.removeEventListener(EVENT, sync)
      window.removeEventListener("storage", sync)
    }
  }, [])

  const setEnabled = useCallback((next: readonly HarnessId[]) => {
    const unique = HARNESS_IDS.filter((harness) => next.includes(harness))
    localStorage.setItem(ENABLED_KEY, JSON.stringify(unique))
    window.dispatchEvent(new Event(EVENT))
    setEnabledState(unique)
  }, [])

  const toggle = useCallback(
    (harness: HarnessId) => {
      const current = readEnabled()
      setEnabled(current.includes(harness) ? current.filter((h) => h !== harness) : [...current, harness])
    },
    [setEnabled],
  )

  return [enabled, setEnabled, toggle] as const
}

/** The harness a thread last used; undefined until a model is picked or its last run says which harness ran. */
export function useThreadHarness(taskId: string | undefined): readonly [HarnessId | undefined, (harness: HarnessId) => void] {
  const [harness, setHarnessState] = useState<HarnessId | undefined>(() => readThread(taskId))

  useEffect(() => {
    setHarnessState(readThread(taskId))
  }, [taskId])

  const remember = useCallback(
    (next: HarnessId) => {
      if (taskId !== undefined) localStorage.setItem(`${THREAD_PREFIX}${taskId}`, next)
      setHarnessState(next)
    },
    [taskId],
  )

  return [harness, remember] as const
}
