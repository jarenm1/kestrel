import { isUnreachableError } from "@/api/errors";
import { errorText } from "@/lib/format";

type Snapshot = { data: unknown; error: unknown };

/**
 * Chooses what a thread shows when its queries fail. Missing conversation content is a load failure, not an empty
 * chat, and never a floating offline banner; a transport failure over cached content stays quiet unless the active
 * turn is interrupted. Any other failure is the actionable warning, even beside a transport failure.
 */
export function threadErrors(
  snapshots: readonly Snapshot[],
  disconnected: boolean,
  running: boolean
): { loadError: string | null; error: string | null } {
  const failed = snapshots.filter((snapshot) => snapshot.error != null);
  const actionable = failed.find((snapshot) => !isUnreachableError(snapshot.error))?.error;
  const missing = failed.find((snapshot) => snapshot.data === undefined)?.error;
  if (missing != null) {
    return { loadError: `Could not load this conversation. ${errorText(actionable ?? missing)}`, error: null };
  }
  return {
    loadError: null,
    error: actionable != null
      ? errorText(actionable)
      : disconnected && running
        ? "The connection to this turn's box was lost. Reconnecting…"
        : null,
  };
}
