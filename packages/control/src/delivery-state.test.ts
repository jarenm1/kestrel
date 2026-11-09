import { expect, test } from "bun:test"
import {
  applyDeliveryEvent,
  claimedFirePhase,
  transitionPrActivity,
  transitionWebhook,
  type FireEvent,
  type FirePhase,
} from "./delivery-state"

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

test("a webhook delivery is inserted once and a seen one is a duplicate", () => {
  expect(transitionWebhook({ seen: false }, { _tag: "deliver" })).toEqual({
    _tag: "transitioned",
    phase: { seen: true },
    changed: true,
    action: "insert",
  })
  expect(transitionWebhook({ seen: true }, { _tag: "deliver" })).toEqual({
    _tag: "transitioned",
    phase: { seen: true },
    changed: false,
    action: "none",
  })
})

test("a PR activity claim resets attempts, and delivery or drop is terminal", () => {
  const phase = { attempts: 4, deliveryId: "old", dueAt: 1 }
  expect(transitionPrActivity(phase, { _tag: "claimed", deliveryId: "new", dueAt: 2 })).toEqual({
    _tag: "transitioned",
    phase: { attempts: 0, deliveryId: "new", dueAt: 2 },
    changed: true,
    action: "upsert",
  })
  expect(transitionPrActivity(phase, { _tag: "delivered" }).action).toBe("delete")
  expect(transitionPrActivity(phase, { _tag: "dropped" }).action).toBe("delete")
})

test("a retry updates the row until the attempt bound, then deletes it", () => {
  const phase = { attempts: 1, deliveryId: "d", dueAt: 1 }
  expect(
    transitionPrActivity(phase, { _tag: "retry", attempt: 2, dueAt: 3, maxAttempts: 5 }),
  ).toMatchObject({ action: "update", phase: { attempts: 2, dueAt: 3 } })
  expect(
    transitionPrActivity(phase, { _tag: "retry", attempt: 5, dueAt: 3, maxAttempts: 5 }),
  ).toMatchObject({ action: "delete", phase: { attempts: 5 } })
})
