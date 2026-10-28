import { Context, Data, Effect, Layer } from "effect"
import { spawn } from "node:child_process"
import { randomUUID } from "node:crypto"
import { lstat, mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises"
import { dirname, join, sep } from "node:path"
import { NEW_PROCESS_GROUP, killProcessGroup, ownGroup } from "../process"

export class WorkspaceError extends Data.TaggedError("WorkspaceError")<{ readonly message: string }> {}

export interface ExecResult {
  readonly exitCode: number
  readonly stdout: string
  readonly stderr: string
}

/** A bare mirror of one remote repository. Only the host writes it; sandboxes see it read-only. */
export interface MirrorTarget {
  readonly mirrorPath: string
  readonly url: string
  readonly githubToken?: string
}

/**
 * One checkout: a clone inside a thread's workspace (`dir`), and the host-only shadow git dir (`shadowPath`) that
 * every host-side git command on it runs against. The checkout's own `.git` is agent-writable, so the host never
 * reads its config, hooks, refs or index through git; only its objects (via alternates) and HEAD (by file read).
 */
export interface CheckoutSpec {
  readonly threadDir: string
  readonly dir: string
  readonly shadowPath: string
}

export interface WorkspaceShape {
  /** Imports refs from a local clone into the mirror, with no network. Used by the legacy-state migration only. */
  readonly importClone: (args: {
    readonly mirrorPath: string
    readonly cloneDir: string
    readonly refspecs: ReadonlyArray<string>
  }) => Effect.Effect<void, WorkspaceError>
  /** Creates the mirror when missing and fetches every branch from `url`. Returns the remote's default branch. */
  readonly syncMirror: (target: MirrorTarget) => Effect.Effect<string, WorkspaceError>
  /** Fetches `refs/pull/<number>/head` into the mirror. Returns the commit it points at. */
  readonly fetchPullRequest: (target: MirrorTarget & { readonly number: number }) => Effect.Effect<string, WorkspaceError>
  /** Commit a ref names in the mirror, or null when it does not exist. */
  readonly resolveRef: (mirrorPath: string, ref: string) => Effect.Effect<string | null, WorkspaceError>
  /**
   * Clones the mirror into `spec.dir` (sharing its objects), creates `branch` at `startSha`, creates the shadow
   * git dir and pins `pinRef` to `baseSha` in it. `spec.dir` must not exist yet.
   */
  readonly createCheckout: (
    args: CheckoutSpec & {
      readonly mirrorPath: string
      readonly url: string
      readonly branch: string
      readonly startSha: string
      readonly baseSha: string
      readonly pinRef: string
    },
  ) => Effect.Effect<void, WorkspaceError>
  /** The commit the checkout's HEAD points at, read from its files. */
  readonly headSha: (spec: CheckoutSpec) => Effect.Effect<string, WorkspaceError>
  /** Everything on the checkout against `baseRef` (a ref in the shadow): commits, staged, unstaged and untracked files. */
  readonly diff: (spec: CheckoutSpec & { readonly baseRef: string }) => Effect.Effect<string, WorkspaceError>
  /** Pushes `head` to `refs/heads/<branch>` on `url`. Never forced. */
  readonly pushBranch: (
    spec: CheckoutSpec & { readonly url: string; readonly branch: string; readonly head: string; readonly githubToken?: string },
  ) => Effect.Effect<void, WorkspaceError>
  /** Removes a directory tree (a thread's workspace or shadow dirs). Succeeds when it is already gone. */
  readonly removePath: (path: string) => Effect.Effect<void, WorkspaceError>
}

export class WorkspaceService extends Context.Tag("cloudagents/WorkspaceService")<WorkspaceService, WorkspaceShape>() {}

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
    const child = ownGroup(
      spawn(file, args, {
        cwd: opts.cwd,
        env: { ...process.env, GIT_TERMINAL_PROMPT: "0", ...opts.env },
        detached: NEW_PROCESS_GROUP,
        stdio: ["ignore", "pipe", "pipe"],
      }),
    )
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
        killProcessGroup(child.pid, "SIGKILL")
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
      killProcessGroup(child.pid, "SIGKILL")
    })
  })

/**
 * Host-side git never runs hooks or fsmonitor commands, whatever the repo says. Remote operations (push, fetch)
 * also ignore config that could run host commands or helpers.
 */
const SAFE_GIT = ["-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor=false"] as const
const REMOTE_GIT = [...SAFE_GIT, "-c", "credential.helper=", "-c", "core.askPass=", "-c", "core.sshCommand=ssh"] as const

const REMOTE_TIMEOUT_MS = 120_000

/** Plain unified diff with fixed `a/` `b/` prefixes, whatever the (agent-writable) repo config says. */
const DIFF_FLAGS = ["diff", "--no-color", "--no-ext-diff", "--no-textconv", "--src-prefix=a/", "--dst-prefix=b/"] as const

/** Host whose HTTPS remotes are authenticated with the owner's GitHub token. */
const GITHUB_HOST = "github.com"

/**
 * Git config supplied through env (never argv, never written to disk) that sends the GitHub token as basic auth,
 * and only for HTTPS remotes on github.com.
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

/** Git's own messages for the common push failures, so the agent sees an actionable reason. */
const pushFailureMessage = (branch: string, detail: string): string => {
  if (/non-fast-forward|fetch first/.test(detail)) {
    return `git push ${branch} rejected: the remote branch has commits this checkout does not have (git_push never force-pushes): ${detail}`
  }
  if (/Permission to .* denied|\b403\b|\b401\b|could not read Username|Authentication failed|Invalid username or password/.test(detail)) {
    return `GitHub rejected the push of ${branch} (the connected token lacks write access or has expired): ${detail}`
  }
  return `git push ${branch} failed: ${detail}`
}

/** Git's own messages for the common fetch failures; a missing GitHub connection is the usual cause for private repos. */
const fetchFailureMessage = (refspec: string, hasToken: boolean, detail: string): string => {
  if (/could not read Username|Authentication failed|terminal prompts disabled|Repository not found|\b40[13]\b/.test(detail)) {
    return hasToken
      ? `GitHub refused to fetch ${refspec} (the connected token lacks read access or has expired): ${detail}`
      : `GitHub refused to fetch ${refspec}; private repositories need a GitHub connection with read access (connect GitHub under Connections, then retry): ${detail}`
  }
  return `git fetch ${refspec} failed: ${detail}`
}

/** Runs a host git command (with the safe config) in `cwd`, failing on a non-zero exit. */
const git = (
  cwd: string,
  args: ReadonlyArray<string>,
  env?: Readonly<Record<string, string>>,
): Effect.Effect<string, WorkspaceError> =>
  Effect.gen(function* () {
    const res = yield* runProcess("git", [...SAFE_GIT, ...args], { cwd, env }, `git ${args[0]}`)
    if (res.exitCode !== 0) {
      return yield* Effect.fail(new WorkspaceError({ message: `git ${args[0]} failed: ${(res.stderr || res.stdout).trim()}` }))
    }
    return res.stdout
  })

/** Git against a shadow dir: the checkout is the work tree, its own `.git` is never consulted. */
const shadowGit = (
  shadowPath: string,
  workTree: string,
  args: ReadonlyArray<string>,
  env?: Readonly<Record<string, string>>,
): Effect.Effect<string, WorkspaceError> =>
  git(workTree, args, { GIT_DIR: shadowPath, GIT_WORK_TREE: workTree, ...env })

/** A checkout's directory must be a real directory inside the thread workspace, with a real `.git` dir and objects. */
const verifyCheckout = (spec: CheckoutSpec): Effect.Effect<string, WorkspaceError> =>
  Effect.tryPromise({
    try: async () => {
      const real = await realpath(spec.dir)
      const root = await realpath(spec.threadDir)
      if (!real.startsWith(root + sep)) throw new Error("the checkout is outside its thread workspace")
      if (!(await lstat(real)).isDirectory()) throw new Error("the checkout is not a directory")
      if (!(await lstat(join(real, ".git"))).isDirectory()) throw new Error(".git is not a real directory")
      if (!(await lstat(join(real, ".git", "objects"))).isDirectory()) throw new Error(".git/objects is not a real directory")
      return real
    },
    catch: (e) => new WorkspaceError({ message: `checkout ${spec.dir} refused: ${e instanceof Error ? e.message : String(e)}` }),
  })

const SHA = /^[0-9a-f]{40}$/

/** Reads a ref from a checkout's `.git` by file: loose ref first, then packed-refs. Empty string when absent. */
const readRefSha = (gitDir: string, ref: string): Effect.Effect<string, WorkspaceError> =>
  Effect.tryPromise({
    try: async () => {
      if (!/^refs\/[A-Za-z0-9._/-]+$/.test(ref) || ref.includes("..")) throw new Error(`HEAD names an unsupported ref ${ref}`)
      try {
        return (await readFile(join(gitDir, ref), "utf8")).trim()
      } catch {
        const packed = await readFile(join(gitDir, "packed-refs"), "utf8").catch(() => "")
        for (const line of packed.split("\n")) {
          const [sha, name] = line.trim().split(" ")
          if (name === ref && sha !== undefined) return sha
        }
        return ""
      }
    },
    catch: (e) => new WorkspaceError({ message: `cannot read ${ref}: ${String(e)}` }),
  })

/** Creates the bare mirror at `mirrorPath` when it does not exist yet. Mirrors never hold checkout data. */
const ensureMirror = (mirrorPath: string): Effect.Effect<void, WorkspaceError> =>
  Effect.gen(function* () {
    const exists = yield* Effect.tryPromise({
      try: () => lstat(mirrorPath).then(() => true, () => false),
      catch: (e) => new WorkspaceError({ message: `stat ${mirrorPath}: ${String(e)}` }),
    })
    if (exists) return
    yield* Effect.tryPromise({
      try: () => mkdir(dirname(mirrorPath), { recursive: true }),
      catch: (e) => new WorkspaceError({ message: `mkdir failed: ${String(e)}` }),
    })
    yield* git(dirname(mirrorPath), ["init", "--bare", "-q", mirrorPath])
    yield* git(dirname(mirrorPath), ["--git-dir", mirrorPath, "config", "gc.auto", "0"])
  })

const make: WorkspaceShape = {
  importClone: ({ mirrorPath, cloneDir, refspecs }) =>
    Effect.gen(function* () {
      yield* ensureMirror(mirrorPath)
      yield* git(dirname(mirrorPath), ["--git-dir", mirrorPath, "fetch", "--no-tags", "--quiet", "--", cloneDir, ...refspecs])
    }),
  syncMirror: ({ mirrorPath, url, githubToken }) =>
    Effect.gen(function* () {
      yield* ensureMirror(mirrorPath)
      const env = githubAuthEnv(url, githubToken)
      const fetched = yield* runProcess(
        "git",
        [...REMOTE_GIT, "--git-dir", mirrorPath, "fetch", "--prune", "--no-tags", "--quiet", "--", url, "+refs/heads/*:refs/heads/*"],
        { cwd: dirname(mirrorPath), env, timeoutMs: REMOTE_TIMEOUT_MS },
        "git fetch",
      )
      if (fetched.exitCode !== 0) {
        const detail = redactSecret((fetched.stderr || fetched.stdout).trim(), githubToken)
        return yield* Effect.fail(
          new WorkspaceError({ message: fetchFailureMessage("refs/heads/*", githubToken !== undefined && githubToken !== "", detail) }),
        )
      }
      const listed = yield* runProcess(
        "git",
        [...REMOTE_GIT, "--git-dir", mirrorPath, "ls-remote", "--symref", "--", url, "HEAD"],
        { cwd: dirname(mirrorPath), env, timeoutMs: REMOTE_TIMEOUT_MS },
        "git ls-remote",
      )
      if (listed.exitCode !== 0) {
        const detail = redactSecret((listed.stderr || listed.stdout).trim(), githubToken)
        return yield* Effect.fail(new WorkspaceError({ message: `git ls-remote ${url} failed: ${detail}` }))
      }
      const match = /^ref: refs\/heads\/(\S+)\tHEAD$/m.exec(listed.stdout)
      if (match?.[1] === undefined) return yield* Effect.fail(new WorkspaceError({ message: `${url} has no default branch` }))
      return match[1]
    }),

  fetchPullRequest: ({ mirrorPath, url, number, githubToken }) =>
    Effect.gen(function* () {
      const refspec = `+refs/pull/${number}/head:refs/kestrel/pr/${number}`
      const res = yield* runProcess(
        "git",
        [...REMOTE_GIT, "--git-dir", mirrorPath, "fetch", "--no-tags", "--quiet", "--", url, refspec],
        { cwd: dirname(mirrorPath), env: githubAuthEnv(url, githubToken), timeoutMs: REMOTE_TIMEOUT_MS },
        "git fetch",
      )
      if (res.exitCode !== 0) {
        const detail = redactSecret((res.stderr || res.stdout).trim(), githubToken)
        return yield* Effect.fail(
          new WorkspaceError({ message: fetchFailureMessage(refspec, githubToken !== undefined && githubToken !== "", detail) }),
        )
      }
      const sha = yield* make.resolveRef(mirrorPath, `refs/kestrel/pr/${number}`)
      if (sha === null) return yield* Effect.fail(new WorkspaceError({ message: `pull request #${number} has no head commit` }))
      return sha
    }),

  resolveRef: (mirrorPath, ref) =>
    runProcess(
      "git",
      [...SAFE_GIT, "--git-dir", mirrorPath, "rev-parse", "--verify", "--quiet", `${ref}^{commit}`],
      { cwd: dirname(mirrorPath) },
      "git rev-parse",
    ).pipe(Effect.map((res) => (res.exitCode === 0 ? res.stdout.trim() : null))),

  createCheckout: ({ threadDir, dir, shadowPath, mirrorPath, url, branch, startSha, baseSha, pinRef }) =>
    Effect.gen(function* () {
      yield* Effect.tryPromise({
        try: () => mkdir(threadDir, { recursive: true }),
        catch: (e) => new WorkspaceError({ message: `mkdir failed: ${String(e)}` }),
      })
      yield* git(threadDir, ["clone", "--shared", "--no-checkout", "--", mirrorPath, dir])
      yield* git(dir, ["remote", "set-url", "origin", url])
      yield* git(dir, ["checkout", "-q", "-b", branch, startSha])
      yield* Effect.tryPromise({
        try: () => mkdir(dirname(shadowPath), { recursive: true }),
        catch: (e) => new WorkspaceError({ message: `mkdir failed: ${String(e)}` }),
      })
      yield* git(dirname(shadowPath), ["init", "--bare", "-q", shadowPath])
      yield* Effect.tryPromise({
        try: () =>
          writeFile(join(shadowPath, "objects", "info", "alternates"), `${join(mirrorPath, "objects")}\n${join(dir, ".git", "objects")}\n`),
        catch: (e) => new WorkspaceError({ message: `write alternates failed: ${String(e)}` }),
      })
      yield* git(shadowPath, ["--git-dir", shadowPath, "update-ref", pinRef, baseSha])
    }),

  headSha: (spec) =>
    Effect.gen(function* () {
      const real = yield* verifyCheckout(spec)
      const gitDir = join(real, ".git")
      const head = yield* Effect.tryPromise({
        try: () => readFile(join(gitDir, "HEAD"), "utf8"),
        catch: (e) => new WorkspaceError({ message: `cannot read HEAD: ${String(e)}` }),
      })
      const trimmed = head.trim()
      const sha = trimmed.startsWith("ref: ") ? yield* readRefSha(gitDir, trimmed.slice(5).trim()) : trimmed
      if (!SHA.test(sha)) return yield* Effect.fail(new WorkspaceError({ message: "the checkout has no commit yet" }))
      return sha
    }),

  diff: (spec) =>
    Effect.gen(function* () {
      const real = yield* verifyCheckout(spec)
      const index = join(spec.shadowPath, `index-${randomUUID()}.tmp`)
      const env = { GIT_INDEX_FILE: index }
      try {
        yield* shadowGit(spec.shadowPath, real, ["add", "-A"], env)
        return yield* shadowGit(spec.shadowPath, real, [...DIFF_FLAGS, "--cached", "--find-renames", spec.baseRef], env)
      } finally {
        yield* Effect.promise(() => rm(index, { force: true }))
      }
    }),

  pushBranch: ({ shadowPath, dir, threadDir, url, branch, head, githubToken }) =>
    Effect.gen(function* () {
      const real = yield* verifyCheckout({ threadDir, dir, shadowPath })
      const res = yield* runProcess(
        "git",
        [...REMOTE_GIT, "push", "--", url, `${head}:refs/heads/${branch}`],
        {
          cwd: real,
          env: { GIT_DIR: shadowPath, GIT_WORK_TREE: real, ...githubAuthEnv(url, githubToken) },
          timeoutMs: REMOTE_TIMEOUT_MS,
        },
        "git push",
      )
      if (res.exitCode !== 0) {
        const detail = redactSecret((res.stderr || res.stdout).trim(), githubToken)
        return yield* Effect.fail(new WorkspaceError({ message: pushFailureMessage(branch, detail) }))
      }
    }),

  removePath: (path) =>
    Effect.tryPromise({
      try: () => rm(path, { recursive: true, force: true }),
      catch: (e) => new WorkspaceError({ message: `remove ${path} failed: ${String(e)}` }),
    }),
}

/** Ref that pins a checkout's fork point in its shadow. Outside `refs/heads`, so later fetches never move it. */
export const checkoutPinRef = (taskId: string, checkoutId: string): string => `refs/kestrel/base/${taskId}/${checkoutId}`

export const WorkspaceLive = Layer.succeed(WorkspaceService, make)
