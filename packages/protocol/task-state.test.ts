import { describe, expect, test } from "bun:test"
import {
  initialTaskPhase,
  transitionTask,
  type TaskEvent,
  type TaskPhase,
} from "./src/task-state"

const phase = (overrides: Partial<TaskPhase> = {}): TaskPhase => ({ ...initialTaskPhase(), ...overrides })
const run = (event: TaskEvent, from: TaskPhase) => transitionTask(from, event)

describe("task phase", () => {
  test("a new thread is idle, unarchived, with no run or question", () => {
    expect(initialTaskPhase()).toEqual({
      status: "idle",
      archived: false,
      pendingAsk: false,
      runLive: false,
      delegationCancelled: false,
      delegationPresent: false,
      delegationDispatched: false,
    })
  })

  test("a user message runs the thread from any non-archived status", () => {
    for (const status of ["idle", "done", "failed"] as const) {
      const result = run({ _tag: "userMessage" }, phase({ status }))
      expect(result).toMatchObject({ _tag: "transitioned", phase: { status: "running" } })
    }
  })

  test("a user message clears a pending question", () => {
    const result = run(
      { _tag: "userMessage" },
      phase({ status: "needs_input", pendingAsk: true, runLive: true }),
    )
    expect(result).toMatchObject({ _tag: "transitioned", phase: { status: "running", pendingAsk: false } })
  })

  test("only a live run can ask, and only one question waits", () => {
    expect(run({ _tag: "ask" }, phase())).toEqual({ _tag: "illegal", reason: "ask-without-live-run" })
    const asking = run({ _tag: "ask" }, phase({ runLive: true }))
    expect(asking).toMatchObject({ _tag: "transitioned", phase: { status: "needs_input", pendingAsk: true } })
    expect(run({ _tag: "ask" }, phase({ status: "needs_input", pendingAsk: true, runLive: true }))).toEqual({
      _tag: "illegal",
      reason: "ask-already-pending",
    })
  })

  test("an answer requires a question and returns to running", () => {
    expect(run({ _tag: "answer" }, phase())).toEqual({ _tag: "illegal", reason: "answer-without-ask" })
    expect(run({ _tag: "answer" }, phase({ status: "needs_input", pendingAsk: true, runLive: true }))).toMatchObject({
      _tag: "transitioned",
      phase: { status: "running", pendingAsk: false },
    })
  })

  test("a settled run picks done or failed, unless a question is still waiting", () => {
    expect(run({ _tag: "runSettled", ok: true }, phase({ runLive: true }))).toMatchObject({
      _tag: "transitioned",
      phase: { status: "done", runLive: false },
    })
    expect(run({ _tag: "runSettled", ok: false }, phase({ runLive: true }))).toMatchObject({
      _tag: "transitioned",
      phase: { status: "failed", runLive: false },
    })
    expect(
      run({ _tag: "runSettled", ok: true }, phase({ status: "needs_input", pendingAsk: true, runLive: true })),
    ).toMatchObject({ _tag: "transitioned", phase: { status: "needs_input", runLive: false } })
    expect(run({ _tag: "runSettled", ok: true }, phase())).toEqual({
      _tag: "illegal",
      reason: "run-settled-without-live-run",
    })
  })

  test("a terminal report while the run is live is advice, not a transition", () => {
    const result = run({ _tag: "report", status: "done" }, phase({ status: "running", runLive: true }))
    expect(result).toMatchObject({ _tag: "transitioned", phase: { status: "running" }, changed: false })
  })

  test("needs_input without a question is refused", () => {
    expect(run({ _tag: "report", status: "needs_input" }, phase({ runLive: true }))).toEqual({
      _tag: "illegal",
      reason: "report-needs-input-without-ask",
    })
    expect(
      run({ _tag: "report", status: "needs_input" }, phase({ status: "needs_input", pendingAsk: true, runLive: true })),
    ).toMatchObject({ _tag: "transitioned", phase: { status: "needs_input" } })
  })

  test("a report needs a live run", () => {
    expect(run({ _tag: "report", status: "done" }, phase({ status: "running" }))).toEqual({
      _tag: "illegal",
      reason: "report-without-live-run",
    })
  })

  test("cancelling the run drops its question and returns to idle", () => {
    const result = run(
      { _tag: "cancelRun" },
      phase({ status: "needs_input", pendingAsk: true, runLive: true }),
    )
    expect(result).toMatchObject({ _tag: "transitioned", phase: { status: "idle", pendingAsk: false } })
    expect(run({ _tag: "cancelRun" }, phase())).toEqual({ _tag: "illegal", reason: "cancel-without-live-run" })
  })

  test("restart fails a live run but retains a durable question", () => {
    expect(run({ _tag: "restartReconcile" }, phase({ status: "running", runLive: true }))).toMatchObject({
      _tag: "transitioned",
      phase: { status: "failed", runLive: false },
    })
    expect(
      run({ _tag: "restartReconcile" }, phase({ status: "needs_input", pendingAsk: true, runLive: true })),
    ).toMatchObject({ _tag: "transitioned", phase: { status: "needs_input", runLive: false } })
  })

  test("startup repairs only the inconsistent persisted shapes", () => {
    expect(run({ _tag: "reconcileAskless" }, phase({ status: "needs_input" }))).toMatchObject({
      _tag: "transitioned",
      phase: { status: "idle" },
    })
    expect(run({ _tag: "reconcileAskless" }, phase({ status: "needs_input", pendingAsk: true }))).toMatchObject({
      _tag: "transitioned",
      phase: { status: "needs_input" },
      changed: false,
    })
    expect(run({ _tag: "reconcileOrphan" }, phase({ status: "running" }))).toMatchObject({
      _tag: "transitioned",
      phase: { status: "failed" },
    })
    expect(run({ _tag: "reconcileOrphan" }, phase({ status: "running", runLive: true }))).toMatchObject({
      _tag: "transitioned",
      phase: { status: "running" },
      changed: false,
    })
    expect(
      run({ _tag: "reconcileUndispatchedDelegation" }, phase({ delegationPresent: true })),
    ).toMatchObject({ _tag: "transitioned", phase: { status: "failed" } })
    expect(
      run(
        { _tag: "reconcileUndispatchedDelegation" },
        phase({ delegationPresent: true, delegationDispatched: true }),
      ),
    ).toMatchObject({ _tag: "transitioned", changed: false })
    expect(
      run({ _tag: "delegationDispatchFailed" }, phase({ delegationPresent: true })),
    ).toMatchObject({ _tag: "transitioned", phase: { status: "failed" } })
  })

  test("archive gates user work and reports without changing status", () => {
    const archived = run({ _tag: "archive" }, phase({ status: "failed" }))
    expect(archived).toMatchObject({ _tag: "transitioned", phase: { archived: true, status: "failed" } })
    expect(run({ _tag: "userMessage" }, phase({ archived: true }))).toEqual({ _tag: "illegal", reason: "archived" })
    expect(run({ _tag: "ask" }, phase({ archived: true, runLive: true }))).toEqual({
      _tag: "illegal",
      reason: "archived",
    })
    expect(run({ _tag: "report", status: "done" }, phase({ archived: true, runLive: true }))).toEqual({
      _tag: "illegal",
      reason: "archived",
    })
    expect(run({ _tag: "unarchive" }, phase({ archived: true }))).toMatchObject({
      _tag: "transitioned",
      phase: { archived: false },
    })
  })

  test("cancelling a delegated thread clears its question", () => {
    const result = run(
      { _tag: "cancelDelegation" },
      phase({ status: "needs_input", pendingAsk: true, runLive: true }),
    )
    expect(result).toMatchObject({
      _tag: "transitioned",
      phase: { status: "idle", pendingAsk: false, delegationCancelled: true },
    })
  })
})
