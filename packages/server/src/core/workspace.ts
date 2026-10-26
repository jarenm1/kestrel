import { Context, Data, Effect, Layer } from "effect"
import { spawn } from "node:child_process"
import { existsSync } from "node:fs"
import { mkdir } from "node:fs/promises"
import { dirname } from "node:path"

export class WorkspaceError extends Data.TaggedError("WorkspaceError")<{ readonly message: string }> {}

export interface ExecResult {
  readonly exitCode: number
  readonly stdout: string
  readonly stderr: string
}

export interface ExecOptions {
  readonly env?: Readonly<Record<string, string>>
  readonly timeoutMs?: number
}

export interface WorkspaceShape {
  readonly cloneRepo: (url: string, destDir: string, opts?: { readonly githubToken?: string }) => Effect.Effect<void, WorkspaceError>
  /** Branch currently checked out in a fresh clone (the remote default branch). */
  readonly defaultBranch: (repoPath: string) => Effect.Effect<string, WorkspaceError>
  readonly createWorktree: (args: {
    readonly repoPath: string
    readonly branch: string
    readonly baseBranch: string
    readonly worktreePath: string
  }) => Effect.Effect<void, WorkspaceError>
  readonly removeWorktree: (repoPath: string, worktreePath: string) => Effect.Effect<void, WorkspaceError>
  readonly deleteBranch: (repoPath: string, branch: string) => Effect.Effect<void, WorkspaceError>
  /** Diff of the worktree against baseBranch, including uncommitted and untracked files. */
  readonly diff: (worktreePath: string, baseBranch: string) => Effect.Effect<string, WorkspaceError>
  /** Runs `command` via `sh -c` in `cwd`. Fails on timeout; non-zero exit is a result. */
  readonly exec: (cwd: string, command: string, opts?: ExecOptions) => Effect.Effect<ExecResult, WorkspaceError>
}

export class WorkspaceService extends Context.Tag("cloudagents/WorkspaceService")<
  WorkspaceService,
  WorkspaceShape
>() {}

const killGroup = (pid: number | undefined, signal: NodeJS.Signals) => {
  if (pid === undefined) return
  try {
    process.kill(-pid, signal)
  } catch {
    // group already gone
  }
}

/** Spawns a process in its own process group; interruption kills the whole group. */
const runProcess = (
  file: string,
  args: ReadonlyArray<string>,
  opts: { readonly cwd: string; readonly env?: Readonly<Record<string, string>>; readonly timeoutMs?: number },
  label: string,
): Effect.Effect<ExecResult, WorkspaceError> =>
  Effect.async<ExecResult, WorkspaceError>((resume) => {
    let done = false
    let timer: NodeJS.Timeout | undefined
    const finish = (effect: Effect.Effect<ExecResult, WorkspaceError>) => {
      if (done) return
      done = true
      clearTimeout(timer)
      resume(effect)
    }
    const child = spawn(file, args, {
      cwd: opts.cwd,
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0", ...opts.env },
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
    })
    let stdout = ""
    let stderr = ""
    child.stdout.setEncoding("utf8")
    child.stderr.setEncoding("utf8")
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk
    })
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk
    })
    if (opts.timeoutMs !== undefined) {
      timer = setTimeout(() => {
        killGroup(child.pid, "SIGKILL")
        finish(Effect.fail(new WorkspaceError({ message: `${label} timed out after ${opts.timeoutMs}ms` })))
      }, opts.timeoutMs)
    }
    child.on("error", (err) => {
      finish(Effect.fail(new WorkspaceError({ message: `${label} failed to start: ${err.message}` })))
    })
    child.on("close", (code) => {
      finish(Effect.succeed({ exitCode: code ?? -1, stdout, stderr }))
    })
    return Effect.sync(() => {
      if (done) return
      done = true
      clearTimeout(timer)
      killGroup(child.pid, "SIGKILL")
    })
  })

const git = (cwd: string, args: ReadonlyArray<string>): Effect.Effect<string, WorkspaceError> =>
  Effect.gen(function* () {
    const res = yield* runProcess("git", args, { cwd }, `git ${args[0]}`)
    if (res.exitCode !== 0) {
      const detail = (res.stderr || res.stdout).trim()
      return yield* Effect.fail(new WorkspaceError({ message: `git ${args.join(" ")} failed: ${detail}` }))
    }
    return res.stdout
  })

/** Host whose HTTPS clones are authenticated with the signed-in user's GitHub token. */
const GITHUB_HOST = "github.com"

/**
 * Git config supplied through env (never argv, never written to .git/config) that sends the GitHub
 * token as basic auth, and only for HTTPS clones from github.com.
 */
const githubAuthEnv = (url: string, token: string | undefined): Readonly<Record<string, string>> => {
  if (token === undefined || token === "") return {}
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return {}
  }
  if (parsed.protocol !== "https:" || parsed.hostname !== GITHUB_HOST) return {}
  return {
    GIT_CONFIG_COUNT: "1",
    GIT_CONFIG_KEY_0: `http.https://${GITHUB_HOST}/.extraheader`,
    GIT_CONFIG_VALUE_0: `AUTHORIZATION: basic ${Buffer.from(`x-access-token:${token}`).toString("base64")}`,
  }
}

/** Removes the token and its basic-auth encoding from text that may reach logs or errors. */
const redactSecret = (text: string, token: string | undefined): string => {
  if (token === undefined || token === "") return text
  const basic = Buffer.from(`x-access-token:${token}`).toString("base64")
  return text.split(token).join("***").split(basic).join("***")
}

const make: WorkspaceShape = {
  cloneRepo: (url, destDir, opts) =>
    Effect.gen(function* () {
      yield* Effect.tryPromise({
        try: () => mkdir(dirname(destDir), { recursive: true }),
        catch: (e) => new WorkspaceError({ message: `mkdir failed: ${String(e)}` }),
      })
      const githubToken = opts?.githubToken
      const res = yield* runProcess(
        "git",
        ["clone", "--", url, destDir],
        { cwd: dirname(destDir), env: githubAuthEnv(url, githubToken) },
        "git clone",
      )
      if (res.exitCode !== 0) {
        const detail = redactSecret((res.stderr || res.stdout).trim(), githubToken)
        return yield* Effect.fail(new WorkspaceError({ message: `git clone ${url} failed: ${detail}` }))
      }
    }),

  defaultBranch: (repoPath) =>
    git(repoPath, ["symbolic-ref", "--short", "HEAD"]).pipe(Effect.map((s) => s.trim())),

  createWorktree: ({ repoPath, branch, baseBranch, worktreePath }) =>
    Effect.gen(function* () {
      yield* Effect.tryPromise({
        try: () => mkdir(dirname(worktreePath), { recursive: true }),
        catch: (e) => new WorkspaceError({ message: `mkdir failed: ${String(e)}` }),
      })
      yield* git(repoPath, ["worktree", "add", "-b", branch, worktreePath, baseBranch])
    }),

  removeWorktree: (repoPath, worktreePath) =>
    Effect.gen(function* () {
      const res = yield* runProcess("git", ["worktree", "remove", "--force", worktreePath], { cwd: repoPath }, "git worktree remove")
      if (res.exitCode === 0) return
      if (existsSync(worktreePath)) {
        return yield* Effect.fail(
          new WorkspaceError({ message: `git worktree remove failed: ${(res.stderr || res.stdout).trim()}` }),
        )
      }
      // Directory already gone (removed by hand): drop the stale registration.
      yield* git(repoPath, ["worktree", "prune"])
    }),

  deleteBranch: (repoPath, branch) => git(repoPath, ["branch", "-D", branch]).pipe(Effect.asVoid),

  diff: (worktreePath, baseBranch) =>
    Effect.gen(function* () {
      const tracked = yield* git(worktreePath, ["diff", "--no-color", baseBranch])
      const untrackedList = yield* git(worktreePath, ["ls-files", "--others", "--exclude-standard", "-z"])
      let untracked = ""
      for (const file of untrackedList.split("\0")) {
        if (file === "") continue
        // `git diff --no-index` exits 1 when the files differ, which is the normal case here.
        const res = yield* runProcess(
          "git",
          ["diff", "--no-color", "--no-index", "--", "/dev/null", file],
          { cwd: worktreePath },
          "git diff --no-index",
        )
        if (res.exitCode !== 0 && res.exitCode !== 1) {
          return yield* Effect.fail(new WorkspaceError({ message: `diff of ${file} failed: ${res.stderr.trim()}` }))
        }
        untracked += res.stdout
      }
      return tracked + untracked
    }),

  exec: (cwd, command, opts) =>
    runProcess("sh", ["-c", command], { cwd, env: opts?.env, timeoutMs: opts?.timeoutMs }, "command"),
}

export const WorkspaceLive = Layer.succeed(WorkspaceService, make)
