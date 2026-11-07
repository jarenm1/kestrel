import { Context, Effect, Either, Layer, Schema } from "effect"
import { randomUUID } from "node:crypto"
import { mkdir, readFile } from "node:fs/promises"
import { InternalError, Message, Run, Task, ModelHarness, ModelProvider, DEFAULT_MODEL_PROVIDER } from "@cloudagents/protocol"
import { Config } from "../config"
import { writeAtomic } from "./atomic"
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
}

export interface StoreShape {
  /** Current state. Callers MUST NOT mutate it; use `update`. */
  readonly read: Effect.Effect<Readonly<StoreState>>
  /**
   * Runs `f` synchronously against the state. If `f` returns Right, the state is
   * persisted atomically before the effect succeeds. If it returns Left, nothing is
   * persisted, so `f` MUST validate before mutating.
   */
  readonly update: <A, E>(f: (s: StoreState) => Either.Either<A, E>) => Effect.Effect<A, E | InternalError>
  /** Resolves once every write made so far is on disk. */
  readonly flush: Effect.Effect<void>
}

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
    if (raw === null) return { tasks: [], messages: [], runs: [], pendingAsks: [], runSessions: [], uploads: [] }
    const parsed = yield* Schema.decodeUnknown(Schema.parseJson())(raw).pipe(
      Effect.mapError((e) => new InternalError({ message: `corrupt state file ${file}: ${e.message}` })),
    )
    const dropped = isObject(parsed) && dropRetiredHarnessState(parsed)
    const decoded = yield* Schema.decodeUnknown(PersistedState)(parsed).pipe(
      Effect.mapError((e) => new InternalError({ message: `corrupt state file ${file}: ${e.message}` })),
    )
    // Rewritten only once the rest of the file decoded, so a file with unrelated corruption keeps its bytes.
    if (dropped) {
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
    }
  })

/**
 * A run or task still marked running belongs to a previous server process, which is gone.
 * Mark them failed so the UI does not show work that cannot finish.
 */
const reconcile = (state: StoreState): void => {
  const now = new Date().toISOString()
  for (const run of state.runs) {
    if (run.status !== "running") continue
    run.status = "failed"
    run.endedAt = now
    run.interruptedByRestart = true
  }
  for (const task of state.tasks) {
    if (task.status === "running") task.status = "failed"
    // A delegation persisted before dispatch lost its launching process during restart.
    if (task.delegation !== undefined && task.delegation.runId === undefined) task.status = "failed"
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

    // Writes are serialized; a failed write does not poison later ones.
    let queue: Promise<void> = Promise.resolve()
    const persist = (data: string) => {
      const write = queue.then(() => writeAtomic(config.stateFile, data))
      queue = write.catch(() => undefined)
      return write
    }

    const shape: StoreShape = {
      read: Effect.sync(() => state),
      update: <A, E>(f: (s: StoreState) => Either.Either<A, E>): Effect.Effect<A, E | InternalError> =>
        Effect.suspend((): Effect.Effect<A, E | InternalError> => {
          const result = f(state)
          if (Either.isLeft(result)) return Effect.fail(result.left)
          const data = JSON.stringify(state)
          return Effect.tryPromise({
            try: () => persist(data),
            catch: (e) => new InternalError({ message: `state write failed: ${String(e)}` }),
          }).pipe(Effect.as(result.right))
        }),
      flush: Effect.promise(() => queue),
    }
    return shape
  }),
)
