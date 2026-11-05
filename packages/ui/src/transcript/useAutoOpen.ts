import { useState } from "react"

/**
 * Open while `live` (the model is still working on it), closed once it is done; a toggle by the user takes over
 * from then on, so a block never folds while someone is reading it or reopens after they closed it.
 */
export function useAutoOpen(live: boolean): readonly [open: boolean, toggle: () => void] {
  const [userOpen, setUserOpen] = useState<boolean | null>(null)
  const open = userOpen ?? live
  return [open, () => setUserOpen(!open)]
}
