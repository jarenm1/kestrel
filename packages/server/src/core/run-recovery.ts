import { Cause, Effect, Either, Exit } from "effect"
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

/** How often failed-run recovery runs; every retry delay and usage-limit reset resolves on this tick. */
export const RUN_RECOVERY_SWEEP = "5 seconds"
/** How long after a failure the box will examine it; an older failure is left for the user to retry. */
const ARM_WINDOW_MS = 10 * 60 * 1000
/** Automatic retries a failure chain gets, the first retry included. */
export const AUTO_RETRY_LIMIT = 3
/** The first retry waits this long; every further retry doubles it, up to `AUTO_RETRY_MAX_MS`. */
export const AUTO_RETRY_BASE_MS = 5_000
export const AUTO_RETRY_MAX_MS = 60_000

/** Wait before retry number `attempt` (1-based). t3code uses the same doubling for its capacity retries. */
export const autoRetryDelay = (attempt: number): number =>
  Math.min(AUTO_RETRY_MAX_MS, AUTO_RETRY_BASE_MS * 2 ** (attempt - 1))

/**
 * What an automatic retry sends the agent. The failed run's session (or the handoff, when it recorded none) carries
 * the work so far, so the retry continues instead of repeating it.
 */
export const AUTO_RETRY_MESSAGE = "Your previous turn failed. Continue where you left off."

export interface RunRecoveryDeps {
  readonly store: Pick<StoreShape, "read" | "update">
  readonly publish: (task: Task) => void
  readonly settings: (user: string) => Effect.Effect<ThreadSettings, unknown>
  readonly items: (runId: string) => Effect.Effect<ReadonlyArray<AgentItem>, unknown>
  readonly providerUsage: (user: string, fresh: boolean) => Effect.Effect<ReadonlyArray<ProviderUsage>, unknown>
  /** Delivers the automatic continuation to the thread; its id is deterministic so a retry cannot duplicate it. */
  readonly deliver: (task: Task, run: Run, deliveryId: string) => Effect.Effect<void, unknown>
  /** Starts retry `attempt` of a failed run; its id is deterministic so a retry cannot duplicate it. */
  readonly retry: (task: Task, run: Run, deliveryId: string, attempt: number) => Effect.Effect<void, unknown>
}

/**
 * Recovers a thread whose latest run failed.
 *
 * A usage-limit failure is armed and resumed once the provider's exhausted window resets. The arm is stored on the
 * thread whether or not auto-resume is on, so the app can show the reset and let the user opt in for that one thread.
 * A user reply or a resumed run moves the thread on and drops the arm. A limit whose reset the provider does not
 * report is left to the user.
 *
 * Every other failure is retried automatically, with a doubling delay, up to `AUTO_RETRY_LIMIT` times per chain. Each
 * retry is a normal run (so it resumes the thread's session), and a retry that fails again is itself retried until the
 * limit. A user reply, a new run, a cancelled delegation or an archived thread drops the pending retry.
 *
 * The sweep reads the whole in-memory store on every tick. When thread counts grow, derive a next-wake time from the
 * soonest armed reset or retry (t3code does this with `getLimitRecoveryWakeAt`) and skip idle ticks; today it is cheap.
 */
export const makeRunRecovery = (deps: RunRecoveryDeps) => {
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

  const clearRetry = (taskId: string, runId: string, attempt: number) =>
    deps.store.update((s) => {
      const stored = s.tasks.find((t) => t.id === taskId)
      if (stored?.autoRetry?.runId !== runId || stored.autoRetry.attempt !== attempt) return Either.right(null)
      delete stored.autoRetry
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

  const armUsageLimit = (task: Task, run: Run, endedAt: number, autoResumeByOwner: Map<string, boolean>) =>
    Effect.gen(function* () {
      const provider = run.provider ?? DEFAULT_MODEL_PROVIDER
      const cli = MODEL_USAGE_CLI[provider]
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
          stored.autoRetry !== undefined ||
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

  const scheduleRetry = (task: Task, run: Run, now: number) =>
    Effect.gen(function* () {
      const attempt = (run.autoRetryAttempt ?? 0) + 1
      if (attempt > AUTO_RETRY_LIMIT) return
      const nextAt = new Date(now + autoRetryDelay(attempt)).toISOString()
      const armed = yield* deps.store.update((s) => {
        const stored = s.tasks.find((t) => t.id === task.id)
        const last = [...s.runs].reverse().find((r) => r.taskId === task.id)
        if (
          stored === undefined ||
          stored.archivedAt !== undefined ||
          stored.status !== "failed" ||
          stored.usageLimitResume !== undefined ||
          stored.autoRetry !== undefined ||
          // A delegated child's result is what its parent sees; retrying would let the parent's notification race it.
          stored.delegation !== undefined ||
          last?.id !== run.id
        ) {
          return Either.right(null)
        }
        stored.autoRetry = { runId: run.id, attempt, nextAt }
        return Either.right({ ...stored })
      })
      if (armed !== null) deps.publish(armed)
    }).pipe(
      Effect.catchAllCause((cause) =>
        Effect.logWarning(`task ${task.id}: auto-retry scheduling failed: ${Cause.pretty(cause)}`),
      ),
    )

  /**
   * A retry that could not be started consumes its attempt, so the next tick cannot loop on the same past-due id. If
   * attempts remain, the next one is armed after its backoff; otherwise the arm is dropped and the thread stays failed.
   */
  const advanceRetry = (taskId: string, runId: string, attempt: number) =>
    deps.store.update((s) => {
      const stored = s.tasks.find((t) => t.id === taskId)
      if (stored?.autoRetry?.runId !== runId || stored.autoRetry.attempt !== attempt) return Either.right(null)
      if (attempt >= AUTO_RETRY_LIMIT) delete stored.autoRetry
      else
        stored.autoRetry = {
          runId,
          attempt: attempt + 1,
          nextAt: new Date(Date.now() + autoRetryDelay(attempt + 1)).toISOString(),
        }
      return Either.right({ ...stored })
    }).pipe(Effect.tap((task) => (task === null ? Effect.void : Effect.sync(() => deps.publish(task)))))

  const retry = (task: Task, run: Run, arm: NonNullable<Task["autoRetry"]>) =>
    Effect.gen(function* () {
      // An exit, not an either: a defect (a model removed from the catalog, say) must not leave the past-due arm to
      // fire on every sweep.
      const delivered = yield* Effect.exit(
        deps.retry(task, run, `auto-retry:${task.id}:${run.id}:${arm.attempt}`, arm.attempt),
      )
      if (Exit.isSuccess(delivered)) return yield* clearRetry(task.id, run.id, arm.attempt)
      const failure = Cause.failureOption(delivered.cause)
      // The thread moved on while the sweep waited (a user reply, or a run that started meanwhile).
      if (failure._tag === "Some" && failure.value instanceof Conflict) {
        return yield* clearRetry(task.id, run.id, arm.attempt)
      }
      yield* advanceRetry(task.id, run.id, arm.attempt)
      yield* Effect.logWarning(`task ${task.id}: auto-retry could not start: ${Cause.pretty(delivered.cause)}`)
    }).pipe(
      Effect.catchAllCause((cause) =>
        Effect.logWarning(`task ${task.id}: auto-retry failed: ${Cause.pretty(cause)}`),
      ),
    )

  /** Looks at a fresh failure once: arm a usage-limit resume, or schedule the next automatic retry. */
  const examine = (task: Task, run: Run, endedAt: number, autoResumeByOwner: Map<string, boolean>) =>
    Effect.gen(function* () {
      // A run without an explicit model on a non-default provider cannot be reproduced; retrying would switch providers.
      if (run.model === undefined && (run.provider ?? DEFAULT_MODEL_PROVIDER) !== DEFAULT_MODEL_PROVIDER) {
        examined.add(run.id)
        return
      }
      const state = yield* deps.store.read
      const texts = yield* evidence(state, run)
      if (isUsageLimitFailure(texts)) {
        // A limit the box cannot map to a provider has no reset to wait for; leave it for the user.
        if (MODEL_USAGE_CLI[run.provider ?? DEFAULT_MODEL_PROVIDER] === undefined) {
          examined.add(run.id)
          return
        }
        yield* armUsageLimit(task, run, endedAt, autoResumeByOwner)
        return
      }
      examined.add(run.id)
      // A delegated child's result is its parent's notification; auto-retry would race that delivery.
      if (task.delegation !== undefined) return
      yield* scheduleRetry(task, run, Date.now())
    })

  const sweep = Effect.gen(function* () {
    const state = yield* deps.store.read
    const latest = new Map<string, Run>()
    for (const run of state.runs) latest.set(run.taskId, run)

    // Only a thread's latest run can ever be armed, so older ids would otherwise accumulate for the box's lifetime.
    const latestIds = new Set([...latest.values()].map((run) => run.id))
    for (const id of examined) if (!latestIds.has(id)) examined.delete(id)

    // A reply, a resumed run, or a cancelled delegation leaves a pending recovery with nothing to do.
    const stale = state.tasks.filter((task) => {
      const last = latest.get(task.id)
      return (
        (task.usageLimitResume !== undefined &&
          (last?.id !== task.usageLimitResume.runId || task.delegation?.cancelledAt !== undefined)) ||
        (task.autoRetry !== undefined &&
          (last?.id !== task.autoRetry.runId ||
            task.status !== "failed" ||
            task.archivedAt !== undefined ||
            task.delegation?.cancelledAt !== undefined))
      )
    })
    if (stale.length > 0) {
      const updated = yield* deps.store.update((s) => {
        const tasks: Task[] = []
        for (const task of s.tasks) {
          const last = [...s.runs].reverse().find((run) => run.taskId === task.id)
          const armRecord = task.usageLimitResume
          const retryRecord = task.autoRetry
          const dropArm =
            armRecord !== undefined &&
            (last?.id !== armRecord.runId || task.delegation?.cancelledAt !== undefined)
          const dropRetry =
            retryRecord !== undefined &&
            (last?.id !== retryRecord.runId ||
              task.status !== "failed" ||
              task.archivedAt !== undefined ||
              task.delegation?.cancelledAt !== undefined)
          if (!dropArm && !dropRetry) continue
          if (dropArm) delete task.usageLimitResume
          if (dropRetry) delete task.autoRetry
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
      if (run === undefined) continue

      const retryRecord = task.autoRetry
      if (retryRecord !== undefined) {
        if (
          run.id !== retryRecord.runId ||
          run.status !== "failed" ||
          task.status !== "failed" ||
          !(Date.parse(retryRecord.nextAt) <= now)
        ) {
          continue
        }
        yield* retry(task, run, retryRecord)
        continue
      }

      const armRecord = task.usageLimitResume
      if (armRecord !== undefined) {
        // Resume at the provider's reset only when this thread opted in; otherwise the notice stays for a manual opt-in.
        if (
          !armRecord.autoResume ||
          run.id !== armRecord.runId ||
          run.status !== "failed" ||
          task.status !== "failed" ||
          !(Date.parse(armRecord.resetsAt) <= now)
        ) {
          continue
        }
        yield* resume(task, run, armRecord.resetsAt)
        continue
      }

      // Only a failure this box saw recently, and that is still the thread's latest run, can be armed or retried.
      if (run.status !== "failed" || run.endedAt === null) continue
      const endedAt = Date.parse(run.endedAt)
      if (now - endedAt > ARM_WINDOW_MS || examined.has(run.id)) continue
      yield* examine(task, run, endedAt, autoResumeByOwner)
    }
  })

  return { sweep }
}
