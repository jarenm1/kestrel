import { useSyncExternalStore } from "react"

/** Wide screens that have not asked for reduced motion. Phones and reduced-motion users toggle sidebars instantly. */
const QUERY = window.matchMedia("(min-width: 768px) and (prefers-reduced-motion: no-preference)")

function subscribe(onChange: () => void) {
  QUERY.addEventListener("change", onChange)
  return () => QUERY.removeEventListener("change", onChange)
}

/** Whether the thread list and the thread's sidebar animate as they open and close. */
export function useSidebarAnimation(): boolean {
  return useSyncExternalStore(subscribe, () => QUERY.matches)
}
