import { randomUUID } from "node:crypto"
import { copyFile, cp, lstat, readdir, readFile, rm, stat } from "node:fs/promises"
import { basename, join } from "node:path"
import { Effect, Schema } from "effect"
import { Checkout, InternalError, PullRequestLink, Task } from "@cloudagents/protocol"
import type { ServerConfig } from "../config"
import { writeAtomic } from "./atomic"
import { parseRepoRef, type RepoRef } from "./repo-ref"
import { checkoutPinRef, WorkspaceError, WorkspaceService } from "./workspace"

/*
 * State written before threads were chat-first: a project (`repos`) owned one clone at `<dataDir>/repos/<id>`, and
 * each task owned one git worktree at `<dataDir>/worktrees/<taskId>` on its own branch. Those directories stay on
 * disk; the migration copies what they hold into the new layout and never writes to them.
 */
const LegacyRepo = Schema.Struct({ id: Schema.String, url: Schema.String, owner: Schema.optional(Schema.String) })
const LegacyTask = Schema.Struct({
  id: Schema.String,
  repoId: Schema.String,
  title: Schema.String,
  branch: Schema.String,
  baseBranch: Schema.String,
  status: Task.fields.status,
  createdAt: Schema.String,
  updatedAt: Schema.String,
  pullRequest: Schema.optional(PullRequestLink),
  archivedAt: Schema.optional(Schema.String),
})
const LegacyState = Schema.Struct({ repos: Schema.Array(LegacyRepo), tasks: Schema.Array(LegacyTask) })

/** Makes `dir` mirror `from` (excluding `.git`): uncommitted edits, new files, and deletions all carry over. */
const copyWorktree = async (from: string, to: string): Promise<void> => {
  if (!(await stat(from).then((s) => s.isDirectory(), () => false))) return
  await pruneExtra(from, to)
  await cp(from, to, { recursive: true, force: true, verbatimSymlinks: true, filter: (src) => basename(src) !== ".git" })
}

/** Removes entries under `to` that `from` no longer has (or has with a different kind). Skips `.git`. */
const pruneExtra = async (from: string, to: string): Promise<void> => {
  for (const entry of await readdir(to, { withFileTypes: true })) {
    if (entry.name === ".git") continue
    const source = join(from, entry.name)
    const sourceStat = await lstat(source).catch(() => null)
    if (sourceStat === null || sourceStat.isDirectory() !== entry.isDirectory()) {
      await rm(join(to, entry.name), { recursive: true, force: true })
    } else if (entry.isDirectory()) {
      await pruneExtra(source, join(to, entry.name))
    }
  }
}

/** Old state is `repos`-shaped; any other shape is current and left alone. */
const readLegacyState = (file: string): Effect.Effect<Record<string, unknown> | null, InternalError> =>
  Effect.gen(function* () {
    const text = yield* Effect.tryPromise({ try: () => readFile(file, "utf8"), catch: (e) => e as NodeJS.ErrnoException }).pipe(
      Effect.catchAll((e) =>
        e.code === "ENOENT" ? Effect.succeed(null) : Effect.fail(new InternalError({ message: `cannot read ${file}: ${String(e)}` })),
      ),
    )
    if (text === null) return null
    const data = yield* Effect.try({
      try: () => JSON.parse(text) as Record<string, unknown>,
      catch: (e) => new InternalError({ message: `corrupt state file ${file}: ${String(e)}` }),
    })
    return "repos" in data ? data : null
  })

/** Imports the old clone's branches, remote branches and pinned bases into the mirror. No network. */
const importProject = (
  workspace: { readonly importClone: (args: { readonly mirrorPath: string; readonly cloneDir: string; readonly refspecs: ReadonlyArray<string> }) => Effect.Effect<void, WorkspaceError> },
  mirror: string,
  cloneDir: string,
): Effect.Effect<boolean> =>
  workspace
    .importClone({
      mirrorPath: mirror,
      cloneDir,
      refspecs: [
        "+refs/heads/*:refs/kestrel/migrate/heads/*",
        "+refs/remotes/origin/*:refs/kestrel/migrate/origin/*",
        "+refs/kestrel/base/*:refs/kestrel/migrate/base/*",
      ],
    })
    .pipe(
      Effect.as(true),
      Effect.catchAll((e) => Effect.logWarning(`old clone ${cloneDir} could not be imported: ${e.message}`).pipe(Effect.as(false))),
    )

/**
 * Creates the checkout for one legacy task: the old branch at its tip, the old uncommitted files copied in, and the
 * old base pinned. Fails (and the caller cleans up) if the old branch or base is missing.
 */
const migrateCheckout = (
  config: ServerConfig,
  ref: RepoRef,
  mirror: string,
  task: Schema.Schema.Type<typeof LegacyTask>,
): Effect.Effect<Checkout, WorkspaceError | InternalError, WorkspaceService> =>
  Effect.gen(function* () {
    const workspace = yield* WorkspaceService
    const startSha = yield* workspace.resolveRef(mirror, `refs/kestrel/migrate/heads/${task.branch}`)
    const baseSha =
      (yield* workspace.resolveRef(mirror, `refs/kestrel/migrate/base/${task.id}`)) ??
      (yield* workspace.resolveRef(mirror, `refs/kestrel/migrate/origin/${task.baseBranch}`)) ??
      (yield* workspace.resolveRef(mirror, `refs/kestrel/migrate/heads/${task.baseBranch}`))
    if (startSha === null || baseSha === null) {
      return yield* Effect.fail(
        new InternalError({ message: `branch ${task.branch} or its base ${task.baseBranch} is missing from the old clone` }),
      )
    }
    const checkoutId = randomUUID()
    const threadDir = join(config.threadsDir, task.id)
    const dir = join(threadDir, ref.name)
    yield* workspace.removePath(threadDir)
    yield* workspace.removePath(join(config.shadowsDir, task.id))
    yield* workspace.createCheckout({
      threadDir,
      dir,
      shadowPath: join(config.shadowsDir, task.id, `${checkoutId}.git`),
      mirrorPath: mirror,
      url: ref.url,
      branch: task.branch,
      startSha,
      baseSha,
      pinRef: checkoutPinRef(task.id, checkoutId),
    })
    yield* Effect.tryPromise({
      try: () => copyWorktree(join(config.dataDir, "worktrees", task.id), dir),
      catch: (e) => new InternalError({ message: `copy of the old worktree failed: ${String(e)}` }),
    })
    return {
      id: checkoutId,
      repo: ref.repo,
      dir: ref.name,
      branch: task.branch,
      baseBranch: task.baseBranch,
      createdAt: task.createdAt,
      ...(task.pullRequest === undefined ? {} : { pullRequest: task.pullRequest }),
    }
  })

/**
 * Rewrites a legacy state file in place, once. Each legacy project's owner becomes its threads' owner; each task
 * becomes a thread with one checkout (its branch, its uncommitted files, its pinned base). A thread whose checkout
 * cannot be rebuilt keeps no checkout and the failure is logged; it is never silently dropped.
 */
export const migrateLegacyState = (config: ServerConfig): Effect.Effect<void, InternalError, WorkspaceService> =>
  Effect.gen(function* () {
    const data = yield* readLegacyState(config.stateFile)
    if (data === null) return
    const legacy = yield* Schema.decodeUnknown(LegacyState)(data).pipe(
      Effect.mapError((e) => new InternalError({ message: `legacy state file ${config.stateFile} is invalid: ${e.message}` })),
    )
    const workspace = yield* WorkspaceService
    yield* Effect.logInfo(`migrating ${config.stateFile} to chat-first threads`)

    const tasks: Task[] = []
    for (const repo of legacy.repos) {
      const repoTasks = legacy.tasks.filter((t) => t.repoId === repo.id)
      if (repo.owner === undefined) {
        yield* Effect.logWarning(`dropping ${repoTasks.length} thread(s) of project ${repo.id}: the project has no owner`)
        continue
      }
      const ref = parseRepoRef(repo.url.replace(/^git@github\.com:/, "https://github.com/"))
      if (ref === null) {
        yield* Effect.logWarning(`project ${repo.id} has an unsupported clone URL; its threads keep no checkouts`)
      }
      const mirror = ref === null ? null : join(config.mirrorsDir, repo.owner, ref.mirrorRel)
      const imported =
        ref !== null && mirror !== null && repoTasks.length > 0
          ? yield* importProject(workspace, mirror, join(config.dataDir, "repos", repo.id))
          : false
      for (const task of repoTasks) {
        const checkouts: Checkout[] = []
        if (ref !== null && mirror !== null && imported) {
          const checkout = yield* migrateCheckout(config, ref, mirror, task).pipe(
            Effect.catchAll((e) =>
              Effect.logWarning(`thread ${task.id} keeps no checkout: ${e.message}`).pipe(
                Effect.zipRight(Effect.ignore(workspace.removePath(join(config.threadsDir, task.id)))),
                Effect.zipRight(Effect.ignore(workspace.removePath(join(config.shadowsDir, task.id)))),
                Effect.as(null),
              ),
            ),
          )
          if (checkout !== null) checkouts.push(checkout)
        }
        tasks.push({
          id: task.id,
          owner: repo.owner,
          title: task.title,
          status: task.status,
          createdAt: task.createdAt,
          updatedAt: task.updatedAt,
          checkouts,
          ...(task.archivedAt === undefined ? {} : { archivedAt: task.archivedAt }),
        })
      }
    }

    const kept = new Set(tasks.map((t) => t.id))
    const file = data as {
      messages?: Array<{ taskId: string }>
      runs?: Array<{ id: string; taskId: string }>
      pendingAsks?: Array<{ taskId: string }>
      runSessions?: Array<{ runId: string }>
    }
    const runs = (file.runs ?? []).filter((r) => kept.has(r.taskId))
    const runIds = new Set(runs.map((r) => r.id))
    const next: Record<string, unknown> = {
      ...data,
      tasks,
      messages: (file.messages ?? []).filter((m) => kept.has(m.taskId)),
      runs,
      pendingAsks: (file.pendingAsks ?? []).filter((a) => kept.has(a.taskId)),
      runSessions: (file.runSessions ?? []).filter((s) => runIds.has(s.runId)),
    }
    delete next.repos

    yield* Effect.tryPromise({
      try: () => copyFile(config.stateFile, join(config.dataDir, "state.legacy.json")),
      catch: (e) => new InternalError({ message: `cannot back up ${config.stateFile}: ${String(e)}` }),
    })
    yield* Effect.tryPromise({
      try: () => writeAtomic(config.stateFile, JSON.stringify(next)),
      catch: (e) => new InternalError({ message: `cannot write migrated state: ${String(e)}` }),
    })
    yield* Effect.logInfo(
      `migrated ${tasks.length} thread(s) with ${tasks.reduce((n, t) => n + t.checkouts.length, 0)} checkout(s); old clones and worktrees stay in ${config.dataDir}`,
    )
  })
