import { expect, test } from "bun:test"
import { initialRunPhase, transitionRun, type RunEvent, type RunPhase } from "./src/run-state"

const AT = "2026-11-09T00:00:00.000Z"
const running: RunPhase = initialRunPhase()
const failed: RunPhase = { status: "failed", interruptedByRestart: false }

const apply = (event: RunEvent, phase: RunPhase = running) => transitionRun(phase, event, AT)

test("a settled run records its outcome, end time and exit code", () => {
  expect(apply({ _tag: "settled", ok: true, exitCode: 0 })).toEqual({
    _tag: "transitioned",
    phase: { status: "succeeded", interruptedByRestart: false },
    endedAt: AT,
    exitCode: 0,
    changed: true,
  })
  expect(apply({ _tag: "settled", ok: false, exitCode: 17 })).toMatchObject({
    phase: { status: "failed", interruptedByRestart: false },
    exitCode: 17,
  })
})

test("a stopped run is cancelled, not interrupted", () => {
  expect(apply({ _tag: "cancelled" })).toMatchObject({
    phase: { status: "cancelled", interruptedByRestart: false },
    exitCode: null,
  })
})

test("shutdown is a restart interruption; an aborted launch is not", () => {
  expect(apply({ _tag: "interrupted" })).toMatchObject({
    phase: { status: "failed", interruptedByRestart: true },
    exitCode: null,
  })
  expect(apply({ _tag: "aborted" })).toMatchObject({
    phase: { status: "failed", interruptedByRestart: false },
    exitCode: null,
  })
})

test("a run that already settled cannot settle again", () => {
  for (const event of [
    { _tag: "settled", ok: true, exitCode: 0 },
    { _tag: "cancelled" },
    { _tag: "interrupted" },
    { _tag: "aborted" },
  ] as const) {
    expect(apply(event, failed)).toEqual({ _tag: "illegal", reason: "already-settled" })
  }
})
