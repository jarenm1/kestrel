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

/** Coarse time since `iso` relative to `now` (ms): "just now", "5m ago", "3h ago", "2d ago". */
export function formatAgo(iso: string, now: number): string {
  const seconds = Math.max(0, (now - new Date(iso).getTime()) / 1000)
  if (Number.isNaN(seconds)) return iso
  if (seconds < 60) return "just now"
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`
  if (seconds < 86_400) return `${Math.floor(seconds / 3600)}h ago`
  return `${Math.floor(seconds / 86_400)}d ago`
}

/** Short name of a checkout's repository: "owner/name" → "name". */
export function repoShortName(repo: string): string {
  return (repo.split("/").pop() ?? repo).replace(/\.git$/, "")
}

const TITLE_MAX = 60

/** First line of the prompt, shortened, as the thread's title (and branch name). */
export function threadTitle(text: string): string {
  const line = (text.split("\n", 1)[0] ?? "").replace(/\s+/g, " ").trim()
  return line.length > TITLE_MAX ? `${line.slice(0, TITLE_MAX - 1).trimEnd()}…` : line
}
