import { useEffect, useState } from "react"
import { Schema } from "effect"

/** One pick, remembered in localStorage so it survives switching threads and reloads. */
export function useStoredChoice<A extends string>(key: string, schema: Schema.Schema<A>) {
  const [value, setValue] = useState<A | undefined>(() => {
    const stored = localStorage.getItem(key)
    return stored !== null && Schema.is(schema)(stored) ? stored : undefined
  })
  useEffect(() => {
    if (value === undefined) localStorage.removeItem(key)
    else localStorage.setItem(key, value)
  }, [key, value])
  return [value, setValue] as const
}
