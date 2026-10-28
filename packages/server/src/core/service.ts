import { Context, Data, Deferred, Effect, Either, Layer } from "effect"
import { readFile, rm, writeFile } from "node:fs/promises"
import { join } from "node:path"
import {
  BadRequest,
  Conflict,
  DesktopStatus,
  DiffResponse,
  InternalError,
  Message,
  type Attachment,
  NotFound,
  PullRequestLink,
  Repo,
  Run,
  SendMessageResponse,
  Task,
  type TaskStatus,
} from "@cloudagents/protocol"
import { Config } from "../config"
import { DesktopError, DesktopManager } from "../desktop"
import { CredentialStore } from "../credentials"
import { GitHub, GitHubError, parseGitHubRepo, type NewReview, type PostedReview, type PullRequest, type PullRequestStatus } from "../github/api"
import { prepareLaunch, removeTask, runProcess, sandboxSettingsOf, stopAllTaskNets, stopTaskNet, type LaunchKind, type ProcessResult } from "../sandbox"
import { EventHub } from "./events"
import { AgentHarness, type AgentChoice } from "./harness"
import { newId, nowIso, StateStore, type StoreState } from "./state"
import { WorkspaceService, taskBaseRef } from "./workspace"

/** Bytes an agent attaches to a message (e.g. a desktop screenshot); core stores them and serves them over REST. */
export interface AttachmentInput {
  readonly mimeType: string
  readonly bytes: Uint8Array
}

/** Larger attachments are refused: they are kept on the box disk and served from it. */
const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024

export interface ReportInput {
  readonly status: TaskStatus
  readonly message: string
  readonly attachments?: ReadonlyArray<AttachmentInput>
}

export interface OpenPullRequestInput {
  readonly title: string
  readonly body: string
  readonly draft: boolean
}

export interface ReviewPullRequestInput extends NewReview {
  /** Number of the pull request in the task's GitHub repository. */
  readonly number: number
}

export interface OpenedPullRequest {
  readonly pullRequest: PullRequest
  /** False when an open pull request for the branch already existed and was returned instead. */
  readonly created: boolean
}

export interface AskInput {
  readonly question: string
  readonly options: ReadonlyArray<string>
  readonly attachments?: ReadonlyArray<AttachmentInput>
}

/** The question's wait ended without an answer because the run ended first. */
export class AskError extends Data.TaggedError("AskError")<{ readonly message: string }> {}

/** How a question's wait ended: the user's reply, or the run ended first. */
type AskOutcome = { readonly _tag: "answered"; readonly text: string } | { readonly _tag: "ended" }

export interface CoreShape {
  readonly health: () => Effect.Effect<void>

  // Every browser-facing operation takes the signed-in `user`. A project and its tasks, runs and
  // desktops exist only for the project's owner: anyone else gets NotFound, never a hint it exists.
  readonly listRepos: (user: string) => Effect.Effect<ReadonlyArray<Repo>>
  readonly getRepo: (user: string, id: string) => Effect.Effect<Repo, NotFound>
  readonly createRepo: (user: string, url: string, name?: string) => Effect.Effect<Repo, BadRequest | InternalError>
  readonly deleteRepo: (user: string, id: string) => Effect.Effect<void, NotFound | InternalError>

  readonly listTasks: (user: string, repoId: string) => Effect.Effect<ReadonlyArray<Task>, NotFound>
  readonly createTask: (
    user: string,
    repoId: string,
    input: { readonly title?: string; readonly baseBranch?: string; readonly fetch?: boolean; readonly pullRequest?: number },
  ) => Effect.Effect<Task, NotFound | BadRequest | InternalError>
  readonly getTask: (user: string, id: string) => Effect.Effect<Task, NotFound>
  readonly deleteTask: (user: string, id: string) => Effect.Effect<void, NotFound | InternalError>
  readonly diff: (user: string, taskId: string) => Effect.Effect<DiffResponse, NotFound | InternalError>

  readonly listMessages: (user: string, taskId: string) => Effect.Effect<ReadonlyArray<Message>, NotFound>
  readonly sendMessage: (
    user: string,
    taskId: string,
    text: string,
    choice: AgentChoice,
  ) => Effect.Effect<SendMessageResponse, NotFound | BadRequest | InternalError>

  readonly listRuns: (user: string, taskId: string) => Effect.Effect<ReadonlyArray<Run>, NotFound>
  readonly cancelRun: (user: string, runId: string) => Effect.Effect<Run, NotFound | Conflict | InternalError>

  readonly desktopStatus: (user: string, taskId: string) => Effect.Effect<DesktopStatus, NotFound>
  readonly desktopStart: (user: string, taskId: string) => Effect.Effect<DesktopStatus, NotFound | InternalError>
  readonly desktopStop: (user: string, taskId: string) => Effect.Effect<void, NotFound>

  /** Used by the MCP handler: a run's own status report. Fails unless `runId` is the task's running run. */
  readonly report: (taskId: string, runId: string, input: ReportInput) => Effect.Effect<void, NotFound | Conflict | BadRequest | InternalError>
  /** Used by the MCP handler: posts a question with options and waits for the user's answer. */
  readonly ask: (
    taskId: string,
    runId: string,
    input: AskInput,
  ) => Effect.Effect<string, NotFound | Conflict | BadRequest | InternalError | AskError>
  /** Used by the MCP handler: the run's user messages it has not seen yet; the returned messages are marked read. */
  readonly inbox: (taskId: string, runId: string) => Effect.Effect<ReadonlyArray<Message>>
  /** Bytes of an attachment on one of the signed-in user's task messages. */
  readonly attachment: (
    user: string,
    taskId: string,
    attachmentId: string,
  ) => Effect.Effect<{ readonly mimeType: string; readonly bytes: Uint8Array }, NotFound | InternalError>
  /** Used by the MCP handler to authorize a run token: the run with this id, if it exists. */
  readonly runFor: (runId: string) => Effect.Effect<Run | null>
  /** Used by the MCP handler: runs a shell command in the task worktree. */
  readonly execInTask: (taskId: string, command: string, timeoutMs: number) => Effect.Effect<ProcessResult, NotFound | InternalError>
  /** Used by the MCP handler: starts a sandboxed app on the task's live desktop and returns its id. */
  readonly desktopLaunch: (taskId: string, command: string) => Effect.Effect<string, NotFound | InternalError>
  /** Used by the MCP handler: pushes the task branch to its GitHub remote (never forced). Returns the branch. */
  readonly gitPush: (taskId: string) => Effect.Effect<string, NotFound | BadRequest | InternalError>
  /** Used by the MCP handler: pushes the task branch and opens its pull request, or returns the open one. */
  readonly openPullRequest: (
    taskId: string,
    input: OpenPullRequestInput,
  ) => Effect.Effect<OpenedPullRequest, NotFound | BadRequest | InternalError>
  /** Used by the MCP handler: live GitHub status of the task's pull request. */
  readonly pullRequestStatus: (taskId: string) => Effect.Effect<PullRequestStatus, NotFound | BadRequest | InternalError>
  /** Used by the MCP handler: posts a review on a pull request of the task's GitHub repository. APPROVE is never sent. */
  readonly reviewPullRequest: (
    taskId: string,
    input: ReviewPullRequestInput,
  ) => Effect.Effect<PostedReview, NotFound | BadRequest | InternalError>
  /** Used by the MCP handler: the project a task belongs to. Its owner is the user the task's automations act for. */
  readonly taskRepo: (taskId: string) => Effect.Effect<Repo, NotFound>

  /** Cancels active runs, stops desktops and tears down task networks. */
  readonly shutdown: () => Effect.Effect<void>
}

export class CoreService extends Context.Tag("cloudagents/CoreService")<CoreService, CoreShape>() {}

const toInternal = (what: string) => (e: { readonly message: string }) =>
  new InternalError({ message: `${what}: ${e.message}` })

const fromGitHub = (e: GitHubError) => new InternalError({ message: e.message })

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
    const github = yield* GitHub
    const sandboxSettings = sandboxSettingsOf(config)

    // Desktop status changes are pushed to every task's event stream.
    yield* desktop.watchStatus((desktopStatus) => hub.publish({ _tag: "desktop.updated", desktop: desktopStatus }))

    /** Every agent-controlled process goes through here: bubblewrap inside the task's systemd slice. */
    const launchFor = (task: Task, kind: LaunchKind, display: string | null, command: string) =>
      prepareLaunch({
        settings: sandboxSettings,
        taskId: task.id,
        kind,
        worktreePath: task.worktreePath,
        gitCommonDir: join(config.reposDir, task.repoId, ".git"),
        homeDir: join(config.homesDir, task.id),
        display,
        env: { CLOUDAGENTS_TASK_ID: task.id },
        command,
      })

    /** The desktop's terminal runs in the sandbox too: the agent can type into it. */
    const startDesktop = (task: Task) =>
      desktop.start(task.id, {
        terminal: (display) =>
          launchFor(task, "desktop", display, "exec xterm -geometry 100x30+40+40 -e bash").pipe(
            Effect.mapError((e) => new DesktopError({ message: e.message })),
          ),
      })

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

    /** `user`'s project; someone else's is reported exactly like a missing one. */
    const ownedRepo = (user: string, repoId: string): Effect.Effect<Repo, NotFound> =>
      Effect.flatMap(store.read, (state) => {
        const repo = state.repos.find((r) => r.id === repoId && r.owner === user)
        return repo ? Effect.succeed({ ...repo }) : Effect.fail(new NotFound({ message: `repo ${repoId} not found` }))
      })

    const ownsTask = (state: Readonly<StoreState>, user: string, taskId: string): boolean => {
      const task = state.tasks.find((t) => t.id === taskId)
      return task !== undefined && state.repos.some((r) => r.id === task.repoId && r.owner === user)
    }

    /** A task in one of `user`'s projects; anything else is NotFound. */
    const ownedTask = (user: string, taskId: string): Effect.Effect<Task, NotFound> =>
      Effect.flatMap(store.read, (state) =>
        ownsTask(state, user, taskId) ? requireTask(taskId) : Effect.fail(new NotFound({ message: `task ${taskId} not found` })),
      )

    const requireRun = (runId: string): Effect.Effect<Run, NotFound> =>
      Effect.flatMap(store.read, (state) => {
        const run = state.runs.find((r) => r.id === runId)
        return run ? Effect.succeed({ ...run }) : Effect.fail(new NotFound({ message: `run ${runId} not found` }))
      })

    const publishMessage = (message: Message) => hub.publish({ _tag: "message.created", message })

    const requireRepo = (repoId: string): Effect.Effect<Repo, NotFound> =>
      Effect.flatMap(store.read, (state) => {
        const repo = state.repos.find((r) => r.id === repoId)
        return repo ? Effect.succeed({ ...repo }) : Effect.fail(new NotFound({ message: `repo ${repoId} not found` }))
      })

    /** GitHub token of the repo owner; the token stays host-side and never reaches a sandbox. */
    const githubToken = (repo: Repo) =>
      Effect.gen(function* () {
        const token = (yield* credentials.get(repo.owner))?.github
        if (token === undefined || token === "") {
          return yield* Effect.fail(
            new BadRequest({ message: "no GitHub connection for this account: connect GitHub under Connections, then retry" }),
          )
        }
        return token
      })

    /** owner/name of a github.com repo plus its token; pull request tools need both. */
    const githubAccess = (repo: Repo) =>
      Effect.gen(function* () {
        const slug = parseGitHubRepo(repo.url)
        if (slug === null) {
          return yield* Effect.fail(new BadRequest({ message: `${repo.name} is not a github.com repository; pull requests need one` }))
        }
        return { slug, token: yield* githubToken(repo) }
      })

    /** Pushes the task branch (never forced; base branches refused). `token` is set for github.com remotes. */
    const pushTask = (repo: Repo, task: Task, token: string | undefined) =>
      Effect.gen(function* () {
        if (task.branch === task.baseBranch || task.branch === repo.defaultBranch) {
          return yield* Effect.fail(new BadRequest({ message: `refusing to push ${task.branch}: it is a base branch, not this task's branch` }))
        }
        yield* workspace
          .pushBranch({
            repoPath: repo.localPath,
            worktreePath: task.worktreePath,
            remoteUrl: repo.url,
            branch: task.branch,
            githubToken: token,
          })
          .pipe(Effect.mapError((e) => new InternalError({ message: e.message })))
      })

    /** Fetches `refspec` from the repo's remote into its clone. The owner's token authenticates github.com remotes; public repos need none. */
    const fetchFromOrigin = (repo: Repo, refspec: string) =>
      Effect.gen(function* () {
        const token = parseGitHubRepo(repo.url) === null ? undefined : (yield* credentials.get(repo.owner))?.github
        yield* workspace
          .fetchRef({ repoPath: repo.localPath, remoteUrl: repo.url, refspec, githubToken: token || undefined })
          .pipe(Effect.mapError((e) => new InternalError({ message: e.message })))
      })

    /** Stores the pull request on the task; `announce` also posts a chat note (used when it was just opened). */
    const recordPullRequest = (taskId: string, link: PullRequestLink, announce: boolean) =>
      Effect.gen(function* () {
        const updated = yield* store.update(
          (s): Either.Either<{ task: Task; message: Message | null }, NotFound> => {
            const found = findTask(s, taskId)
            if (Either.isLeft(found)) return Either.left(found.left)
            const task = found.right
            const now = nowIso()
            task.pullRequest = link
            task.updatedAt = now
            let message: Message | null = null
            if (announce) {
              message = {
                id: newId(),
                taskId,
                role: "system",
                text: `Opened pull request #${link.number}: ${link.url}`,
                runId: null,
                createdAt: now,
              }
              s.messages.push(message)
            }
            return Either.right({ task: { ...task }, message })
          },
        )
        hub.publish({ _tag: "task.updated", task: updated.task })
        if (updated.message) publishMessage(updated.message)
      })

    /** Live `task_ask` calls by run, each waiting for the user's answer. A question persists in `pendingAsks` regardless. */
    const liveAsks = new Map<string, Deferred.Deferred<AskOutcome>>()
    /** User messages each run has taken, from its inbox or as an answer. Forgotten once the run ends. */
    const seenByRun = new Map<string, Set<string>>()
    const seenFor = (runId: string): Set<string> => {
      const seen = seenByRun.get(runId) ?? new Set<string>()
      seenByRun.set(runId, seen)
      return seen
    }

    /** Writes attachment bytes under the attachments dir; the message only carries their metadata. */
    const storeAttachments = (
      inputs: ReadonlyArray<AttachmentInput> | undefined,
    ): Effect.Effect<Attachment[], BadRequest | InternalError> => {
      const oversize = (inputs ?? []).find((input) => input.bytes.byteLength > MAX_ATTACHMENT_BYTES)
      if (oversize) {
        return Effect.fail(
          new BadRequest({ message: `attachment is ${oversize.bytes.byteLength} bytes; the limit is ${MAX_ATTACHMENT_BYTES}` }),
        )
      }
      return Effect.forEach(inputs ?? [], (input) => {
        const id = newId()
        return Effect.tryPromise({
          try: () => writeFile(join(config.attachmentsDir, id), input.bytes),
          catch: (e) => new InternalError({ message: `store attachment: ${String(e)}` }),
        }).pipe(Effect.as({ id, mimeType: input.mimeType }))
      })
    }

    const removeTaskState = (taskId: string) =>
      Effect.gen(function* () {
        const attachmentIds = yield* store.update((s): Either.Either<string[], never> => {
          const ids = s.messages.filter((m) => m.taskId === taskId).flatMap((m) => (m.attachments ?? []).map((a) => a.id))
          const runIds = new Set(s.runs.filter((r) => r.taskId === taskId).map((r) => r.id))
          s.tasks = s.tasks.filter((t) => t.id !== taskId)
          s.messages = s.messages.filter((m) => m.taskId !== taskId)
          s.runs = s.runs.filter((r) => r.taskId !== taskId)
          s.pendingAsks = s.pendingAsks.filter((a) => a.taskId !== taskId)
          s.runSessions = s.runSessions.filter((x) => !runIds.has(x.runId))
          return Either.right(ids)
        })
        yield* Effect.forEach(
          attachmentIds,
          (id) =>
            Effect.tryPromise(() => rm(join(config.attachmentsDir, id), { force: true })).pipe(
              Effect.catchAll((e) => Effect.logWarning(`attachment ${id}: ${String(e)}`)),
            ),
          { discard: true },
        )
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
        stopTaskNet(taskId)
        if (sandboxSettings.systemd) {
          yield* removeTask(sandboxSettings.systemd, taskId).pipe(
            Effect.catchAll((e) => Effect.logWarning(`task ${taskId}: ${e.message}`)),
          )
        }
        if (repo) {
          yield* workspace
            .removeWorktree(repo.localPath, task.worktreePath)
            .pipe(Effect.mapError(toInternal("remove worktree")))
          yield* workspace.deleteBranch(repo.localPath, task.branch).pipe(Effect.mapError(toInternal("delete branch")))
          yield* workspace.deleteRef(repo.localPath, taskBaseRef(taskId)).pipe(Effect.mapError(toInternal("delete base ref")))
        }
        yield* removeTaskState(taskId)
      })

    const createTask: CoreShape["createTask"] = (user, repoId, input) =>
      Effect.gen(function* () {
        const repo = yield* ownedRepo(user, repoId)
        const title = input.title?.trim() || "Untitled task"
        const pullRequest = input.pullRequest
        if (pullRequest !== undefined && parseGitHubRepo(repo.url) === null) {
          return yield* Effect.fail(new BadRequest({ message: `${repo.name} is not a github.com repository; pull requests need one` }))
        }
        const baseBranch = input.baseBranch?.trim() || repo.defaultBranch
        const id = newId()
        const baseRef = taskBaseRef(id)
        if (input.fetch || pullRequest !== undefined) {
          yield* fetchFromOrigin(repo, `refs/heads/${baseBranch}:refs/heads/${baseBranch}`)
        }
        // The fork point is pinned per task, so later fetches that move a base branch or a pull request ref leave this task's diff alone.
        if (pullRequest !== undefined) {
          yield* fetchFromOrigin(repo, `+refs/pull/${pullRequest}/head:${baseRef}`)
        } else {
          yield* workspace
            .updateRef({ repoPath: repo.localPath, ref: baseRef, target: baseBranch })
            .pipe(Effect.mapError(toInternal("pin base")))
        }
        const branch = `cloudagents/${slugify(title)}-${id.replace(/-/g, "").slice(0, 6)}`
        const worktreePath = join(config.worktreesDir, id)
        yield* workspace.createWorktree({ repoPath: repo.localPath, branch, baseBranch: baseRef, worktreePath }).pipe(
          Effect.mapError(toInternal("create worktree")),
          Effect.tapError(() => workspace.deleteRef(repo.localPath, baseRef).pipe(Effect.ignore)),
        )
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

    const sendMessage: CoreShape["sendMessage"] = (user, taskId, text, choice) =>
      Effect.gen(function* () {
        yield* ownedTask(user, taskId)
        if (text.trim() === "") {
          return yield* Effect.fail(new BadRequest({ message: "message text is required" }))
        }
        const reserved = yield* store.update(
          (
            s,
          ): Either.Either<
            {
              task: Task
              message: Message
              run: Run
              answer: Deferred.Deferred<AskOutcome> | null
              start: { readonly prompt: string; readonly resumeSession: string | null } | null
            },
            NotFound
          > => {
            const found = findTask(s, taskId)
            if (Either.isLeft(found)) return Either.left(found.left)
            const task = found.right
            const now = nowIso()
            // Any message settles the task's question: it is the answer, or it is ignored once the question's run is gone.
            const ask = s.pendingAsks.find((a) => a.taskId === taskId) ?? null
            s.pendingAsks = s.pendingAsks.filter((a) => a.taskId !== taskId)
            const running = s.runs.find((r) => r.taskId === taskId && r.status === "running")
            if (running) {
              // Mid-run: the text joins the running run. If that run's call is still waiting on the question, it is
              // the answer; otherwise it waits in the run's inbox for task_inbox.
              const message: Message = { id: newId(), taskId, role: "user", text, runId: running.id, createdAt: now }
              const answer = ask?.runId === running.id ? (liveAsks.get(running.id) ?? null) : null
              if (answer) {
                liveAsks.delete(running.id)
                seenFor(running.id).add(message.id)
              }
              if (task.status === "needs_input") task.status = "running"
              task.updatedAt = now
              s.messages.push(message)
              return Either.right({ task: { ...task }, message, run: { ...running }, answer, start: null })
            }
            // No run is going. An answer to a question starts a run that resumes the session of the run that asked.
            const question = ask ? (s.messages.find((m) => m.id === ask.messageId)?.text ?? "") : null
            const resumeSession = ask ? (s.runSessions.find((x) => x.runId === ask.runId)?.sessionId ?? null) : null
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
            // The prompt is what the run starts with, not mail for its inbox.
            seenFor(run.id).add(message.id)
            const prompt =
              question === null
                ? text
                : `You asked the user: ${question}\nThe user answered: ${text}\nContinue the task from there.`
            return Either.right({
              task: { ...task },
              message,
              run: { ...run },
              answer: null,
              start: { prompt, resumeSession },
            })
          },
        )
        hub.publish({ _tag: "task.updated", task: reserved.task })
        publishMessage(reserved.message)
        if (reserved.answer) yield* Deferred.succeed(reserved.answer, { _tag: "answered", text })
        if (reserved.start === null) return { message: reserved.message, run: reserved.run }
        hub.publish({ _tag: "run.updated", run: reserved.run })

        const taskNow = yield* requireTask(taskId)
        const started = yield* startDesktop(taskNow).pipe(Effect.either)
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

        yield* harness.spawn(taskNow, reserved.run, reserved.start.prompt, display, user, reserved.start.resumeSession, choice)
        return { message: reserved.message, run: reserved.run }
      })

    /** Posts a question for the running run and waits for the user's answer. The question persists until it is answered. */
    const ask: CoreShape["ask"] = (taskId, runId, input) =>
      Effect.gen(function* () {
        const answer = yield* Deferred.make<AskOutcome>()
        // Subscribed before posting, so a run that ends in the meantime cannot be missed.
        const unsubscribe = hub.subscribe(taskId, (event) => {
          if (event._tag === "run.updated" && event.run.id === runId && event.run.status !== "running") {
            Deferred.unsafeDone(answer, Effect.succeed<AskOutcome>({ _tag: "ended" }))
          }
        })
        return yield* Effect.gen(function* () {
          const attachments = yield* storeAttachments(input.attachments)
          const posted = yield* store.update(
            (s): Either.Either<{ task: Task; message: Message }, NotFound | Conflict> => {
              const found = findTask(s, taskId)
              if (Either.isLeft(found)) return Either.left(found.left)
              const run = s.runs.find((r) => r.id === runId)
              if (!run || run.taskId !== taskId || run.status !== "running") {
                return Either.left(new Conflict({ message: `run ${runId} is not the running run of task ${taskId}` }))
              }
              // A question is replaced only when its call has gone (the call was dropped); a waiting one blocks.
              const pending = s.pendingAsks.find((a) => a.taskId === taskId)
              if (pending && (pending.runId !== runId || liveAsks.has(runId))) {
                return Either.left(new Conflict({ message: "a question is already waiting for an answer" }))
              }
              const task = found.right
              const now = nowIso()
              const message: Message = {
                id: newId(),
                taskId,
                role: "agent",
                text: input.question.trim(),
                runId,
                createdAt: now,
                options: [...input.options],
                attachments,
              }
              s.messages.push(message)
              s.pendingAsks = [
                ...s.pendingAsks.filter((a) => a.taskId !== taskId),
                { taskId, runId, messageId: message.id },
              ]
              task.status = "needs_input"
              task.updatedAt = now
              liveAsks.set(runId, answer)
              return Either.right({ task: { ...task }, message })
            },
          )
          hub.publish({ _tag: "task.updated", task: posted.task })
          publishMessage(posted.message)
          const outcome = yield* Deferred.await(answer)
          if (outcome._tag === "answered") return outcome.text
          return yield* Effect.fail(new AskError({ message: "the run ended before the user answered" }))
        }).pipe(
          Effect.ensuring(
            Effect.sync(() => {
              unsubscribe()
              if (liveAsks.get(runId) === answer) liveAsks.delete(runId)
            }),
          ),
        )
      })

    const inbox: CoreShape["inbox"] = (taskId, runId) =>
      Effect.map(store.read, (state) => {
        // Read state of runs that have ended is no longer needed.
        for (const id of seenByRun.keys()) {
          if (state.runs.find((r) => r.id === id)?.status !== "running") seenByRun.delete(id)
        }
        const seen = seenFor(runId)
        const unread = state.messages.filter(
          (m) => m.taskId === taskId && m.role === "user" && m.runId === runId && !seen.has(m.id),
        )
        for (const m of unread) seen.add(m.id)
        return unread.map((m) => ({ ...m }))
      })

    const attachment: CoreShape["attachment"] = (user, taskId, attachmentId) =>
      Effect.gen(function* () {
        yield* ownedTask(user, taskId)
        const state = yield* store.read
        const stored = state.messages
          .filter((m) => m.taskId === taskId)
          .flatMap((m) => m.attachments ?? [])
          .find((a) => a.id === attachmentId)
        if (!stored) return yield* Effect.fail(new NotFound({ message: `attachment ${attachmentId} not found` }))
        const bytes = yield* Effect.tryPromise({
          try: () => readFile(join(config.attachmentsDir, stored.id)),
          catch: (e) => new InternalError({ message: `read attachment: ${String(e)}` }),
        })
        return { mimeType: stored.mimeType, bytes }
      })

    const shape: CoreShape = {
      ask,
      inbox,
      attachment,
      health: () => Effect.void,

      listRepos: (user) => Effect.map(store.read, (s) => s.repos.filter((r) => r.owner === user).map((r) => ({ ...r }))),

      getRepo: ownedRepo,

      createRepo: (user, url, name) =>
        Effect.gen(function* () {
          if (url.trim() === "") return yield* Effect.fail(new BadRequest({ message: "url is required" }))
          const id = newId()
          const localPath = join(config.reposDir, id)
          // The clone authenticates as the requester, so GitHub decides which repositories they can import.
          const creds = yield* credentials.get(user)
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
            owner: user,
          }
          yield* store.update((s): Either.Either<void, never> => {
            s.repos.push(repo)
            return Either.right(undefined)
          })
          return { ...repo }
        }),

      deleteRepo: (user, id) =>
        Effect.gen(function* () {
          const repo = yield* ownedRepo(user, id)
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

      listTasks: (user, repoId) =>
        Effect.gen(function* () {
          yield* ownedRepo(user, repoId)
          const state = yield* store.read
          return state.tasks.filter((t) => t.repoId === repoId).map((t) => ({ ...t }))
        }),

      createTask,

      getTask: ownedTask,

      deleteTask: (user, id) => Effect.zipRight(ownedTask(user, id), deleteTask(id)),

      diff: (user, taskId) =>
        Effect.gen(function* () {
          const task = yield* ownedTask(user, taskId)
          const repoPath = join(config.reposDir, task.repoId)
          // Tasks created before the pin existed have no ref: their base is the branch they were forked from.
          const pinned = taskBaseRef(task.id)
          const pinnedExists = yield* workspace.refExists(repoPath, pinned).pipe(Effect.mapError(toInternal("diff")))
          const baseRef = pinnedExists ? pinned : task.baseBranch
          const diff = yield* workspace
            .diff({ repoPath, worktreePath: task.worktreePath, baseRef })
            .pipe(Effect.mapError(toInternal("diff")))
          return { baseBranch: task.baseBranch, diff }
        }),

      listMessages: (user, taskId) =>
        Effect.gen(function* () {
          yield* ownedTask(user, taskId)
          const state = yield* store.read
          return state.messages.filter((m) => m.taskId === taskId).map((m) => ({ ...m }))
        }),

      sendMessage,

      listRuns: (user, taskId) =>
        Effect.gen(function* () {
          yield* ownedTask(user, taskId)
          const state = yield* store.read
          return state.runs.filter((r) => r.taskId === taskId).map((r) => ({ ...r }))
        }),

      cancelRun: (user, runId) =>
        Effect.gen(function* () {
          const run = yield* requireRun(runId)
          const state = yield* store.read
          if (!ownsTask(state, user, run.taskId)) {
            return yield* Effect.fail(new NotFound({ message: `run ${runId} not found` }))
          }
          if (run.status !== "running") {
            return yield* Effect.fail(new Conflict({ message: `run ${runId} is ${run.status}` }))
          }
          yield* harness.cancel(runId)
          return yield* requireRun(runId)
        }),

      desktopStatus: (user, taskId) => Effect.zipRight(ownedTask(user, taskId), desktop.status(taskId)),

      desktopStart: (user, taskId) =>
        Effect.gen(function* () {
          const task = yield* ownedTask(user, taskId)
          return yield* startDesktop(task).pipe(
            Effect.mapError((e: DesktopError) => new InternalError({ message: e.message })),
          )
        }),

      desktopStop: (user, taskId) => Effect.zipRight(ownedTask(user, taskId), desktop.stop(taskId)),

      report: (taskId, runId, input) =>
        Effect.gen(function* () {
          const attachments = yield* storeAttachments(input.attachments)
          const updated = yield* store.update(
            (s): Either.Either<{ task: Task; message: Message | null }, NotFound | Conflict> => {
              const found = findTask(s, taskId)
              if (Either.isLeft(found)) return Either.left(found.left)
              // Only the task's running run may report, so a stale caller cannot leave the task in `running`.
              const run = s.runs.find((r) => r.id === runId)
              if (!run || run.taskId !== taskId || run.status !== "running") {
                return Either.left(new Conflict({ message: `run ${runId} is not the running run of task ${taskId}` }))
              }
              const task = found.right
              const now = nowIso()
              task.status = input.status
              task.updatedAt = now
              const trimmed = input.message.trim()
              let message: Message | null = null
              if (trimmed !== "" || attachments.length > 0) {
                message = { id: newId(), taskId, role: "agent", text: trimmed, runId, createdAt: now, attachments }
                s.messages.push(message)
              }
              return Either.right({ task: { ...task }, message })
            },
          )
          hub.publish({ _tag: "task.updated", task: updated.task })
          if (updated.message) publishMessage(updated.message)
        }),

      runFor: (runId) => Effect.map(store.read, (s) => {
        const run = s.runs.find((r) => r.id === runId)
        return run ? { ...run } : null
      }),

      execInTask: (taskId, command, timeoutMs) =>
        Effect.gen(function* () {
          const task = yield* requireTask(taskId)
          const desktopNow = yield* desktop.status(taskId)
          const launch = yield* launchFor(task, "exec", desktopNow.display, command).pipe(
            Effect.mapError(toInternal("exec")),
          )
          return yield* runProcess(launch.file, launch.args, {
            cwd: launch.cwd,
            env: launch.env,
            timeoutMs,
          }).pipe(Effect.mapError(toInternal("exec")))
        }),

      desktopLaunch: (taskId, command) =>
        Effect.gen(function* () {
          const task = yield* requireTask(taskId)
          const desktopNow = yield* desktop.status(taskId)
          if (desktopNow.display === null) {
            return yield* Effect.fail(new InternalError({ message: `desktop for task ${taskId} is not running` }))
          }
          const launch = yield* launchFor(task, "desktop", desktopNow.display, command).pipe(
            Effect.mapError(toInternal("desktop launch")),
          )
          const app = yield* desktop.launch(taskId, command, launch).pipe(Effect.mapError(toInternal("desktop launch")))
          return app.id
        }),
      taskRepo: (taskId) => Effect.flatMap(requireTask(taskId), (task) => requireRepo(task.repoId)),
      gitPush: (taskId) =>
        Effect.gen(function* () {
          const task = yield* requireTask(taskId)
          const repo = yield* requireRepo(task.repoId)
          const token = parseGitHubRepo(repo.url) === null ? undefined : yield* githubToken(repo)
          yield* pushTask(repo, task, token)
          return task.branch
        }),

      openPullRequest: (taskId, input) =>
        Effect.gen(function* () {
          const title = input.title.trim()
          if (title === "") return yield* Effect.fail(new BadRequest({ message: "pull request title is required" }))
          const task = yield* requireTask(taskId)
          const repo = yield* requireRepo(task.repoId)
          const { slug, token } = yield* githubAccess(repo)
          yield* pushTask(repo, task, token)
          const existing = yield* github.findOpenPullRequest(token, slug, task.branch).pipe(Effect.mapError(fromGitHub))
          const pullRequest =
            existing ??
            (yield* github
              .createPullRequest(token, slug, {
                title,
                body: input.body,
                head: task.branch,
                base: task.baseBranch,
                draft: input.draft,
              })
              .pipe(Effect.mapError(fromGitHub)))
          yield* recordPullRequest(taskId, { number: pullRequest.number, url: pullRequest.url }, existing === null)
          return { pullRequest, created: existing === null }
        }),

      pullRequestStatus: (taskId) =>
        Effect.gen(function* () {
          const task = yield* requireTask(taskId)
          const repo = yield* requireRepo(task.repoId)
          const { slug, token } = yield* githubAccess(repo)
          let number = task.pullRequest?.number
          if (number === undefined) {
            const found = yield* github.findOpenPullRequest(token, slug, task.branch).pipe(Effect.mapError(fromGitHub))
            if (found === null) {
              return yield* Effect.fail(
                new NotFound({ message: `no open pull request for ${task.branch}; open one with github_pr_create` }),
              )
            }
            yield* recordPullRequest(taskId, { number: found.number, url: found.url }, false)
            number = found.number
          }
          return yield* github.getPullRequestStatus(token, slug, number).pipe(Effect.mapError(fromGitHub))
        }),

      reviewPullRequest: (taskId, input) =>
        Effect.gen(function* () {
          const task = yield* requireTask(taskId)
          const repo = yield* requireRepo(task.repoId)
          const { slug, token } = yield* githubAccess(repo)
          return yield* github
            .createReview(token, slug, input.number, { body: input.body, event: input.event, comments: input.comments })
            .pipe(Effect.mapError(fromGitHub))
        }),

      shutdown: () =>
        Effect.gen(function* () {
          yield* harness.stopAll()
          yield* desktop.stopAll()
          stopAllTaskNets()
        }),
    }
    return shape
  }),
)
