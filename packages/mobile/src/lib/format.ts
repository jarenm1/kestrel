import { githubReferenceLabel, parseGithubReferenceDraft } from "@cloudagents/composer/reference";

export { formatAgo, repoShortName } from "@cloudagents/ui/format";

export function errorText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** Time of day only (e.g. "14:05"), for chat turns. */
export function formatClock(iso: string): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? iso : date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
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

/** Bytes in binary units with a decimal for small values: "512 B", "1.5 MB", "12 GB". */
export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  return `${value < 10 ? value.toFixed(1) : Math.round(value)} ${units[unit]}`;
}

const TITLE_MAX = 60;

/** First line of the prompt, shortened, as the thread's title. */
export function threadTitle(text: string): string {
  const readable = parseGithubReferenceDraft(text).map((segment) => segment.type === "text"
    ? segment.text
    : githubReferenceLabel(segment.reference.kind, segment.reference.number)).join("");
  const line = (readable.split("\n", 1)[0] ?? "").replace(/\s+/g, " ").trim();
  return line.length > TITLE_MAX ? `${line.slice(0, TITLE_MAX - 1).trimEnd()}…` : line;
}
