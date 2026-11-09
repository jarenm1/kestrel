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
