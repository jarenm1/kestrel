import { useCallback, useState } from "react"
import { Schema } from "effect"

/**
 * One pick, remembered in localStorage so it survives switching threads and reloads. Writes go to storage directly
 * rather than from an effect: a send can resolve after its composer has unmounted, and that clear must still land.
 */
export function useStoredChoice<A extends string, I>(key: string, schema: Schema.Schema<A, I>) {
  const [value, setValue] = useState<A | undefined>(() => {
    const stored = localStorage.getItem(key)
    return stored !== null && Schema.is(schema)(stored) ? stored : undefined
  })
  const choose = useCallback(
    (next: A | undefined) => {
      setValue(next)
      if (next === undefined) localStorage.removeItem(key)
      else localStorage.setItem(key, next)
    },
    [key],
  )
  const clearIfUnchanged = useCallback((expected: A | undefined) => {
    if (localStorage.getItem(key) === (expected ?? null)) choose(undefined)
  }, [key, choose])
  return [value, choose, clearIfUnchanged] as const
}
