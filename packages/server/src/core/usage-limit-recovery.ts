import { Cause, Effect, Either } from "effect"
import {
  Conflict,
  DEFAULT_MODEL_PROVIDER,
  DEFAULT_THREAD_SETTINGS,
  type AgentItem,
  type ProviderUsage,
  type Run,
  type Task,
  type ThreadSettings,
} from "@cloudagents/protocol"
import type { StoreShape, StoreState } from "./state"
import { MODEL_USAGE_CLI, USAGE_LIMIT_RESUME_MESSAGE, isUsageLimitFailure, usageLimitResetAt } from "./usage-limits"

/** How often a thread's armed auto-resume is checked against the provider's reset. */
export const USAGE_LIMIT_SWEEP = "15 seconds"
/** How long after a failure the box will arm it; an older failure is left for the user to retry. */
const ARM_WINDOW_MS = 10 * 60 * 1000

export interface UsageLimitRecoveryDeps {
  readonly store: Pick<StoreShape, "read" | "update">
  readonly publish: (task: Task) => void
  readonly settings: (user: string) => Effect.Effect<ThreadSettings, unknown>
  readonly items: (runId: string) => Effect.Effect<ReadonlyArray<AgentItem>, unknown>
  readonly providerUsage: (user: string, fresh: boolean) => Effect.Effect<ReadonlyArray<ProviderUsage>, unknown>
  /** Delivers the automatic continuation to the thread; its id is deterministic so a retry cannot duplicate it. */
  readonly deliver: (task: Task, run: Run, deliveryId: string) => Effect.Effect<void, unknown>
}

/**
 * Arms a failed run whose provider reported a usage limit, and resumes it once that provider's exhausted window
 * resets. The arm is stored on the thread whether or not auto-resume is on, so the app can show the reset and let the
 * user opt in for that one thread. A user reply or a resumed run moves the thread on and drops the arm. Runs that did
 * not fail on a limit are examined once, and a limit whose reset the provider does not report is left to the user.
 *
 * The sweep reads the whole store on every tick. When thread counts grow, derive a next-wake time from the soonest
 * armed reset (t3code does this with `getLimitRecoveryWakeAt`) and skip idle ticks; today the tick is cheap.
 */
export const makeUsageLimitRecovery = (deps: UsageLimitRecoveryDeps) => {
  /** Failed runs already looked at: a run is never a fresh failure again. Cleared when it stops being a thread's latest. */
  const examined = new Set<string>()

  const settingsOf = (user: string) =>
    deps.settings(user).pipe(Effect.catchAll(() => Effect.succeed(DEFAULT_THREAD_SETTINGS)))

  const clearArm = (taskId: string, runId: string) =>
    deps.store.update((s) => {
      const stored = s.tasks.find((t) => t.id === taskId)
      if (stored?.usageLimitResume?.runId !== runId) return Either.right(null)
      delete stored.usageLimitResume
      return Either.right({ ...stored })
    }).pipe(Effect.tap((task) => (task === null ? Effect.void : Effect.sync(() => deps.publish(task)))))

  /** A failed run's evidence for a usage limit: its error items and the agent message it ended with. */
  const evidence = (state: Readonly<StoreState>, run: Run) =>
    deps.items(run.id).pipe(
      Effect.catchAll(() => Effect.succeed<ReadonlyArray<AgentItem>>([])),
      Effect.map((items) => {
        // Prose alone is not evidence: the turn itself must have failed (an error item, or a failed turn result).
        const failed = items.some(
          (item) => item._tag === "error" || (item._tag === "turn" && item.isError),
        )
        return failed
          ? [
              ...state.messages.filter((m) => m.runId === run.id && m.role === "agent").map((m) => m.text),
              ...items.flatMap((item) => (item._tag === "error" ? [item.text] : [])),
            ]
          : []
      }),
    )

  const resume = (task: Task, run: Run, resetsAt: string) =>
    Effect.gen(function* () {
      const provider = run.provider ?? DEFAULT_MODEL_PROVIDER
      // A run without an explicit model on a non-default provider cannot be reproduced; drop the arm instead of
      // leaving a notice that promises a resume.
      if (run.model === undefined && provider !== DEFAULT_MODEL_PROVIDER) return yield* clearArm(task.id, run.id)
      const delivered = yield* Effect.either(
        deps.deliver(task, run, `usage-limit-resume:${task.id}:${run.id}:${resetsAt}`),
      )
      if (Either.isLeft(delivered)) {
        // The thread moved on while the sweep read it (a user reply, or a run that started meanwhile). There is
        // nothing left to resume, so stop advertising it instead of retrying forever.
        if (delivered.left instanceof Conflict) return yield* clearArm(task.id, run.id)
        return yield* Effect.fail(delivered.left)
      }
      yield* clearArm(task.id, run.id)
    }).pipe(
      Effect.catchAllCause((cause) =>
        Effect.logWarning(`task ${task.id}: usage-limit resume failed: ${Cause.pretty(cause)}`),
      ),
    )

  const arm = (task: Task, run: Run, endedAt: number, state: Readonly<StoreState>, autoResumeByOwner: Map<string, boolean>) =>
    Effect.gen(function* () {
      const provider = run.provider ?? DEFAULT_MODEL_PROVIDER
      // A run without an explicit model on a non-default provider cannot be reproduced; leave it to the user.
      if (run.model === undefined && provider !== DEFAULT_MODEL_PROVIDER) return
      const texts = yield* evidence(state, run)
      const cli = MODEL_USAGE_CLI[provider]
      if (!isUsageLimitFailure(texts) || cli === undefined) {
        examined.add(run.id)
        return
      }
      const usage = (yield* deps.providerUsage(task.owner, true)).find((entry) => entry.provider === cli)
      // The probe is the only part that can fail transiently; do not consume this run's one look until it answered.
      examined.add(run.id)
      const resetsAt = usageLimitResetAt(usage, endedAt)
      if (resetsAt === null) return
      let autoResume = autoResumeByOwner.get(task.owner)
      if (autoResume === undefined) {
        autoResume = (yield* settingsOf(task.owner)).autoResumeAfterUsageLimits
        autoResumeByOwner.set(task.owner, autoResume)
      }
      const armed = yield* deps.store.update((s) => {
        const stored = s.tasks.find((t) => t.id === task.id)
        const last = [...s.runs].reverse().find((r) => r.taskId === task.id)
        if (
          stored === undefined ||
          stored.archivedAt !== undefined ||
          stored.usageLimitResume !== undefined ||
          last?.id !== run.id
        ) {
          return Either.right(null)
        }
        stored.usageLimitResume = { runId: run.id, resetsAt, autoResume }
        return Either.right({ ...stored })
      })
      if (armed !== null) deps.publish(armed)
    }).pipe(
      Effect.catchAllCause((cause) =>
        Effect.logWarning(`task ${task.id}: usage-limit check failed: ${Cause.pretty(cause)}`),
      ),
    )

  const sweep = Effect.gen(function* () {
    const state = yield* deps.store.read
    const latest = new Map<string, Run>()
    for (const run of state.runs) latest.set(run.taskId, run)

    // Only a thread's latest run can ever be armed, so older ids would otherwise accumulate for the box's lifetime.
    const latestIds = new Set([...latest.values()].map((run) => run.id))
    for (const id of examined) if (!latestIds.has(id)) examined.delete(id)

    // A reply, a resumed run, or a cancelled delegation leaves the old arm with nothing to resume.
    const stale = state.tasks.filter(
      (task) =>
        task.usageLimitResume !== undefined &&
        (latest.get(task.id)?.id !== task.usageLimitResume.runId ||
          task.delegation?.cancelledAt !== undefined),
    )
    if (stale.length > 0) {
      const updated = yield* deps.store.update((s) => {
        const tasks: Task[] = []
        for (const task of s.tasks) {
          const armRecord = task.usageLimitResume
          if (armRecord === undefined) continue
          const last = [...s.runs].reverse().find((run) => run.taskId === task.id)
          if (last?.id === armRecord.runId && task.delegation?.cancelledAt === undefined) continue
          delete task.usageLimitResume
          tasks.push({ ...task })
        }
        return Either.right(tasks)
      })
      for (const task of updated) deps.publish(task)
    }

    const now = Date.now()
    const current = yield* deps.store.read
    const latestNow = new Map<string, Run>()
    for (const run of current.runs) latestNow.set(run.taskId, run)
    // One settings read per owner per sweep, not one per armed task.
    const autoResumeByOwner = new Map<string, boolean>()

    for (const task of current.tasks) {
      if (task.archivedAt !== undefined || task.delegation?.cancelledAt !== undefined) continue
      const run = latestNow.get(task.id)
      const armRecord = task.usageLimitResume
      if (armRecord !== undefined) {
        // Resume at the provider's reset only when this thread opted in; otherwise the notice stays for a manual opt-in.
        if (
          !armRecord.autoResume ||
          run?.id !== armRecord.runId ||
          run.status !== "failed" ||
          task.status !== "failed" ||
          !(Date.parse(armRecord.resetsAt) <= now)
        ) {
          continue
        }
        yield* resume(task, run, armRecord.resetsAt)
        continue
      }

      // Only a failure this box saw recently, and that is still the thread's latest run, can be armed.
      if (run === undefined || run.status !== "failed" || run.endedAt === null) continue
      const endedAt = Date.parse(run.endedAt)
      if (now - endedAt > ARM_WINDOW_MS || examined.has(run.id)) continue
      yield* arm(task, run, endedAt, current, autoResumeByOwner)
    }
  })

  return { sweep }
}
