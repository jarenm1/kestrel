import { Cause, Effect } from "effect"
import type { IdleTaskQuery } from "./idle"

/** What the idle stop loop needs from the box: the idle decision, the stop, and the clocks its query reads. */
export interface IdleStopDeps {
  readonly idleTaskIds: (query: IdleTaskQuery) => Effect.Effect<ReadonlyArray<string>>
  readonly stop: (taskId: string) => Effect.Effect<void, unknown>
  readonly activeCount: () => Effect.Effect<number>
  readonly runs: () => Effect.Effect<number>
  readonly lastActivityAt: () => Effect.Effect<number | null>
  readonly now: () => number
  readonly logInfo: (message: string) => Effect.Effect<void>
  readonly logWarning: (message: string) => Effect.Effect<void>
}

/** True when either idle window is enabled: the loop must run for the stream close even if the desktop stop is off. */
export const idleStopLoopEnabled = (desktopIdleAfterMs: number, streamIdleAfterMs: number): boolean =>
  desktopIdleAfterMs > 0 || streamIdleAfterMs > 0

/**
 * Stops the desktops that were idle when the check began, re-asking `idleTaskIds` with a fresh clock before each stop.
 * A stop waits for process termination, and a viewer or input may arrive for a later desktop in that window; the
 * re-check keeps the decision and the stop close together without changing the manager's stop.
 */
export const stopIdleDesktops = (
  deps: IdleStopDeps,
  idleAfterMs: number,
  streamIdleAfterMs: number,
): Effect.Effect<ReadonlyArray<string>> =>
  Effect.gen(function* () {
    const query = (now: number): Effect.Effect<IdleTaskQuery> =>
      Effect.gen(function* () {
        return {
          now,
          runs: yield* deps.runs(),
          // The box records nothing yet; the platform's activity report says the same.
          recordings: 0,
          lastActivityAt: yield* deps.lastActivityAt(),
          idleAfterMs,
          streamIdleAfterMs,
        }
      })
    const first = yield* deps.idleTaskIds(yield* query(deps.now()))
    if (first.length === 0) return []
    const active = yield* deps.activeCount()
    yield* deps.logInfo(
      `stopping ${first.length} of ${active} desktop(s) idle (desktop ${idleAfterMs} ms, stream ${streamIdleAfterMs} ms): ${first.join(", ")}`,
    )
    const stopped: string[] = []
    for (const taskId of first) {
      // Re-check just before the stop: an earlier stop may have taken long enough for a viewer or input to arrive.
      const stillIdle = yield* deps.idleTaskIds(yield* query(deps.now()))
      if (!stillIdle.includes(taskId)) continue
      const ok = yield* deps.stop(taskId).pipe(
        Effect.as(true),
        Effect.catchAllCause((cause) =>
          deps.logWarning(`idle desktop for task ${taskId} not stopped: ${Cause.pretty(cause)}`).pipe(Effect.as(false)),
        ),
      )
      if (ok) stopped.push(taskId)
    }
    return stopped
  })
