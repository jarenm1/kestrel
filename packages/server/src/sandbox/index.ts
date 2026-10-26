import { Effect } from "effect"
import { spawn } from "node:child_process"
import { accessSync, constants, existsSync } from "node:fs"
import { mkdir } from "node:fs/promises"
import { basename, join } from "node:path"
import { InternalError } from "@cloudagents/protocol"

/** Where the per-task home is mounted inside the sandbox. */
export const SANDBOX_HOME = "/home/agent"

/** Host paths exposed read-only when present; enough for DNS, TLS and passwd lookups. */
const SYSTEM_RO_FILES = [
  "/etc/resolv.conf",
  "/etc/hosts",
  "/etc/nsswitch.conf",
  "/etc/passwd",
  "/etc/group",
  "/etc/localtime",
  "/etc/ssl",
]

export interface BwrapOptions {
  readonly worktreePath: string
  /** Git common dir of the task's repo (worktrees need it for index/refs). Absolute. */
  readonly gitCommonDir: string
  /** Host dir for the persisted per-task home, bound rw at /home/agent. */
  readonly homeDir: string
  /** X display number of the task desktop; its socket is bound when given. */
  readonly display?: number
  /** Exact environment of the sandboxed process. Nothing else from the host is passed. */
  readonly env: Readonly<Record<string, string>>
  readonly command: string
  /** Extra host paths mounted read-only at the same location (fake agent only). */
  readonly roBinds?: ReadonlyArray<string>
}

/** Returns the full argv, starting with the `bwrap` executable name. */
export const buildBwrapArgv = (opts: BwrapOptions): string[] => {
  const argv: string[] = [
    "bwrap",
    "--die-with-parent",
    "--new-session",
    "--unshare-all",
    "--share-net",
    "--clearenv",
    "--ro-bind",
    "/nix/store",
    "/nix/store",
    "--proc",
    "/proc",
    "--dev",
    "/dev",
    "--tmpfs",
    "/tmp",
    // Nothing under /home is visible except the task home and the worktree binds below.
    "--tmpfs",
    "/home",
    "--bind",
    opts.homeDir,
    SANDBOX_HOME,
    "--bind",
    opts.worktreePath,
    opts.worktreePath,
    "--bind",
    opts.gitCommonDir,
    opts.gitCommonDir,
  ]
  // The agent commits through the shared git dir, but must not control what host-side git runs:
  // repo config (fsmonitor, filters, diff drivers, ...) and hooks stay read-only, other tasks'
  // worktree admin dirs are read-only, and this task's admin dir keeps its `commondir`/`gitdir`
  // pointers read-only so they cannot redirect host git to an agent-made git dir.
  for (const name of ["config", "hooks"]) {
    const path = join(opts.gitCommonDir, name)
    if (existsSync(path)) argv.push("--ro-bind", path, path)
  }
  const adminRoot = join(opts.gitCommonDir, "worktrees")
  const adminDir = join(adminRoot, basename(opts.worktreePath))
  if (existsSync(adminRoot)) argv.push("--ro-bind", adminRoot, adminRoot)
  if (existsSync(adminDir)) argv.push("--bind", adminDir, adminDir)
  for (const name of ["commondir", "gitdir"]) {
    const path = join(adminDir, name)
    if (existsSync(path)) argv.push("--ro-bind", path, path)
  }
  for (const path of opts.roBinds ?? []) argv.push("--ro-bind", path, path)
  for (const file of SYSTEM_RO_FILES) {
    if (existsSync(file)) argv.push("--ro-bind", file, file)
  }
  if (opts.display !== undefined) {
    const socket = x11Socket(opts.display)
    argv.push("--bind", socket, socket)
  }
  for (const [name, value] of Object.entries(opts.env)) argv.push("--setenv", name, value)
  argv.push("--chdir", opts.worktreePath, "--", "sh", "-c", opts.command)
  return argv
}

export const x11Socket = (display: number): string => `/tmp/.X11-unix/X${display}`

/** Parses ":101" into 101 when the desktop socket exists on the host. */
export const displayNumber = (display: string | null): number | undefined => {
  const match = display === null ? null : /^:(\d+)$/.exec(display)
  if (!match) return undefined
  const n = Number(match[1])
  return existsSync(x11Socket(n)) ? n : undefined
}

export interface SandboxSettings {
  /** False only with `CLOUDAGENTS_SANDBOX=0` (local debugging). */
  readonly enabled: boolean
  /** `CLOUDAGENTS_SANDBOX_PATH`; required when enabled. */
  readonly binPath: string | null
  /** `CLOUDAGENTS_SANDBOX_SSL`: CA bundle path, exposed as SSL_CERT_FILE. */
  readonly sslCertFile: string | null
}

export interface LaunchRequest {
  readonly settings: SandboxSettings
  readonly worktreePath: string
  readonly homeDir: string
  /** X display string (e.g. ":101") of the task desktop, or null. */
  readonly display: string | null
  /**
   * Git common dir of the task's repo, derived from server state (never from the worktree,
   * whose `.git` file the agent can rewrite).
   */
  readonly gitCommonDir: string
  /** Variables beyond the base allowlist (CLOUDAGENTS_*, broker env). Never host env. */
  readonly env: Readonly<Record<string, string>>
  readonly command: string
  readonly roBinds?: ReadonlyArray<string>
}

export interface Launch {
  readonly file: string
  readonly args: ReadonlyArray<string>
  readonly env: Readonly<Record<string, string>>
  readonly cwd: string
  /** HOME as the process sees it (`/home/agent` when sandboxed). */
  readonly home: string
}

/** HOME as seen by the launched process; use it to build paths the process reads. */
export const agentHome = (settings: SandboxSettings, homeDir: string): string =>
  settings.enabled ? SANDBOX_HOME : homeDir

export const sandboxSettingsOf = (config: {
  readonly sandboxEnabled: boolean
  readonly sandboxPath: string | null
  readonly sandboxSslCertFile: string | null
}): SandboxSettings => ({
  enabled: config.sandboxEnabled,
  binPath: config.sandboxPath,
  sslCertFile: config.sandboxSslCertFile,
})

const killGroup = (pid: number | undefined, signal: NodeJS.Signals) => {
  if (pid === undefined) return
  try {
    process.kill(-pid, signal)
  } catch {
    // group already gone
  }
}

export const killProcessGroup = killGroup

const findExecutable = (name: string): string | null => {
  for (const dir of (process.env.PATH ?? "").split(":")) {
    if (dir === "") continue
    const candidate = join(dir, name)
    try {
      accessSync(candidate, constants.X_OK)
      return candidate
    } catch {
      // not here
    }
  }
  return null
}

/**
 * Turns a launch request into the concrete process to spawn. Sandboxed launches go through
 * bubblewrap; the env is exactly the base allowlist plus `req.env`.
 */
export const prepareLaunch = (req: LaunchRequest): Effect.Effect<Launch, InternalError> =>
  Effect.gen(function* () {
    const { settings } = req
    if (settings.enabled && settings.binPath === null) {
      return yield* Effect.fail(
        new InternalError({
          message:
            "CLOUDAGENTS_SANDBOX_PATH is not set; start the box with `nix run .#box` or inside `nix develop` (or set CLOUDAGENTS_SANDBOX=0 for local debugging)",
        }),
      )
    }
    const bwrap = settings.enabled ? findExecutable("bwrap") : null
    if (settings.enabled && bwrap === null) {
      return yield* Effect.fail(
        new InternalError({ message: "bwrap (bubblewrap) not found on PATH; run inside `nix develop` or `nix run .#box`" }),
      )
    }
    yield* Effect.tryPromise({
      try: () => mkdir(req.homeDir, { recursive: true }),
      catch: (e) => new InternalError({ message: `cannot create home ${req.homeDir}: ${String(e)}` }),
    })
    const home = agentHome(settings, req.homeDir)
    const env: Record<string, string> = {
      PATH: settings.enabled ? (settings.binPath as string) : (process.env.PATH ?? "/usr/bin:/bin"),
      HOME: home,
      TERM: process.env.TERM ?? "xterm",
      ...(settings.sslCertFile
        ? { SSL_CERT_FILE: settings.sslCertFile, NIX_SSL_CERT_FILE: settings.sslCertFile }
        : {}),
      ...(req.display ? { DISPLAY: req.display } : {}),
      ...req.env,
    }

    if (!settings.enabled) {
      return { file: "sh", args: ["-c", req.command], env, cwd: req.worktreePath, home }
    }

    const argv = buildBwrapArgv({
      worktreePath: req.worktreePath,
      gitCommonDir: req.gitCommonDir,
      homeDir: req.homeDir,
      display: displayNumber(req.display),
      env,
      command: req.command,
      roBinds: req.roBinds,
    })
    return { file: bwrap as string, args: argv.slice(1), env, cwd: req.worktreePath, home }
  })

export interface ProcessResult {
  readonly exitCode: number
  readonly stdout: string
  readonly stderr: string
}

/** Runs a process in its own process group; timeout or interruption kills the whole group. */
export const runProcess = (
  file: string,
  args: ReadonlyArray<string>,
  opts: { readonly cwd: string; readonly env: Readonly<Record<string, string>>; readonly timeoutMs?: number },
): Effect.Effect<ProcessResult, InternalError> =>
  Effect.async<ProcessResult, InternalError>((resume) => {
    let done = false
    let timer: NodeJS.Timeout | undefined
    const finish = (effect: Effect.Effect<ProcessResult, InternalError>) => {
      if (done) return
      done = true
      clearTimeout(timer)
      resume(effect)
    }
    const child = spawn(file, [...args], {
      cwd: opts.cwd,
      env: { ...opts.env },
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
        finish(Effect.fail(new InternalError({ message: `timed out after ${opts.timeoutMs}ms` })))
      }, opts.timeoutMs)
    }
    child.on("error", (err) => {
      finish(Effect.fail(new InternalError({ message: `${file} failed to start: ${err.message}` })))
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
