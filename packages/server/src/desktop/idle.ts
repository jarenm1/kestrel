import type { DesktopState } from "@cloudagents/protocol"

/**
 * True when a box's desktops may stop for inactivity: at least one is up, nothing on the box is running, and the last
 * activity is at least `idleAfterMs` old. `idleAfterMs` of 0 disables the stop, and a box that has recorded no activity
 * since it started (`lastActivityAt` null) is never stopped.
 */
export const shouldStopIdleDesktops = (input: {
  readonly now: number
  readonly runs: number
  readonly viewers: number
  readonly recordings: number
  readonly lastActivityAt: number | null
  readonly activeDesktops: number
  readonly idleAfterMs: number
}): boolean =>
  input.idleAfterMs > 0 &&
  input.activeDesktops > 0 &&
  input.runs === 0 &&
  input.viewers === 0 &&
  input.recordings === 0 &&
  input.lastActivityAt !== null &&
  input.now - input.lastActivityAt >= input.idleAfterMs

/** The per-desktop clock: the last input event the desktop received, and when its last viewer left. */
export interface IdleInputClock {
  lastInputAt: number | null
}

/**
 * Records desktop input on the session clock. `ActivityTracker` sees HTTP requests and stream messages, but not the
 * input that drives a desktop (WebRTC data channels, `streamInput`), and a viewer leaving is the end of activity too:
 * both are noted here.
 */
export const noteDesktopInput = (clock: IdleInputClock, now: number): void => {
  clock.lastInputAt = now
}

/**
 * Records the end of a viewing session as activity: after the last viewer leaves, the idle window starts from then, so
 * hours of watching without input do not make the desktop look idle the moment it is closed. Departed viewers do not
 * move the clock, so a second viewer leaving shortly after does not extend it again.
 */
export const noteViewerLeft = (clock: IdleInputClock, viewers: number, now: number): void => {
  if (viewers === 0) clock.lastInputAt = now
}

/** The session state a viewer departure changes: its live and awaiting sinks, and the idle clock. */
export interface ViewerDetachState<T> {
  readonly sinks: Set<T>
  readonly awaiting: Set<T>
  lastInputAt: number | null
}

/**
 * Ends one viewer's stream on a session: removes it from the live and awaiting sets, then starts the idle window when
 * the last viewer leaves. The manager's viewer-unsubscribe path calls this, so the order (remove, then note) is pinned
 * by the tests instead of living only in the manager closure.
 */
export const detachViewer = <T>(session: ViewerDetachState<T>, sink: T, now: number): void => {
  session.sinks.delete(sink)
  session.awaiting.delete(sink)
  noteViewerLeft(session, session.sinks.size, now)
}

/**
 * When the desktop was last used, from the box's activity and the session's own input clock. A desktop that has
 * recorded neither since it started has no activity, so it is never stopped for idleness.
 */
export const lastDesktopActivity = (input: {
  readonly lastActivityAt: number | null
  readonly lastInputAt: number | null
}): number | null => {
  const { lastActivityAt, lastInputAt } = input
  if (lastActivityAt === null) return lastInputAt
  if (lastInputAt === null) return lastActivityAt
  return Math.max(lastActivityAt, lastInputAt)
}

/**
 * True when a desktop with a viewer attached has had no agent run, recording or desktop/box activity for
 * `streamIdleAfterMs`: the stream is idle, so stopping the desktop closes it and lets the host suspend the VM.
 */
export const shouldStopIdleStream = (input: {
  readonly now: number
  readonly state: DesktopState
  readonly runs: number
  readonly viewers: number
  readonly recordings: number
  readonly runningApps: number
  readonly lastActivityAt: number | null
  readonly lastInputAt: number | null
  readonly streamIdleAfterMs: number
}): boolean => {
  if (input.streamIdleAfterMs <= 0) return false
  if (input.state !== "starting" && input.state !== "running") return false
  if (input.runs !== 0 || input.recordings !== 0 || input.runningApps !== 0 || input.viewers === 0) return false
  const last = lastDesktopActivity(input)
  return last !== null && input.now - last >= input.streamIdleAfterMs
}

/**
 * True when one session may stop for inactivity. A desktop with no viewer stops after the long window; a desktop that
 * still has a viewer stops after the shorter stream window when neither the agent nor the user has done anything. A
 * running app may still be rendering, so it is left alone. The caller passes the session's exact viewer count.
 */
export const shouldStopIdleSession = (input: {
  readonly now: number
  readonly state: DesktopState
  readonly runs: number
  readonly viewers: number
  readonly recordings: number
  readonly runningApps: number
  readonly lastActivityAt: number | null
  readonly lastInputAt: number | null
  readonly idleAfterMs: number
  readonly streamIdleAfterMs: number
}): boolean => {
  if (input.state !== "starting" && input.state !== "running") return false
  if (input.runningApps > 0) return false
  if (
    shouldStopIdleDesktops({
      now: input.now,
      runs: input.runs,
      viewers: input.viewers,
      recordings: input.recordings,
      activeDesktops: 1,
      lastActivityAt: lastDesktopActivity(input),
      idleAfterMs: input.idleAfterMs,
    })
  )
    return true
  return shouldStopIdleStream(input)
}

/** What the idle stop loop knows about the box; the manager adds each session's own state. */
export interface IdleTaskQuery {
  readonly now: number
  readonly runs: number
  readonly recordings: number
  readonly lastActivityAt: number | null
  readonly idleAfterMs: number
  readonly streamIdleAfterMs: number
}

/** The session fields the idle stop loop judges; the manager projects each live session to one. */
export interface IdleSessionView {
  readonly taskId: string
  readonly state: DesktopState
  readonly viewers: number
  readonly runningApps: number
  readonly lastInputAt: number | null
}

/** The part of an agent-launched app the idle policy reads. */
export interface IdleAppState {
  readonly exit: unknown | null
}

/** True when any agent-launched app is still running; such a desktop may still be rendering with no viewer. */
export const hasRunningApp = (apps: Iterable<IdleAppState>): boolean => {
  for (const app of apps) if (app.exit === null) return true
  return false
}

/** The session shape the manager projects into `IdleSessionView`. */
export interface IdleSessionSource<TApp extends IdleAppState> {
  readonly taskId: string
  readonly state: DesktopState
  readonly sinks: { readonly size: number }
  readonly apps: Iterable<TApp>
  readonly lastInputAt: number | null
}

/** The manager's session projection: viewers from sinks, running apps from the live app list. */
export const idleSessionView = <TApp extends IdleAppState>(session: IdleSessionSource<TApp>): IdleSessionView => ({
  taskId: session.taskId,
  state: session.state,
  viewers: session.sinks.size,
  runningApps: hasRunningApp(session.apps) ? 1 : 0,
  lastInputAt: session.lastInputAt,
})

/** The sessions that may stop for inactivity, by task id: the whole wiring behind `DesktopManager.idleTaskIds`. */
export const idleTaskIdsFor = (sessions: Iterable<IdleSessionView>, query: IdleTaskQuery): ReadonlyArray<string> => {
  const ids: string[] = []
  for (const s of sessions) {
    if (
      shouldStopIdleSession({
        now: query.now,
        state: s.state,
        runs: query.runs,
        viewers: s.viewers,
        recordings: query.recordings,
        runningApps: s.runningApps,
        lastActivityAt: query.lastActivityAt,
        lastInputAt: s.lastInputAt,
        idleAfterMs: query.idleAfterMs,
        streamIdleAfterMs: query.streamIdleAfterMs,
      })
    )
      ids.push(s.taskId)
  }
  return ids
}
