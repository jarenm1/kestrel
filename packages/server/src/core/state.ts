import { Context, Effect, Either, Layer, Schema } from "effect"
import { randomUUID } from "node:crypto"
import { mkdir, readFile } from "node:fs/promises"
import { InternalError, Message, Run, Task } from "@cloudagents/protocol"
import { Config } from "../config"
import { writeAtomic } from "./atomic"
import { migrateLegacyState } from "./migrate"

export const newId = (): string => randomUUID()
export const nowIso = (): string => new Date().toISOString()

/** A `task_ask` question still waiting for the user. Kept across restarts; at most one per task. */
const PendingAskRecord = Schema.Struct({ taskId: Schema.String, runId: Schema.String, messageId: Schema.String })
/** The agent session a run started, so the task's next run can resume it. */
const RunSessionRecord = Schema.Struct({ runId: Schema.String, sessionId: Schema.String })
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
}

export class StateStore extends Context.Tag("cloudagents/StateStore")<StateStore, StoreShape>() {}

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
    const decoded = yield* Schema.decodeUnknown(Schema.parseJson(PersistedState))(raw).pipe(
      Effect.mapError((e) => new InternalError({ message: `corrupt state file ${file}: ${e.message}` })),
    )
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
  }
  for (const task of state.tasks) {
    if (task.status === "running") task.status = "failed"
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
    }
    return shape
  }),
)
