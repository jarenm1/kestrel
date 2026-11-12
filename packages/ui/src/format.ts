/** Coarse time since `iso` relative to `now` (ms): "just now", "5m ago", "3h ago", "2d ago". */
export function formatAgo(iso: string, now: number): string {
  const seconds = Math.max(0, (now - new Date(iso).getTime()) / 1000);
  if (Number.isNaN(seconds)) return iso;
  if (seconds < 60) return "just now";
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86_400) return `${Math.floor(seconds / 3600)}h ago`;
  return `${Math.floor(seconds / 86_400)}d ago`;
}

/** Short name of a checkout's repository: "owner/name" → "name". */
export function repoShortName(repo: string): string {
  return (repo.split("/").pop() ?? repo).replace(/\.git$/, "");
}
