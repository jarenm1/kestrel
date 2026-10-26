import { Context, Effect, Either, Layer } from "effect"
import { rm } from "node:fs/promises"
import { join } from "node:path"
import {
  BadRequest,
  Conflict,
  DesktopStatus,
  DiffResponse,
  InternalError,
  Message,
  NotFound,
  Repo,
  Run,
  SendMessageResponse,
  Task,
  type TaskStatus,
} from "@cloudagents/protocol"
import { Config } from "../config"
import { DesktopError, DesktopManager } from "../desktop"
import { CredentialStore } from "../credentials"
import { EventHub } from "./events"
import { AgentHarness } from "./harness"
import { newId, nowIso, StateStore, type StoreState } from "./state"
import { WorkspaceService } from "./workspace"

export interface ReportInput {
  readonly status: TaskStatus
  readonly message: string
}

export interface CoreShape {
  readonly health: () => Effect.Effect<void>

  readonly listRepos: () => Effect.Effect<ReadonlyArray<Repo>>
  readonly getRepo: (id: string) => Effect.Effect<Repo, NotFound>
  readonly createRepo: (url: string, name?: string) => Effect.Effect<Repo, BadRequest | InternalError>
  readonly deleteRepo: (id: string) => Effect.Effect<void, NotFound | InternalError>

  readonly listTasks: (repoId: string) => Effect.Effect<ReadonlyArray<Task>, NotFound>
  readonly createTask: (
    repoId: string,
    input: { readonly title?: string; readonly baseBranch?: string },
  ) => Effect.Effect<Task, NotFound | InternalError>
  readonly getTask: (id: string) => Effect.Effect<Task, NotFound>
  readonly deleteTask: (id: string) => Effect.Effect<void, NotFound | InternalError>
  readonly diff: (taskId: string) => Effect.Effect<DiffResponse, NotFound | InternalError>

  readonly listMessages: (taskId: string) => Effect.Effect<ReadonlyArray<Message>, NotFound>
  readonly sendMessage: (
    taskId: string,
    text: string,
  ) => Effect.Effect<SendMessageResponse, NotFound | Conflict | BadRequest | InternalError>

  readonly listRuns: (taskId: string) => Effect.Effect<ReadonlyArray<Run>, NotFound>
  readonly cancelRun: (runId: string) => Effect.Effect<Run, NotFound | Conflict | InternalError>

  readonly desktopStatus: (taskId: string) => Effect.Effect<DesktopStatus, NotFound>
  readonly desktopStart: (
    taskId: string,
  ) => Effect.Effect<DesktopStatus, NotFound | InternalError>
  readonly desktopStop: (taskId: string) => Effect.Effect<void, NotFound>

  /** Used by the MCP handler: agent-reported status and optional message. */
  readonly report: (taskId: string, input: ReportInput) => Effect.Effect<void, NotFound | InternalError>
  /** Used by the MCP handler: runs a shell command in the task worktree. */
  readonly execInTask: (
    taskId: string,
    command: string,
    timeoutMs: number,
  ) => Effect.Effect<{ exitCode: number; stdout: string; stderr: string }, NotFound | InternalError>

  /** Cancels active runs and stops desktops. */
  readonly shutdown: () => Effect.Effect<void>
}

export class CoreService extends Context.Tag("cloudagents/CoreService")<CoreService, CoreShape>() {}

const toInternal = (what: string) => (e: { readonly message: string }) =>
  new InternalError({ message: `${what}: ${e.message}` })

const slugify = (title: string): string => {
  const slug = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40)
  return slug === "" ? "task" : slug
}

const repoNameFromUrl = (url: string): string => {
  const last = url.replace(/\/+$/, "").split(/[/:]/).pop() ?? ""
  const name = last.replace(/\.git$/, "")
  return name === "" ? "repo" : name
}

export const CoreLive = Layer.effect(
  CoreService,
  Effect.gen(function* () {
    const config = yield* Config
    const store = yield* StateStore
    const hub = yield* EventHub
    const harness = yield* AgentHarness
    const desktop = yield* DesktopManager
    const workspace = yield* WorkspaceService
    const credentials = yield* CredentialStore

    // Desktop status changes are pushed to every task's event stream.
    yield* desktop.watchStatus((desktopStatus) => hub.publish({ _tag: "desktop.updated", desktop: desktopStatus }))

    const findTask = (state: Readonly<StoreState>, taskId: string) =>
      Either.fromNullable(
        state.tasks.find((t) => t.id === taskId),
        () => new NotFound({ message: `task ${taskId} not found` }),
      )

    const requireTask = (taskId: string): Effect.Effect<Task, NotFound> =>
      Effect.flatMap(store.read, (state) => Either.match(findTask(state, taskId), {
        onLeft: (e) => Effect.fail(e),
        onRight: (t) => Effect.succeed({ ...t }),
      }))

    const requireRepo = (repoId: string): Effect.Effect<Repo, NotFound> =>
      Effect.flatMap(store.read, (state) => {
        const repo = state.repos.find((r) => r.id === repoId)
        return repo ? Effect.succeed({ ...repo }) : Effect.fail(new NotFound({ message: `repo ${repoId} not found` }))
      })

    const requireRun = (runId: string): Effect.Effect<Run, NotFound> =>
      Effect.flatMap(store.read, (state) => {
        const run = state.runs.find((r) => r.id === runId)
        return run ? Effect.succeed({ ...run }) : Effect.fail(new NotFound({ message: `run ${runId} not found` }))
      })

    const publishMessage = (message: Message) => hub.publish({ _tag: "message.created", message })

    const removeTaskState = (taskId: string) =>
      store.update((s): Either.Either<void, never> => {
        s.tasks = s.tasks.filter((t) => t.id !== taskId)
        s.messages = s.messages.filter((m) => m.taskId !== taskId)
        s.runs = s.runs.filter((r) => r.taskId !== taskId)
        return Either.right(undefined)
      })

    const deleteTask = (taskId: string): Effect.Effect<void, NotFound | InternalError> =>
      Effect.gen(function* () {
        const task = yield* requireTask(taskId)
        const state = yield* store.read
        const repo = state.repos.find((r) => r.id === task.repoId)
        for (const run of state.runs) {
          if (run.taskId === taskId && run.status === "running") {
            yield* harness.cancel(run.id)
          }
        }
        yield* desktop.stop(taskId)
        if (repo) {
          yield* workspace
            .removeWorktree(repo.localPath, task.worktreePath)
            .pipe(Effect.mapError(toInternal("remove worktree")))
          yield* workspace.deleteBranch(repo.localPath, task.branch).pipe(Effect.mapError(toInternal("delete branch")))
        }
        yield* removeTaskState(taskId)
      })

    const createTask: CoreShape["createTask"] = (repoId, input) =>
      Effect.gen(function* () {
        const repo = yield* requireRepo(repoId)
        const title = input.title?.trim() || "Untitled task"
        const baseBranch = input.baseBranch?.trim() || repo.defaultBranch
        const id = newId()
        const branch = `cloudagents/${slugify(title)}-${id.replace(/-/g, "").slice(0, 6)}`
        const worktreePath = join(config.worktreesDir, id)
        yield* workspace
          .createWorktree({ repoPath: repo.localPath, branch, baseBranch, worktreePath })
          .pipe(Effect.mapError(toInternal("create worktree")))
        const now = nowIso()
        const task: Task = {
          id,
          repoId,
          title,
          branch,
          baseBranch,
          worktreePath,
          status: "idle",
          createdAt: now,
          updatedAt: now,
        }
        yield* store.update((s): Either.Either<void, never> => {
          s.tasks.push(task)
          return Either.right(undefined)
        })
        return { ...task }
      })

    const sendMessage: CoreShape["sendMessage"] = (taskId, text) =>
      Effect.gen(function* () {
        if (text.trim() === "") {
          return yield* Effect.fail(new BadRequest({ message: "message text is required" }))
        }
        const reserved = yield* store.update(
          (
            s,
          ): Either.Either<
            { task: Task; message: Message; run: Run },
            NotFound | Conflict
          > => {
            const found = findTask(s, taskId)
            if (Either.isLeft(found)) return Either.left(found.left)
            const task = found.right
            if (s.runs.some((r) => r.taskId === taskId && r.status === "running")) {
              return Either.left(new Conflict({ message: "a run is already in progress for this task" }))
            }
            const now = nowIso()
            const run: Run = {
              id: newId(),
              taskId,
              prompt: text,
              status: "running",
              startedAt: now,
              endedAt: null,
              exitCode: null,
            }
            const message: Message = { id: newId(), taskId, role: "user", text, runId: run.id, createdAt: now }
            task.status = "running"
            task.updatedAt = now
            s.runs.push(run)
            s.messages.push(message)
            return Either.right({ task: { ...task }, message, run: { ...run } })
          },
        )
        hub.publish({ _tag: "task.updated", task: reserved.task })
        publishMessage(reserved.message)
        hub.publish({ _tag: "run.updated", run: reserved.run })

        const taskNow = yield* requireTask(taskId)
        const started = yield* desktop.start(taskId, { cwd: taskNow.worktreePath }).pipe(Effect.either)
        let display: string | null = null
        const desktopProblem: string | null = Either.isLeft(started)
          ? started.left.message
          : started.right.state === "failed"
            ? (started.right.error ?? "desktop failed to start")
            : null
        if (desktopProblem === null && Either.isRight(started)) {
          display = started.right.display
        } else {
          // The run still goes ahead without a display; the user is told why.
          const notice = yield* store.update((s): Either.Either<Message, never> => {
            const message: Message = {
              id: newId(),
              taskId,
              role: "system",
              text: `Desktop unavailable: ${desktopProblem ?? "unknown error"}`,
              runId: reserved.run.id,
              createdAt: nowIso(),
            }
            s.messages.push(message)
            return Either.right(message)
          })
          publishMessage(notice)
        }

        yield* harness.spawn(taskNow, reserved.run, text, display)
        return { message: reserved.message, run: reserved.run }
      })

    const shape: CoreShape = {
      health: () => Effect.void,

      listRepos: () => Effect.map(store.read, (s) => s.repos.map((r) => ({ ...r }))),

      getRepo: (id) => requireRepo(id),

      createRepo: (url, name) =>
        Effect.gen(function* () {
          if (url.trim() === "") return yield* Effect.fail(new BadRequest({ message: "url is required" }))
          const id = newId()
          const localPath = join(config.reposDir, id)
          const creds = yield* credentials.get
          yield* workspace
            .cloneRepo(url, localPath, { githubToken: creds?.github })
            .pipe(Effect.mapError(toInternal("clone")))
          const defaultBranch = yield* workspace
            .defaultBranch(localPath)
            .pipe(Effect.mapError(toInternal("read default branch")))
          const repo: Repo = {
            id,
            name: name?.trim() || repoNameFromUrl(url),
            url,
            localPath,
            defaultBranch,
            createdAt: nowIso(),
          }
          yield* store.update((s): Either.Either<void, never> => {
            s.repos.push(repo)
            return Either.right(undefined)
          })
          return { ...repo }
        }),

      deleteRepo: (id) =>
        Effect.gen(function* () {
          const repo = yield* requireRepo(id)
          const state = yield* store.read
          for (const task of state.tasks) {
            if (task.repoId === id) yield* deleteTask(task.id)
          }
          yield* Effect.tryPromise({
            try: () => rm(repo.localPath, { recursive: true, force: true }),
            catch: (e) => new InternalError({ message: `remove clone: ${String(e)}` }),
          })
          yield* store.update((s): Either.Either<void, never> => {
            s.repos = s.repos.filter((r) => r.id !== id)
            return Either.right(undefined)
          })
        }),

      listTasks: (repoId) =>
        Effect.gen(function* () {
          yield* requireRepo(repoId)
          const state = yield* store.read
          return state.tasks.filter((t) => t.repoId === repoId).map((t) => ({ ...t }))
        }),

      createTask,

      getTask: (id) => requireTask(id),

      deleteTask,

      diff: (taskId) =>
        Effect.gen(function* () {
          const task = yield* requireTask(taskId)
          const diff = yield* workspace
            .diff(task.worktreePath, task.baseBranch)
            .pipe(Effect.mapError(toInternal("diff")))
          return { baseBranch: task.baseBranch, diff }
        }),

      listMessages: (taskId) =>
        Effect.gen(function* () {
          yield* requireTask(taskId)
          const state = yield* store.read
          return state.messages.filter((m) => m.taskId === taskId).map((m) => ({ ...m }))
        }),

      sendMessage,

      listRuns: (taskId) =>
        Effect.gen(function* () {
          yield* requireTask(taskId)
          const state = yield* store.read
          return state.runs.filter((r) => r.taskId === taskId).map((r) => ({ ...r }))
        }),

      cancelRun: (runId) =>
        Effect.gen(function* () {
          const run = yield* requireRun(runId)
          if (run.status !== "running") {
            return yield* Effect.fail(new Conflict({ message: `run ${runId} is ${run.status}` }))
          }
          yield* harness.cancel(runId)
          return yield* requireRun(runId)
        }),

      desktopStatus: (taskId) => Effect.zipRight(requireTask(taskId), desktop.status(taskId)),

      desktopStart: (taskId) =>
        Effect.gen(function* () {
          const task = yield* requireTask(taskId)
          return yield* desktop
            .start(taskId, { cwd: task.worktreePath })
            .pipe(Effect.mapError((e: DesktopError) => new InternalError({ message: e.message })))
        }),

      desktopStop: (taskId) => Effect.zipRight(requireTask(taskId), desktop.stop(taskId)),

      report: (taskId, input) =>
        Effect.gen(function* () {
          const updated = yield* store.update(
            (s): Either.Either<{ task: Task; message: Message | null }, NotFound> => {
              const found = findTask(s, taskId)
              if (Either.isLeft(found)) return Either.left(found.left)
              const task = found.right
              const now = nowIso()
              task.status = input.status
              task.updatedAt = now
              const trimmed = input.message.trim()
              let message: Message | null = null
              if (trimmed !== "") {
                const run = s.runs.find((r) => r.taskId === taskId && r.status === "running")
                message = { id: newId(), taskId, role: "agent", text: trimmed, runId: run?.id ?? null, createdAt: now }
                s.messages.push(message)
              }
              return Either.right({ task: { ...task }, message })
            },
          )
          hub.publish({ _tag: "task.updated", task: updated.task })
          if (updated.message) publishMessage(updated.message)
        }),

      execInTask: (taskId, command, timeoutMs) =>
        Effect.gen(function* () {
          const task = yield* requireTask(taskId)
          return yield* workspace
            .exec(task.worktreePath, command, { timeoutMs })
            .pipe(Effect.mapError(toInternal("exec")))
        }),

      shutdown: () =>
        Effect.gen(function* () {
          yield* harness.stopAll()
          yield* desktop.stopAll()
        }),
    }
    return shape
  }),
)
