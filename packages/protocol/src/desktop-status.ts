import type { DesktopStatus } from "./index"

/** Which writer produced a cached desktop lifecycle status. */
export type DesktopStatusSource = "stream" | "event" | "mutation"

/** The cache shape shared by the web and phone clients: the lifecycle phase and the writer that last applied it. */
export interface DesktopStatusValue {
  readonly status: DesktopStatus
  readonly source: DesktopStatusSource
  /** Bumped on every applied write, so a request can notice that a newer status landed while it was in flight. */
  readonly revision: number
}

/**
 * The one writer of the desktop lifecycle cache. A live stream frame is the box's truth, `desktop.updated` is its
 * snapshot, and a mutation response is the user's request answered last. While `streamActive`, an event is ignored:
 * the frames are level truth and the event stream may be catching up. A mutation response may only land when nothing
 * wrote the entry after `base` (captured by `onMutate`), so it cannot roll a newer event or frame back.
 */
export const applyDesktopStatus = (
  current: DesktopStatusValue | undefined,
  status: DesktopStatus,
  source: DesktopStatusSource,
  base?: DesktopStatusValue | undefined,
  streamActive = false,
): DesktopStatusValue => {
  if (source === "event" && streamActive && current !== undefined) return current
  if (source === "mutation" && base !== undefined && current !== undefined && current.revision !== base.revision) {
    return current
  }
  return { status, source, revision: (current?.revision ?? 0) + 1 }
}
