import { Context, Effect, Either, Layer, Schema } from "effect"
import { randomUUID } from "node:crypto"
import { mkdir, readFile, rename, writeFile } from "node:fs/promises"
import { InternalError, Message, Repo, Run, Task } from "@cloudagents/protocol"
import { Config } from "../config"

export const newId = (): string => randomUUID()
export const nowIso = (): string => new Date().toISOString()

/** Projects saved before ownership existed have no `owner`; `loadFile` drops them. */
const PersistedRepo = Schema.Struct({ ...Repo.fields, owner: Schema.optional(Schema.String) })

const PersistedState = Schema.Struct({
  repos: Schema.Array(PersistedRepo),
  tasks: Schema.Array(Task),
  messages: Schema.Array(Message),
  runs: Schema.Array(Run),
})

export type Mutable<T> = { -readonly [K in keyof T]: T[K] }

export interface StoreState {
  repos: Mutable<Repo>[]
  tasks: Mutable<Task>[]
  messages: Mutable<Message>[]
  runs: Mutable<Run>[]
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

const writeAtomic = async (file: string, data: string): Promise<void> => {
  const tmp = `${file}.${randomUUID()}.tmp`
  await writeFile(tmp, data, "utf8")
  await rename(tmp, file)
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
    if (raw === null) return { repos: [], tasks: [], messages: [], runs: [] }
    const decoded = yield* Schema.decodeUnknown(Schema.parseJson(PersistedState))(raw).pipe(
      Effect.mapError((e) => new InternalError({ message: `corrupt state file ${file}: ${e.message}` })),
    )
    const repos: Repo[] = []
    for (const r of decoded.repos) {
      if (r.owner) repos.push({ ...r, owner: r.owner })
      else yield* Effect.logWarning(`dropping project ${r.id} (${r.name}): it has no owner; its clone stays at ${r.localPath}`)
    }
    const taskIds = new Set(decoded.tasks.filter((t) => repos.some((r) => r.id === t.repoId)).map((t) => t.id))
    return {
      repos,
      tasks: decoded.tasks.filter((t) => taskIds.has(t.id)),
      messages: decoded.messages.filter((m) => taskIds.has(m.taskId)),
      runs: decoded.runs.filter((r) => taskIds.has(r.taskId)),
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
        await mkdir(config.reposDir, { recursive: true })
        await mkdir(config.worktreesDir, { recursive: true })
        await mkdir(config.runsDir, { recursive: true })
        await mkdir(config.attachmentsDir, { recursive: true })
      },
      catch: (e) => new InternalError({ message: `cannot create data dirs: ${String(e)}` }),
    })
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
