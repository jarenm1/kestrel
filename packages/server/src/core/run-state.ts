import { transitionRun, type Run, type RunEvent, type RunTransition } from "@cloudagents/protocol"
import type { Mutable } from "./state"

/**
 * The server's single entry point to the run writer: runs `event` through `transitionRun` and, when legal, writes the
 * lifecycle fields the run persists. It performs no other side effect; callers still own messages and task events.
 */
export const applyRunEvent = (run: Mutable<Run>, event: RunEvent, at: string): RunTransition => {
  const transition = transitionRun(
    { status: run.status, interruptedByRestart: run.interruptedByRestart === true },
    event,
    at,
  )
  if (transition._tag === "transitioned") {
    run.status = transition.phase.status
    run.endedAt = transition.endedAt
    run.exitCode = transition.exitCode
    run.interruptedByRestart = transition.phase.interruptedByRestart ? true : undefined
  }
  return transition
}
