import {
  ACTIVITY_WINDOW_SECONDS,
  BOX_ID_HEADER,
  type BoxActivityReport,
  ControlPaths,
  MAX_BOX_ACTIVITY_USERS,
} from "@cloudagents/protocol"
import { controlBase } from "../control/client"

/** Where a successful authentication tells the box that `login` just used it. */
export interface BoxActivitySink {
  readonly record: (login: string) => void
}

export interface BoxActivityReporter extends BoxActivitySink {
  /** Sends one snapshot now and starts reporting every 30 seconds; calling it twice starts one timer. */
  readonly start: () => void
  /** Stops the timer; in-flight sends finish. Calling it twice is harmless. */
  readonly stop: () => void
  /** Sends the current snapshot once. Never rejects: telemetry must not affect serving. */
  readonly send: () => Promise<void>
  /** The complete report `send` would post now, without sending it. */
  readonly snapshot: (nowMs?: number) => BoxActivityReport
}

export interface BoxActivityOptions {
  readonly fetchFn?: typeof fetch
  /** Epoch milliseconds; injectable so tests can age users without waiting. */
  readonly now?: () => number
  /**
   * Arms the periodic send and returns its cancel; defaults to an unref'd `setInterval`. Injectable so tests drive
   * reporting without real time.
   */
  readonly schedule?: (tick: () => void, intervalMs: number) => () => void
}

export const ACTIVITY_INTERVAL_MS = 30_000
const REPORT_TIMEOUT_MS = 15_000

export interface BoxActivitySettings {
  readonly controlUrl: string
  readonly boxId: string
  readonly boxSecret: string
}

/**
 * Kestrel's managed-box active-user report: unique logins that made an authenticated request within the window, sent as
 * a complete snapshot every interval so the control plane can tell an idle box from a dead one. `record` is synchronous
 * and does no I/O, so request handling never waits on (or fails because of) the control plane; a failed snapshot is
 * simply replaced by the next one.
 *
 * Reporting is started and stopped by the box's lifecycle (`main.ts`); constructing a reporter starts nothing, so tests
 * and one-shot callers leak no timers. Only managed boxes report: a user's own box has no fleet to report to.
 */
export const makeBoxActivityReporter = (
  settings: BoxActivitySettings,
  options: BoxActivityOptions = {},
): BoxActivityReporter => {
  const fetchFn = options.fetchFn ?? fetch
  const now = options.now ?? Date.now
  const intervalMs = ACTIVITY_INTERVAL_MS
  const windowMs = ACTIVITY_WINDOW_SECONDS * 1000
  const endpoint = `${controlBase(settings.controlUrl)}${ControlPaths.boxActivity}`

  // Insertion order is last-activity order: every record re-inserts its login, so the oldest entries sit in front and
  // the cap evicts the least recently active users. The map is bounded by MAX_BOX_ACTIVITY_USERS at all times.
  const active = new Map<string, number>()
  /** Clears the reporting interval; null until started or after stopped. */
  let cancelInterval: (() => void) | null = null
  /** The send in flight, if any; a second send joins it rather than stacking requests on a slow control plane. */
  let inFlight: Promise<void> | null = null

  const prune = (at: number): void => {
    for (const [login, lastActiveAt] of active) {
      if (at - lastActiveAt >= windowMs) active.delete(login)
    }
  }

  const snapshot = (at: number = now()): BoxActivityReport => {
    prune(at)
    return {
      users: [...active].map(([login, lastActiveAt]) => ({
        login,
        lastActiveAt: new Date(lastActiveAt).toISOString(),
      })),
    }
  }

  const record = (login: string): void => {
    if (login === "") return
    const at = now()
    // Re-insert so map order stays last-activity order for pruning and eviction.
    active.delete(login)
    active.set(login, at)
    while (active.size > MAX_BOX_ACTIVITY_USERS) {
      const oldest = active.keys().next()
      if (oldest.done === true) break
      active.delete(oldest.value)
    }
  }

  const send = (): Promise<void> => {
    if (inFlight !== null) return inFlight
    const report = snapshot()
    inFlight = (async () => {
      try {
        await fetchFn(endpoint, {
          method: "POST",
          headers: {
            authorization: `Bearer ${settings.boxSecret}`,
            [BOX_ID_HEADER]: settings.boxId,
            "content-type": "application/json",
          },
          // A complete snapshot every time, so a missed or refused report needs no replay.
          body: JSON.stringify(report),
          signal: AbortSignal.timeout(REPORT_TIMEOUT_MS),
        })
      } catch {
        // Best effort: an unreachable or refusing control plane must not affect requests, and the next snapshot
        // supersedes this one. A box whose clock runs more than the control plane's skew allowance ahead has its report
        // refused until its clock is corrected; nothing here can detect that.
      } finally {
        inFlight = null
      }
    })()
    return inFlight
  }

  const schedule =
    options.schedule ??
    ((tick: () => void, every: number) => {
      const timer = setInterval(tick, every)
      timer.unref()
      return () => clearInterval(timer)
    })

  return {
    record,
    snapshot,
    send,
    start: () => {
      if (cancelInterval !== null) return
      void send()
      cancelInterval = schedule(() => void send(), intervalMs)
    },
    stop: () => {
      if (cancelInterval === null) return
      cancelInterval()
      cancelInterval = null
    },
  }
}
