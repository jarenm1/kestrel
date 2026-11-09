import type { RunStatus } from "./index"

/**
 * The part of a run that decides its lifecycle phase. `endedAt` and `exitCode` are payload written by the same event,
 * not guards: a caller may only transition a run that is still `running`.
 */
export interface RunPhase {
  readonly status: RunStatus
  readonly interruptedByRestart: boolean
}

export type RunEvent =
  /** The harness turn ended. `ok` is the harness outcome, not the CLI exit code. */
  | { readonly _tag: "settled"; readonly ok: boolean; readonly exitCode: number | null }
  /** The user or a teardown stopped a run that had started. */
  | { readonly _tag: "cancelled" }
  /** The box is going down: the run is left as a crash leaves it for the next start to reconcile. */
  | { readonly _tag: "interrupted" }
  /** The run never started; the caller records the reason as a message. */
  | { readonly _tag: "aborted" }

export type RunIllegalReason = "already-settled"

export type RunTransition =
  | {
      readonly _tag: "transitioned"
      readonly phase: RunPhase
      readonly endedAt: string
      readonly exitCode: number | null
      readonly changed: boolean
    }
  | { readonly _tag: "illegal"; readonly reason: RunIllegalReason }

/** The phase of a run that was just persisted with `startedAt`. */
export const initialRunPhase = (): RunPhase => ({ status: "running", interruptedByRestart: false })

/**
 * The one writer of a run's lifecycle. It has no side effects; the caller writes the result and any message it owes.
 * A settled run cannot settle again, which is what makes duplicate finish/cancel signals harmless.
 */
export const transitionRun = (phase: RunPhase, event: RunEvent, at: string): RunTransition => {
  if (phase.status !== "running") return { _tag: "illegal", reason: "already-settled" }
  switch (event._tag) {
    case "settled":
      return {
        _tag: "transitioned",
        phase: { status: event.ok ? "succeeded" : "failed", interruptedByRestart: false },
        endedAt: at,
        exitCode: event.exitCode,
        changed: true,
      }
    case "cancelled":
      return {
        _tag: "transitioned",
        phase: { status: "cancelled", interruptedByRestart: false },
        endedAt: at,
        exitCode: null,
        changed: true,
      }
    case "interrupted":
      return {
        _tag: "transitioned",
        phase: { status: "failed", interruptedByRestart: true },
        endedAt: at,
        exitCode: null,
        changed: true,
      }
    case "aborted":
      return {
        _tag: "transitioned",
        phase: { status: "failed", interruptedByRestart: false },
        endedAt: at,
        exitCode: null,
        changed: true,
      }
    default: {
      const exhaustive: never = event
      return exhaustive
    }
  }
}
