export function errorText(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}

export function formatTime(iso: string): string {
  const date = new Date(iso)
  return Number.isNaN(date.getTime()) ? iso : date.toLocaleString()
}
