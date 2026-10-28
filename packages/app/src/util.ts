export function errorText(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}

export function formatTime(iso: string): string {
  const date = new Date(iso)
  return Number.isNaN(date.getTime()) ? iso : date.toLocaleString()
}

/** Time of day only (e.g. "14:05"), for chat turns. */
export function formatClock(iso: string): string {
  const date = new Date(iso)
  return Number.isNaN(date.getTime()) ? iso : date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
}
