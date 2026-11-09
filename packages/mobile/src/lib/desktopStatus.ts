import type { DesktopStatus } from "@cloudagents/protocol";

/** Which writer produced a cached desktop lifecycle status: the box's event stream, or a user mutation's response. */
export type DesktopStatusSource = "event" | "mutation";

/** The one shape of `boxKeys(scope).desktop(taskId)`: the lifecycle phase and the writer that last applied it. */
export interface DesktopStatusValue {
  readonly status: DesktopStatus;
  readonly source: DesktopStatusSource;
  /** Bumped on every applied write, so a request can notice that a newer status landed while it was in flight. */
  readonly revision: number;
}

/**
 * The one writer of the desktop lifecycle cache. Event writes are last-write-wins. A mutation response may only land
 * if nothing else wrote the entry since the mutation started (`base` is the entry captured in `onMutate`), so a
 * start/stop answer that raced a newer event cannot roll the desktop back.
 */
export const applyDesktopStatus = (
  current: DesktopStatusValue | undefined,
  status: DesktopStatus,
  source: DesktopStatusSource,
  base?: DesktopStatusValue
): DesktopStatusValue => {
  if (source === "mutation" && base !== undefined && current !== undefined && current.revision !== base.revision) {
    return current;
  }
  return { status, source, revision: (current?.revision ?? 0) + 1 };
};
