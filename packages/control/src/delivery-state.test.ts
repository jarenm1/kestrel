import { expect, test } from "bun:test"
import { applyDeliveryEvent, claimedFirePhase, type FireEvent, type FirePhase } from "./delivery-state"

const phase = (overrides: Partial<FirePhase> = {}): FirePhase => ({ ...claimedFirePhase(), ...overrides })
const apply = (event: FireEvent, current: FirePhase = phase()) => applyDeliveryEvent(current, event)

test("a start records the attempt before the external effect", () => {
  expect(apply({ _tag: "start", at: 100, maxAttempts: 5 })).toEqual({
    _tag: "transitioned",
    phase: { outcome: null, startedAt: 100, attempts: 1 },
    changed: true,
  })
})

test("a start past the attempt bound is refused so the caller can fail it", () => {
  expect(apply({ _tag: "start", at: 100, maxAttempts: 5 }, phase({ attempts: 5 }))).toEqual({
    _tag: "illegal",
    reason: "attempts-exhausted",
  })
})

test("a settled fire is terminal and a conflicting outcome is illegal", () => {
  expect(apply({ _tag: "settle", status: "started" }, phase({ outcome: "started" }))).toEqual({
    _tag: "transitioned",
    phase: phase({ outcome: "started" }),
    changed: false,
  })
  expect(apply({ _tag: "settle", status: "started" }, phase({ outcome: "failed" }))).toEqual({
    _tag: "illegal",
    reason: "conflicting-terminal-outcome",
  })
  expect(apply({ _tag: "start", at: 100, maxAttempts: 5 }, phase({ outcome: "started" }))).toEqual({
    _tag: "illegal",
    reason: "settled",
  })
})

test("settling an open fire records the outcome", () => {
  expect(apply({ _tag: "settle", status: "started" }, phase({ startedAt: 100, attempts: 1 }))).toEqual({
    _tag: "transitioned",
    phase: { outcome: "started", startedAt: 100, attempts: 1 },
    changed: true,
  })
})
