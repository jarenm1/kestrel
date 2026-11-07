import { isUnreachableError } from "../api/errors"
import { errorText } from "../util"

type Snapshot = { data: unknown; error: unknown }

/** Missing conversation content is a load failure, not an empty chat or a periodic offline banner. */
export function threadErrors(snapshots: readonly Snapshot[], disconnected: boolean, running: boolean) {
  const failed = snapshots.filter((snapshot) => snapshot.error != null)
  const actionable = failed.find((snapshot) => !isUnreachableError(snapshot.error))?.error
  const missing = failed.find((snapshot) => snapshot.data === undefined)?.error
  if (missing != null) {
    return { loadError: `Could not load this conversation. ${errorText(actionable ?? missing)}`, error: null }
  }
  return {
    loadError: null,
    error: actionable != null
      ? errorText(actionable)
      : disconnected && running
        ? "The connection to this turn's box was lost. Reconnecting…"
        : null,
  }
}
