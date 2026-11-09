import { expect, test } from "bun:test"
import {
  initialDelegationPhase,
  transitionDelegation,
  type DelegationEvent,
  type DelegationPhase,
} from "./src/delegation-state"

const AT = "2026-11-09T00:00:00.000Z"
const base: DelegationPhase = initialDelegationPhase()

const apply = (event: DelegationEvent, phase: DelegationPhase = base) => transitionDelegation(phase, event)

test("dispatch and continuation reserve a run, and a dispatched delegation cannot dispatch again", () => {
  const dispatched = apply({ _tag: "dispatched", runId: "run-1" })
  expect(dispatched).toMatchObject({ _tag: "transitioned", phase: { runId: "run-1" }, changed: true })
  if (dispatched._tag !== "transitioned") throw new Error("expected a transition")
  expect(apply({ _tag: "dispatched", runId: "run-2" }, dispatched.phase)).toEqual({
    _tag: "illegal",
    reason: "already-dispatched",
  })
  expect(apply({ _tag: "continued", runId: "run-2" }, dispatched.phase)).toMatchObject({
    _tag: "transitioned",
    phase: { runId: "run-2" },
  })
  expect(apply({ _tag: "continued", runId: "run-3" }, { ...base, resultAcknowledged: true })).toEqual({
    _tag: "illegal",
    reason: "terminal",
  })
})

test("a re-link takes the child over, keeping cancellation and resetting only the acknowledgement", () => {
  const terminal: DelegationPhase = {
    parentRunId: "parent-1",
    runId: "run-1",
    cancelledAt: AT,
    resultAcknowledged: true,
  }
  expect(apply({ _tag: "relinked", parentRunId: "parent-2" }, terminal)).toEqual({
    _tag: "transitioned",
    phase: {
      parentRunId: "parent-2",
      runId: "run-1",
      cancelledAt: AT,
      resultAcknowledged: false,
    },
    changed: true,
  })
})

test("an acknowledgement sets the flag once", () => {
  const first = apply({ _tag: "acknowledged" })
  expect(first).toEqual({
    _tag: "transitioned",
    phase: { resultAcknowledged: true },
    changed: true,
  })
  if (first._tag !== "transitioned") throw new Error("expected a transition")
  expect(apply({ _tag: "acknowledged" }, first.phase)).toEqual({
    _tag: "transitioned",
    phase: first.phase,
    changed: false,
  })
})

test("cancellation records the first time and is terminal", () => {
  const first = apply({ _tag: "cancelled", at: AT })
  expect(first).toEqual({
    _tag: "transitioned",
    phase: { resultAcknowledged: false, cancelledAt: AT },
    changed: true,
  })
  if (first._tag !== "transitioned") throw new Error("expected a transition")
  expect(apply({ _tag: "cancelled", at: "later" }, first.phase)).toEqual({
    _tag: "transitioned",
    phase: first.phase,
    changed: false,
  })
})

test("a late acknowledgement is still recorded after a cancellation", () => {
  const cancelled = apply({ _tag: "cancelled", at: AT })
  if (cancelled._tag !== "transitioned") throw new Error("expected a transition")
  expect(apply({ _tag: "acknowledged" }, cancelled.phase)).toEqual({
    _tag: "transitioned",
    phase: { resultAcknowledged: true, cancelledAt: AT },
    changed: true,
  })
})
