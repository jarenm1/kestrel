import type { TaskStatus } from "./index"

/**
 * The parts of a thread that decide its phase. A caller derives this from the persisted `Task`, its current
 * `Run` and `pendingAsks`; it is deliberately not the persisted shape.
 *
 * `runLive` means a run of this task is still `running`. `pendingAsk` means a `task_ask` question is persisted and
 * still has no answer. `waitingForChildren` is not here: a run that is waiting on delegated children is still
 * `runLive`, and its settlement event arrives only when the run actually ends.
 */
export interface TaskPhase {
  readonly status: TaskStatus
  readonly archived: boolean
  readonly pendingAsk: boolean
  readonly runLive: boolean
  readonly delegationCancelled: boolean
  /** The thread has a delegation record. */
  readonly delegationPresent: boolean
  /** That record has reserved its run. A delegated thread persisted before dispatch has no run. */
  readonly delegationDispatched: boolean
}

export type TaskEvent =
  /** A user message. It answers or supersedes any pending question; it starts a run only when none is live. */
  | { readonly _tag: "userMessage" }
  /** `task_ask` posted a question for the live run. */
  | { readonly _tag: "ask" }
  /** The user answered the pending question. */
  | { readonly _tag: "answer" }
  /** A run began. The caller sends `userMessage` first when the message is what starts it. */
  | { readonly _tag: "runStarted" }
  /** The live run ended. `ok` is the harness outcome, not the CLI exit code. */
  | { readonly _tag: "runSettled"; readonly ok: boolean }
  /**
   * The agent's advisory `task_report`. Callers map the MCP-only word `working` to `running`. A report never
   * overrides a live run's outcome; it is a message until the run settles.
   */
  | { readonly _tag: "report"; readonly status: TaskStatus }
  /** The user cancelled the live run; its question, if any, goes with it. */
  | { readonly _tag: "cancelRun" }
  /** The parent cancelled this delegated thread. */
  | { readonly _tag: "cancelDelegation" }
  | { readonly _tag: "archive" }
  | { readonly _tag: "unarchive" }
  /** The box restarted: a run that was live is gone, as a crash leaves it. A retained question stays retained. */
  | { readonly _tag: "restartReconcile" }
  /** Persisted `needs_input` with no question is not a real phase (D2); it has nothing left to wait for. */
  | { readonly _tag: "reconcileAskless" }
  /** A thread persisted `running` with no live run behind it has nothing left to finish. */
  | { readonly _tag: "reconcileOrphan" }
  /** A delegation persisted before dispatch lost its launching process during the restart. */
  | { readonly _tag: "reconcileUndispatchedDelegation" }

export type TaskIllegalReason =
  | "archived"
  | "ask-without-live-run"
  | "ask-already-pending"
  | "answer-without-ask"
  | "report-without-live-run"
  | "report-needs-input-without-ask"
  | "run-settled-without-live-run"
  | "cancel-without-live-run"

export type TaskTransition =
  | { readonly _tag: "transitioned"; readonly phase: TaskPhase; readonly changed: boolean }
  | { readonly _tag: "illegal"; readonly reason: TaskIllegalReason }

/** The phase of a newly created thread. */
export const initialTaskPhase = (): TaskPhase => ({
  status: "idle",
  archived: false,
  pendingAsk: false,
  runLive: false,
  delegationCancelled: false,
  delegationPresent: false,
  delegationDispatched: false,
})

const same = (a: TaskPhase, b: TaskPhase): boolean =>
  a.status === b.status &&
  a.archived === b.archived &&
  a.pendingAsk === b.pendingAsk &&
  a.runLive === b.runLive &&
  a.delegationCancelled === b.delegationCancelled &&
  a.delegationPresent === b.delegationPresent &&
  a.delegationDispatched === b.delegationDispatched

const next = (phase: TaskPhase, patch: Partial<TaskPhase>): TaskTransition => {
  const result = { ...phase, ...patch }
  return { _tag: "transitioned", phase: result, changed: !same(phase, result) }
}

const illegal = (reason: TaskIllegalReason): TaskTransition => ({ _tag: "illegal", reason })

/**
 * The one writer of a thread's phase. This is the reference implementation for the refactor: it has no callers yet,
 * and tests lock the policy before the server starts using it.
 *
 * Policy:
 * - A live run's outcome wins. `task_report` is advisory until the run settles; a report of `done`/`failed` does
 *   not move a running thread.
 * - `needs_input` always has a pending ask. `report("needs_input")` is illegal; only `ask` may enter that phase.
 * - A retained question survives a restart and a settled run. It is cleared by an answer, a cancellation, or a
 *   user message that supersedes it.
 * - `archived` is a gate, not a status. It refuses user work and reports; settlement and cancellation still land.
 */
export const transitionTask = (phase: TaskPhase, event: TaskEvent): TaskTransition => {
  switch (event._tag) {
    case "userMessage":
      if (phase.archived) return illegal("archived")
      // The message answers or supersedes the question, whether or not a run is live. A new run follows separately.
      return next(phase, { status: "running", pendingAsk: false })

    case "ask":
      if (phase.archived) return illegal("archived")
      if (!phase.runLive) return illegal("ask-without-live-run")
      if (phase.pendingAsk) return illegal("ask-already-pending")
      return next(phase, { status: "needs_input", pendingAsk: true })

    case "answer":
      if (phase.archived) return illegal("archived")
      if (!phase.pendingAsk) return illegal("answer-without-ask")
      return next(phase, { status: "running", pendingAsk: false })

    case "runStarted":
      if (phase.archived) return illegal("archived")
      return next(phase, { status: phase.pendingAsk ? "needs_input" : "running", runLive: true })

    case "runSettled":
      if (!phase.runLive) return illegal("run-settled-without-live-run")
      if (phase.pendingAsk) return next(phase, { status: "needs_input", runLive: false })
      return next(phase, { status: event.ok ? "done" : "failed", runLive: false })

    case "report":
      if (phase.archived) return illegal("archived")
      if (!phase.runLive) return illegal("report-without-live-run")
      if (event.status === "needs_input" && !phase.pendingAsk) return illegal("report-needs-input-without-ask")
      if (phase.pendingAsk) return next(phase, { status: "needs_input" })
      // The run is still live, so a terminal report is only advice. `running` is the truthful phase.
      return next(phase, { status: "running" })

    case "cancelRun":
      if (!phase.runLive) return illegal("cancel-without-live-run")
      return next(phase, { status: "idle", runLive: false, pendingAsk: false })

    case "cancelDelegation":
      return next(phase, {
        status: phase.status === "needs_input" ? "idle" : phase.status,
        pendingAsk: phase.status === "needs_input" ? false : phase.pendingAsk,
        delegationCancelled: true,
      })

    case "archive":
      return next(phase, { archived: true })

    case "unarchive":
      return next(phase, { archived: false })

    case "restartReconcile":
      // A question is durable and stays; a live run is not, so the thread is failed until the user acts.
      if (phase.pendingAsk) return next(phase, { status: "needs_input", runLive: false })
      if (!phase.runLive) return next(phase, {})
      return next(phase, { status: "failed", runLive: false })

    case "reconcileAskless":
      return phase.status === "needs_input" && !phase.pendingAsk ? next(phase, { status: "idle" }) : next(phase, {})

    case "reconcileOrphan":
      return phase.status === "running" && !phase.runLive ? next(phase, { status: "failed" }) : next(phase, {})

    case "reconcileUndispatchedDelegation":
      return phase.delegationPresent && !phase.delegationDispatched
        ? next(phase, { status: "failed" })
        : next(phase, {})

    default: {
      const exhaustive: never = event
      return exhaustive
    }
  }
}
