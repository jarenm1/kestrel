import { transitionDelegation, type DelegationEvent, type DelegationTransition, type Task } from "@cloudagents/protocol"
import type { Mutable } from "./state"

/**
 * The server's entry point to the delegation phase writer. It writes the lifecycle fields and preserves the
 * delegation's dispatch/continuation identity; a task with no delegation is illegal for every event.
 */
export const applyDelegationEvent = (task: Mutable<Task>, event: DelegationEvent): DelegationTransition => {
  const delegation = task.delegation
  if (delegation === undefined) return { _tag: "illegal", reason: "not-delegated" }
  const transition = transitionDelegation(
    {
      runId: delegation.runId,
      parentRunId: delegation.parentRunId,
      cancelledAt: delegation.cancelledAt,
      resultAcknowledged: delegation.resultAcknowledged === true,
    },
    event,
  )
  if (transition._tag === "transitioned") {
    const { runId: _runId, parentRunId: _parentRunId, cancelledAt: _cancelledAt, ...rest } = delegation
    const phase = transition.phase
    task.delegation = {
      ...rest,
      parentRunId: phase.parentRunId ?? delegation.parentRunId,
      resultAcknowledged: phase.resultAcknowledged,
      ...(phase.runId === undefined ? {} : { runId: phase.runId }),
      ...(phase.cancelledAt === undefined ? {} : { cancelledAt: phase.cancelledAt }),
    }
  }
  return transition
}
