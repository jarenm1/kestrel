import { Context, Effect, Layer } from "effect"

export interface ActivityTrackerShape {
  /** Records user activity: an API request, or a message a client sent on a stream. */
  readonly touch: Effect.Effect<void>
  /**
   * Counts a viewer (a desktop or event stream held open) from now. The returned effect ends the count; running it
   * twice counts once.
   */
  readonly viewerJoined: Effect.Effect<Effect.Effect<void>>
  readonly snapshot: Effect.Effect<{ readonly viewers: number; readonly lastActivityAt: number | null }>
}

export class ActivityTracker extends Context.Tag("cloudagents/ActivityTracker")<ActivityTracker, ActivityTrackerShape>() {}

/** The box's own view of what keeps it awake, reported to the host as `BoxActivity` (see docs/nest.md). */
export const ActivityTrackerLive = Layer.sync(ActivityTracker, () => {
  let viewers = 0
  let lastActivityAt: number | null = null
  const touch = Effect.sync(() => {
    lastActivityAt = Date.now()
  })
  return {
    touch,
    viewerJoined: Effect.sync(() => {
      viewers++
      lastActivityAt = Date.now()
      let left = false
      return Effect.sync(() => {
        if (left) return
        left = true
        viewers = Math.max(0, viewers - 1)
      })
    }),
    snapshot: Effect.sync(() => ({ viewers, lastActivityAt })),
  }
})
