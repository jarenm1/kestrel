import { Context, Effect, Either, Layer, Schema } from "effect"
import { randomUUID } from "node:crypto"
import { mkdir, readFile } from "node:fs/promises"
import {
  InternalError,
  Message,
  Run,
  Task,
  ModelHarness,
  ModelProvider,
  DEFAULT_MODEL_PROVIDER,
  transitionTask,
  type TaskEvent,
  type TaskPhase,
  type TaskTransition,
} from "@cloudagents/protocol"
import { Config } from "../config"
import { replaceFile, syncDir, writeAtomic } from "./atomic"
import { migrateLegacyState } from "./migrate"

export const newId = (): string => randomUUID()
export const nowIso = (): string => new Date().toISOString()

/** A `task_ask` question still waiting for the user. Kept across restarts; at most one per task. */
const PendingAskRecord = Schema.Struct({ taskId: Schema.String, runId: Schema.String, messageId: Schema.String })
/** The agent session a run started, its provider and where its CLI kept it, so the task's next run can resume it. */
const RunSessionRecord = Schema.Struct({
  runId: Schema.String,
  sessionId: Schema.String,
  // State files written before model switching hold Claude Code sessions only.
  provider: Schema.optionalWith(ModelProvider, { default: () => DEFAULT_MODEL_PROVIDER }),
  // Absent in state files written before model routing: the session belongs to the provider's current harness.
  harness: Schema.optional(ModelHarness),
  // Absent in state files written before it existed: the place is unknown, so such a session is not resumed.
  continuation: Schema.optional(Schema.String),
})
/** A user upload waiting for a message to name it; its bytes sit under the attachments dir until then. */
const PendingUploadRecord = Schema.Struct({
  id: Schema.String,
  mimeType: Schema.String,
  name: Schema.optional(Schema.String),
  taskId: Schema.String,
  createdAt: Schema.String,
})

const PersistedState = Schema.Struct({
  tasks: Schema.Array(Task),
  messages: Schema.Array(Message),
  runs: Schema.Array(Run),
  // Absent in state files written before these existed; `loadFile` reads them as empty.
  pendingAsks: Schema.optional(Schema.Array(PendingAskRecord)),
  uploads: Schema.optional(Schema.Array(PendingUploadRecord)),
  runSessions: Schema.optional(Schema.Array(RunSessionRecord)),
  settledRuns: Schema.optional(Schema.Array(Schema.String)),
})

export type Mutable<T> = { -readonly [K in keyof T]: T[K] }

export interface PendingAsk {
  readonly taskId: string
  readonly runId: string
  /** The agent message that carries the question and its options. */
  readonly messageId: string
}

export interface RunSession {
  readonly runId: string
  readonly sessionId: string
  readonly provider: ModelProvider
  /** The harness that minted it; a session only resumes in the same provider and harness. */
  readonly harness?: ModelHarness | undefined
  /**
   * The session store and its lifetime (`SessionContinuation` in `harness.ts`). Only a run using the same surviving
   * store can resume it. Absent or legacy unversioned CLI-login records are not resumed.
   */
  readonly continuation?: string | undefined
}

/** A user upload waiting to be sent with a message. */
export interface PendingUpload {
  readonly id: string
  readonly mimeType: string
  readonly name?: string | undefined
  readonly taskId: string
  readonly createdAt: string
}

export interface StoreState {
  tasks: Mutable<Task>[]
  messages: Mutable<Message>[]
  runs: Mutable<Run>[]
  pendingAsks: PendingAsk[]
  uploads: PendingUpload[]
  runSessions: RunSession[]
  /**
   * Failed runs whose recovery the user already decided (they returned a usage-stopped child to its parent): the
   * recovery sweep never arms them again, across restarts too. Pruned once a run stops being its thread's latest.
   */
  settledRuns: string[]
}

/**
 * A thread's phase as the store holds it: its status plus the run, ask and delegation facts that must agree with it.
 * Callers derive it from persisted records; it is not the persisted shape (`TaskPhase`).
 */
export const taskPhaseOf = (state: Readonly<StoreState>, task: Task): TaskPhase => ({
  status: task.status,
  archived: task.archivedAt !== undefined,
  pendingAsk: state.pendingAsks.some((ask) => ask.taskId === task.id),
  runLive: state.runs.some((run) => run.taskId === task.id && run.status === "running"),
  delegationCancelled: task.delegation?.cancelledAt !== undefined,
})

/**
 * The one server entry point to the thread writer: runs `event` through `transitionTask` and, when the transition is
 * legal, writes back the phase field the task persists (its status). The run and ask facts belong to their own
 * records, so the caller adds or removes the ask row whose presence the transition reports.
 */
export const applyTaskEvent = (state: Readonly<StoreState>, task: Mutable<Task>, event: TaskEvent): TaskTransition => {
  const transition = transitionTask(taskPhaseOf(state, task), event)
  if (transition._tag === "transitioned") task.status = transition.phase.status
  return transition
}

export interface StoreShape {
  /**
   * The last committed state, a snapshot that changes only when an update lands. Callers MUST NOT mutate it; use
   * `update`. A value read before an update keeps the old contents; read again to see the new ones.
   */
  readonly read: Effect.Effect<Readonly<StoreState>>
  /**
   * Runs `f` synchronously against the working state. If `f` returns Right, the state is persisted atomically before
   * the effect succeeds. If it returns Left, or the write fails before the rename, nothing is persisted and the
   * mutations are rolled back, so the effect fails with the update NOT applied. If the rename landed but its directory
   * sync fails, the effect fails with an InternalError saying the update was applied and is visible, but durability is
   * unconfirmed: the caller must treat it as applied, not as rolled back.
   */
  readonly update: <A, E>(f: (s: StoreState) => Either.Either<A, E>) => Effect.Effect<A, E | InternalError>
  /**
   * Like `update`, but an applied-yet-unconfirmed write succeeds with `_tag: "unconfirmed"` and `value` instead of failing. Use
   * it where the caller must go on with what the update reserved: the update is applied in memory and in the file either
   * way. `unconfirmed` means durability is not confirmed (a crash may roll the rename back); it is never a rollback.
   */
  readonly updateOutcome: <A, E>(f: (s: StoreState) => Either.Either<A, E>) => Effect.Effect<UpdateOutcome<A>, E | InternalError>
  /** Resolves once every write made so far is on disk. */
  readonly flush: Effect.Effect<void>
}

/** How a write ended once its rename was attempted. `applied` is durable; `unconfirmed` is applied but not synced. */
export type UpdateOutcome<A> =
  | { readonly _tag: "applied"; readonly value: A }
  | { readonly _tag: "unconfirmed"; readonly value: A; readonly cause: string }

export class StateStore extends Context.Tag("cloudagents/StateStore")<StateStore, StoreShape>() {}

/**
 * Provider ids of the retired standalone ACP harnesses (OMP, Pi, Hermes) — the same strings were their harness ids —
 * and the models they offered. Runs and resume targets persisted while they were selectable still name them, but they
 * are no longer in the model catalog, so only the fields holding one of these values are dropped before decoding. Every
 * other field, record and id is left for the schema to accept or reject: unrelated corruption still fails startup
 * instead of being erased.
 */
const RETIRED_HARNESS_IDS: Record<string, true> = { omp: true, pi: true, hermes: true }
const RETIRED_MODELS: Record<string, true> = {
  "omp-deepseek-flash": true,
  "omp-deepseek-pro": true,
  "pi-deepseek-flash": true,
  "pi-deepseek-pro": true,
  "hermes-deepseek-flash": true,
  "hermes-deepseek-pro": true,
}

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

/**
 * Drops the executable routing metadata of runs recorded on a retired harness: the run keeps its id, prompt, status
 * and timestamps, and simply has no provider, model or harness it could be run with again. A resume target of a retired
 * harness is discarded too, so the thread's next supported run starts a fresh session with the conversation history.
 * Returns whether anything was dropped (and the file should be rewritten).
 */
const dropRetiredHarnessState = (data: Record<string, unknown>): boolean => {
  let dropped = false
  if (Array.isArray(data.runs)) {
    for (const run of data.runs) {
      if (!isObject(run)) continue
      if (typeof run.provider === "string" && RETIRED_HARNESS_IDS[run.provider] === true) {
        delete run.provider
        dropped = true
      }
      if (typeof run.model === "string" && RETIRED_MODELS[run.model] === true) {
        delete run.model
        dropped = true
      }
      if (typeof run.harness === "string" && RETIRED_HARNESS_IDS[run.harness] === true) {
        delete run.harness
        dropped = true
      }
    }
  }
  if (Array.isArray(data.runSessions)) {
    const kept = data.runSessions.filter(
      (session) => !(isObject(session) && typeof session.provider === "string" && RETIRED_HARNESS_IDS[session.provider] === true),
    )
    if (kept.length !== data.runSessions.length) {
      data.runSessions = kept
      dropped = true
    }
  }
  return dropped
}

/**
 * Moves the pull request link a checkout used to carry into its thread's `pullRequests` registry. State files written
 * before a thread could own several pull requests keep the single link on the checkout; the registry is the current
 * shape, so the field is dropped once its entry exists. Returns whether anything moved (and the file should be rewritten).
 */
const migrateCheckoutPullRequests = (data: Record<string, unknown>): boolean => {
  if (!Array.isArray(data.tasks)) return false
  let moved = false
  for (const task of data.tasks) {
    if (!isObject(task) || !Array.isArray(task.checkouts)) continue
    const registry = Array.isArray(task.pullRequests) ? (task.pullRequests as Array<Record<string, unknown>>) : []
    for (const checkout of task.checkouts) {
      if (!isObject(checkout)) continue
      const link = checkout.pullRequest
      if (!isObject(link) || typeof link.number !== "number" || typeof link.url !== "string") continue
      const repo = typeof checkout.repo === "string" ? checkout.repo : null
      if (repo === null) continue
      const id = `${repo.toLowerCase()}#${link.number}`
      if (!registry.some((entry) => isObject(entry) && entry.id === id)) {
        // Every legacy link keeps its checkout association, which the app and the `gh` shim show. No branch is recorded:
        // the old state has no head ref, so a write resolves the pull request through the checkout's branch and records
        // it once verified. A takeover is its own marker; a blocked fork/closed-PR link finds no open PR for the branch.
        const takeover = checkout.pullRequestTakeover === true
        registry.push({
          id,
          repo,
          number: link.number,
          url: link.url,
          ...(typeof checkout.id === "string" ? { checkoutId: checkout.id } : {}),
          source: takeover ? "takeover" : "linked",
          ...(typeof checkout.createdAt === "string" ? { addedAt: checkout.createdAt } : {}),
        })
      }
      delete checkout.pullRequest
      moved = true
    }
    if (registry.length > 0) task.pullRequests = registry
  }
  return moved
}

const loadFile = (file: string): Effect.Effect<StoreState, InternalError> =>
  Effect.gen(function* () {
    const raw = yield* Effect.tryPromise({
      try: () => readFile(file, "utf8"),
      catch: (e) => e,
    }).pipe(
      Effect.catchAll((e) =>
        (e as NodeJS.ErrnoException).code === "ENOENT"
          ? Effect.succeed(null)
          : Effect.fail(new InternalError({ message: `cannot read ${file}: ${String(e)}` })),
      ),
    )
    if (raw === null) return { tasks: [], messages: [], runs: [], pendingAsks: [], runSessions: [], uploads: [], settledRuns: [] }
    const parsed = yield* Schema.decodeUnknown(Schema.parseJson())(raw).pipe(
      Effect.mapError((e) => new InternalError({ message: `corrupt state file ${file}: ${e.message}` })),
    )
    const dropped = isObject(parsed) && dropRetiredHarnessState(parsed)
    const moved = isObject(parsed) && migrateCheckoutPullRequests(parsed)
    const decoded = yield* Schema.decodeUnknown(PersistedState)(parsed).pipe(
      Effect.mapError((e) => new InternalError({ message: `corrupt state file ${file}: ${e.message}` })),
    )
    // Rewritten only once the rest of the file decoded, so a file with unrelated corruption keeps its bytes.
    if (dropped || moved) {
      yield* Effect.tryPromise({
        try: () => writeAtomic(file, JSON.stringify(parsed)),
        catch: (e) => new InternalError({ message: `cannot rewrite ${file}: ${String(e)}` }),
      })
    }
    return {
      tasks: [...decoded.tasks],
      messages: [...decoded.messages],
      runs: [...decoded.runs],
      pendingAsks: [...(decoded.pendingAsks ?? [])],
      uploads: [...(decoded.uploads ?? [])],
      runSessions: [...(decoded.runSessions ?? [])],
      settledRuns: [...(decoded.settledRuns ?? [])],
    }
  })

/**
 * A run or task still marked running belongs to a previous server process, which is gone.
 * Mark them failed so the UI does not show work that cannot finish.
 */
const reconcile = (state: StoreState): void => {
  const now = new Date().toISOString()
  // The task's phase is read while its run still counts as live: the transition is what turns the lost run into a
  // failed thread, keeping a question that survived the restart.
  for (const task of state.tasks) {
    applyTaskEvent(state, task, { _tag: "restartReconcile" })
    // `needs_input` without a question is not a real phase (D2). A live run was already turned into a failed thread
    // by the transition above; with no run left the thread has nothing to wait for.
    if (task.status === "needs_input" && !state.pendingAsks.some((ask) => ask.taskId === task.id)) {
      task.status = "idle"
    }
    // A thread persisted `running` with no live run behind it has nothing left to finish, even when the transition
    // had nothing to change.
    if (task.status === "running" && !state.runs.some((run) => run.taskId === task.id && run.status === "running")) {
      task.status = "failed"
    }
    // A delegation persisted before dispatch lost its launching process during restart.
    if (task.delegation !== undefined && task.delegation.runId === undefined) task.status = "failed"
  }
  for (const run of state.runs) {
    if (run.status !== "running") continue
    run.status = "failed"
    run.endedAt = now
    run.interruptedByRestart = true
  }
}

/**
 * Every object and array reachable from the state before an update runs, with a shallow copy of its own contents.
 * Restoring resets each one to its copy, so every object keeps its identity, nested ones included, and whatever an
 * update attached is dropped along with the object that held it. Shallow copies make this one pass over the state,
 * the same order as the serialization the write does anyway.
 */
type Container = Record<string, unknown> | unknown[]
type StateSnapshot = ReadonlyArray<readonly [Container, Container]>

const snapshotState = (state: StoreState): StateSnapshot => {
  const copies = new Map<Container, Container>()
  const visit = (value: unknown): void => {
    if (typeof value !== "object" || value === null || copies.has(value as Container)) return
    const container = value as Container
    copies.set(container, Array.isArray(container) ? [...container] : { ...container })
    for (const child of Object.values(container)) visit(child)
  }
  visit(state)
  return [...copies]
}

const restoreState = (snapshot: StateSnapshot): void => {
  for (const [container, copy] of snapshot) {
    if (Array.isArray(container)) {
      container.length = 0
      for (const item of copy as unknown[]) container.push(item)
    } else {
      for (const key of Object.keys(container)) delete container[key]
      Object.assign(container, copy)
    }
  }
}

export const StateLive = Layer.effect(
  StateStore,
  Effect.gen(function* () {
    const config = yield* Config
    yield* Effect.tryPromise({
      try: async () => {
        await mkdir(config.mirrorsDir, { recursive: true })
        await mkdir(config.threadsDir, { recursive: true })
        await mkdir(config.shadowsDir, { recursive: true })
        await mkdir(config.runsDir, { recursive: true })
        await mkdir(config.attachmentsDir, { recursive: true })
      },
      catch: (e) => new InternalError({ message: `cannot create data dirs: ${String(e)}` }),
    })
    yield* migrateLegacyState(config)
    const state = yield* loadFile(config.stateFile)
    reconcile(state)

    // Updates run one at a time, each against the state the previous one committed. A rejected or unwritten update is
    // rolled back before the next one runs, so its mutations can never ride along in a later write.
    // `state` is the working copy an update mutates in place; `committed` is what `read` returns. It is replaced only
    // after a write lands, so no reader sees a mutation that is still in flight or that a failed write rolls back.
    let committed: Readonly<StoreState> = structuredClone(state)
    let lane: Promise<void> = Promise.resolve()
    const commit = <A, E>(f: (s: StoreState) => Either.Either<A, E>): Promise<Either.Either<UpdateOutcome<A>, E | InternalError>> => {
      const run = lane.then(async (): Promise<Either.Either<UpdateOutcome<A>, E | InternalError>> => {
        const snapshot = snapshotState(state)
        let result: Either.Either<A, E>
        try {
          result = f(state)
        } catch (e) {
          restoreState(snapshot)
          throw e
        }
        if (Either.isLeft(result)) {
          restoreState(snapshot)
          return Either.left(result.left)
        }
        try {
          await replaceFile(config.stateFile, JSON.stringify(state))
        } catch (e) {
          restoreState(snapshot)
          return Either.left(new InternalError({ message: `state write failed, update not applied: ${String(e)}` }))
        }
        // The rename landed, so the file holds the new state and the update is applied: publish it before the directory
        // sync, whose failure only leaves durability unconfirmed (a crash may still roll the rename back).
        committed = structuredClone(state)
        try {
          await syncDir(config.stateFile)
        } catch (e) {
          return Either.right({
            _tag: "unconfirmed",
            value: result.right,
            cause: `state update applied and visible, but its directory sync failed: durability unconfirmed, do not treat as not applied: ${String(e)}`,
          })
        }
        return Either.right({ _tag: "applied", value: result.right })
      })
      lane = run.then(() => undefined, () => undefined)
      return run
    }

    const updateOutcome = <A, E>(f: (s: StoreState) => Either.Either<A, E>): Effect.Effect<UpdateOutcome<A>, E | InternalError> =>
      Effect.flatMap(
        Effect.promise(() => commit(f)),
        (result): Effect.Effect<UpdateOutcome<A>, E | InternalError> =>
          Either.isLeft(result) ? Effect.fail(result.left) : Effect.succeed(result.right),
      )

    const shape: StoreShape = {
      read: Effect.sync(() => committed),
      // An unconfirmed write fails here with its applied message: callers that go on with what it reserved use updateOutcome.
      update: <A, E>(f: (s: StoreState) => Either.Either<A, E>): Effect.Effect<A, E | InternalError> =>
        Effect.flatMap(updateOutcome(f), (outcome): Effect.Effect<A, InternalError> =>
          outcome._tag === "applied" ? Effect.succeed(outcome.value) : Effect.fail(new InternalError({ message: outcome.cause })),
        ),
      updateOutcome,
      flush: Effect.promise(() => lane),
    }
    return shape
  }),
)
