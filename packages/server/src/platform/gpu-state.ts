import { Effect, Fiber } from "effect"
import type { GpuState } from "@cloudagents/protocol"

/**
 * How long a host `attaching` report may stand before the box stops treating the GPU as on its way. The host's own
 * attach request deadline is 120 s; past it the state is stale and desktops stay (or fall back) on software rendering.
 */
export const GPU_ATTACH_STATE_DEADLINE_MS = 120_000

/** The renderer the box told its desktops to use. */
export type GpuRenderer = "gl" | "pixman"

/** The GPU machine as the box currently sees it; for status and diagnostics. */
export interface GpuSnapshot {
  /** The last state the host reported; `none` before any report. */
  readonly state: GpuState
  /** The renderer the desktops were reconciled to; null before the first report or replay. */
  readonly renderer: GpuRenderer | null
  /** True while an `attaching` report is still in flight (not past its deadline). */
  readonly attaching: boolean
  /** When the host reported `attaching`; null in every other state. */
  readonly attachingSince: number | null
}

export interface GpuReconcilerDeps {
  /** The desktop manager's attach path (D6: desktops restart on the GPU renderer). */
  readonly attachHardware: Effect.Effect<void, unknown>
  /** The desktop manager's release path (desktops stop on the GPU and come back on software). */
  readonly releaseHardware: Effect.Effect<void, unknown>
  /** The box's existing diagnostic channel. */
  readonly warn: (message: string) => void
  readonly onSnapshot?: (snapshot: GpuSnapshot) => void
  readonly now?: () => number
  readonly attachingDeadlineMs?: number
}

/**
 * Level-triggered GPU reconciliation. `GpuWishes` is intent; the host's `GpuState` is truth. Every report and every
 * guest-link reconnect re-applies the stored state instead of relying on the edge that delivered it, so a missed
 * detach cannot leave `hardwareRender` stale. `attaching` keeps the previous renderer and is bounded by a deadline.
 */
export class GpuReconciler {
  private current: GpuState = "none"
  private renderer: GpuRenderer | null = null
  private attachingSince: number | null = null
  private expired = false
  private deadline: Fiber.RuntimeFiber<void, never> | null = null

  constructor(private readonly deps: GpuReconcilerDeps) {}

  snapshot = (): GpuSnapshot => ({
    state: this.current,
    renderer: this.renderer,
    attaching: this.current === "attaching" && !this.expired,
    attachingSince: this.attachingSince,
  })

  /** A host report. Reconciles renderers, and starts (or cancels) the `attaching` deadline. */
  observe = (state: GpuState): Effect.Effect<void> =>
    Effect.gen(this, function* () {
      yield* this.clearDeadline()
      this.current = state
      switch (state) {
        case "attached":
          this.attachingSince = null
          this.expired = false
          yield* this.reconcile("gl")
          break
        case "none":
        case "detaching":
          this.attachingSince = null
          this.expired = false
          yield* this.reconcile("pixman")
          break
        case "attaching":
          // The guest reports its current snapshot on every box connection, so a repeated `attaching` is the same
          // attempt: keep the original timestamp or reconnects would push the deadline out forever.
          this.attachingSince ??= (this.deps.now ?? Date.now)()
          // The last truth still holds while the host attaches; only bound how long it may say so.
          yield* this.armDeadline()
          break
      }
      this.deps.onSnapshot?.(this.snapshot())
    })

  /** A guest link (re)connected: apply the stored truth again, even when the renderer already matches. */
  replay = (): Effect.Effect<void> =>
    Effect.gen(this, function* () {
      yield* this.clearDeadline()
      switch (this.current) {
        case "attached":
          yield* this.reconcile("gl", true)
          break
        case "none":
        case "detaching":
          yield* this.reconcile("pixman", true)
          break
        case "attaching":
          if (this.expired) yield* this.reconcile("pixman")
          else yield* this.armDeadline()
          break
      }
      this.deps.onSnapshot?.(this.snapshot())
    })

  close = (): void => {
    if (this.deadline !== null) Effect.runFork(Fiber.interrupt(this.deadline))
    this.deadline = null
  }

  private clearDeadline = (): Effect.Effect<void> => {
    const fiber = this.deadline
    this.deadline = null
    return fiber === null ? Effect.void : Fiber.interrupt(fiber)
  }

  private armDeadline = (): Effect.Effect<void> =>
    Effect.gen(this, function* () {
      yield* this.clearDeadline()
      if (this.attachingSince === null) return
      // Arm only the time left in this attaching period: a replay after 100 s must expire at 120 s, not at 220 s.
      const remaining = this.attachingSince +
        (this.deps.attachingDeadlineMs ?? GPU_ATTACH_STATE_DEADLINE_MS) -
        (this.deps.now ?? Date.now)()
      if (remaining <= 0) {
        yield* this.expire()
        return
      }
      this.deadline = yield* Effect.forkDaemon(
        Effect.sleep(remaining).pipe(Effect.zipRight(Effect.suspend(() => this.expire()))),
      )
    })

  private expire = (): Effect.Effect<void> =>
    Effect.gen(this, function* () {
      this.deadline = null
      if (this.current !== "attaching" || this.expired) return
      this.expired = true
      this.deps.warn(
        `guest GPU still attaching after ${this.deps.attachingDeadlineMs ?? GPU_ATTACH_STATE_DEADLINE_MS} ms; desktops stay on software rendering`,
      )
      yield* this.reconcile("pixman")
      this.deps.onSnapshot?.(this.snapshot())
    })

  /** Applies a renderer once; `force` re-applies it for a replay after the desktop manager may have restarted. */
  private reconcile = (target: GpuRenderer, force = false): Effect.Effect<void> =>
    Effect.suspend(() => {
      if (!force && this.renderer === target) return Effect.void
      this.renderer = target
      return target === "gl" ? this.deps.attachHardware : this.deps.releaseHardware
    }).pipe(
      Effect.catchAll((error) =>
        Effect.sync(() =>
          this.deps.warn(`guest GPU reconcile to ${target} failed: ${error instanceof Error ? error.message : String(error)}`),
        ),
      ),
    )
}
