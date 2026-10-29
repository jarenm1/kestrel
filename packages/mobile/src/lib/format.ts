export function errorText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** Time of day only (e.g. "14:05"), for chat turns. */
export function formatClock(iso: string): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? iso : date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

/** Coarse time since `iso` relative to `now` (ms): "just now", "5m ago", "3h ago", "2d ago". */
export function formatAgo(iso: string, now: number): string {
  const seconds = Math.max(0, (now - new Date(iso).getTime()) / 1000);
  if (Number.isNaN(seconds)) return iso;
  if (seconds < 60) return "just now";
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86_400) return `${Math.floor(seconds / 3600)}h ago`;
  return `${Math.floor(seconds / 86_400)}d ago`;
}

/** Time a run has been going, from `startMs` to `now`: "12s", "3m 4s", "1h 0m 5s". Minutes and hours show only once reached. */
export function formatElapsed(startMs: number, now: number): string {
  const total = Math.max(0, Math.floor((now - startMs) / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (h > 0) return `${h}h ${m}m ${s}s`;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
}

/** Short name of a checkout's repository: "owner/name" → "name". */
export function repoShortName(repo: string): string {
  return (repo.split("/").pop() ?? repo).replace(/\.git$/, "");
}

const TITLE_MAX = 60;

/** First line of the prompt, shortened, as the thread's title. */
export function threadTitle(text: string): string {
  const line = (text.split("\n", 1)[0] ?? "").replace(/\s+/g, " ").trim();
  return line.length > TITLE_MAX ? `${line.slice(0, TITLE_MAX - 1).trimEnd()}…` : line;
}
