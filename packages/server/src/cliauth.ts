import { Context, Effect, Layer } from "effect"
import { execFile, spawn, type ChildProcess } from "node:child_process"
import { chmod, lstat, mkdir, readFile, rm, stat } from "node:fs/promises"
import { isAbsolute, join, relative, resolve } from "node:path"
import {
  BadRequest,
  InternalError,
  type CliAuthStatus,
  type CliLoginStart,
  type CliProvider,
  type HarnessCommand,
  type ProviderUsage,
  type UseBankedResetResult,
} from "@cloudagents/protocol"
import { AGENT_CLIS, CLI_PROVIDERS, MODEL_HARNESS, type AgentCli, type CliOutput, type HarnessMinimum } from "./agent-clis"
import { meetsMinimum } from "./capabilities"
import { Config } from "./config"
import { killActiveDiscovery, limitDiscovery } from "./harness-commands"
import { NEW_PROCESS_GROUP, killProcessGroup, ownGroup, platformEnv, shell } from "./process"
import { boxHomeToolArgs, cliBwrapArgs, findExecutable } from "./sandbox"

/** POSIX quoting for one argv element run through `sh -c`. */
const posixQuote = (value: string): string => `'${value.replace(/'/g, `'\\''`)}'`

/*
 * Per-user subscription logins of the agent CLIs (Claude Pro/Max, ChatGPT). Each signed-in user's
 * login is written by the unmodified CLI into `<dataDir>/users/<login>/<provider dir>`; the CLI
 * itself reads and refreshes it. Only a login flag, an account label and the provider's own sign-in
 * link or device code leave this module: never tokens, key fragments or file contents.
 */

const USER_PATTERN = /^[A-Za-z0-9-]{1,39}$/
const STATUS_TIMEOUT_MS = 15_000
const LINK_TIMEOUT_MS = 20_000
const CODE_TIMEOUT_MS = 60_000
/** A sign-in that is not finished within this is killed. */
const PENDING_TTL_MS = 15 * 60_000
const CODE_MAX = 512
/**
 * The CLI's reply to a code it will not accept (it asks again instead of exiting). Observed: "Invalid code. Please make
 * sure the full code was copied."; anything else counts as success only once the CLI exits 0.
 */
const CODE_REJECTED = /\b(Invalid code|OAuth error)\b/i
const MESSAGE_MAX = 200
/** A CLI's stored login is small; anything larger is not an identity file and is not read. */
const ACCOUNT_FILE_MAX = 64 * 1024

/**
 * The email in a CLI's own stored login, or null when the file is absent, unreadable, malformed, oversized or names no
 * account. The file is under the user's login directory and is read as a regular file (not a link); its contents, which
 * may include tokens, are parsed in memory and never returned or logged.
 */
const readAccountLabel = (dir: string, identity: AgentCli["identity"]): Effect.Effect<string | null> =>
  Effect.gen(function* () {
    if (identity === null) return null
    const text = yield* Effect.promise(async () => {
      try {
        const path = join(dir, identity.path)
        const info = await lstat(path)
        if (!info.isFile() || info.size > ACCOUNT_FILE_MAX) return null
        return await readFile(path, "utf8")
      } catch {
        return null
      }
    })
    if (text === null) return null
    try {
      const label = identity.parse(text)
      return label === null || label === "" ? null : label
    } catch {
      return null
    }
  })

/** A provider the user is logged in to, with the host directory holding that login. */
export interface CliLoginDir {
  readonly provider: CliProvider
  readonly dir: string
}

export interface CliAuthShape {
  readonly status: (user: string) => Effect.Effect<ReadonlyArray<CliAuthStatus>, BadRequest | InternalError>
  readonly startLogin: (user: string, provider: CliProvider) => Effect.Effect<CliLoginStart, BadRequest | InternalError>
  readonly submitCode: (
    user: string,
    provider: CliProvider,
    code: string,
  ) => Effect.Effect<CliAuthStatus, BadRequest | InternalError>
  /** Stores a key through the CLI's own credential importer; never puts it on a command line. */
  readonly submitKey: (user: string, provider: CliProvider, key: string) => Effect.Effect<CliAuthStatus, BadRequest | InternalError>
  readonly logout: (user: string, provider: CliProvider) => Effect.Effect<void, BadRequest | InternalError>
  /** The providers `user` is logged in to; a sandboxed run binds these directories in. */
  readonly loggedInDirs: (user: string) => Effect.Effect<ReadonlyArray<CliLoginDir>, BadRequest | InternalError>
  /**
   * The real commands the provider's CLI offers for `user` in `workspacePath` (thread workspace), started in `cwd`
   * (where the thread's agent starts: the workspace or its first checkout): Claude Code slash commands or Codex skills.
   * Runs the CLI in the user's isolated login home with the workspace read-only,
   * bounded and killed on answer, error or timeout; never tokens, paths or file contents.
   */
  readonly discoverCommands: (
    user: string,
    provider: CliProvider,
    workspacePath: string,
    cwd: string,
  ) => Effect.Effect<ReadonlyArray<HarnessCommand>, BadRequest | InternalError>
  /**
   * The subscription limits each provider's CLI reports for `user`. One provider failing leaves the other's intact.
   * `fresh` skips the short cache: a just-failed run needs the window it exhausted, not a read from before it.
   */
  readonly providerUsage: (user: string, fresh?: boolean) => Effect.Effect<ReadonlyArray<ProviderUsage>, BadRequest>
  /** Spends banked reset `resetId` of `user`'s `provider` (Codex only); the next usage read asks the CLI afresh. */
  readonly useBankedReset: (
    user: string,
    provider: CliProvider,
    resetId: string,
  ) => Effect.Effect<UseBankedResetResult, BadRequest | InternalError>
  /** Kills sign-ins still waiting for the user; called on box shutdown. */
  readonly shutdown: () => Effect.Effect<void>
}

export class CliAuth extends Context.Tag("cloudagents/CliAuth")<CliAuth, CliAuthShape>() {}

/** A concrete process to run: the CLI itself, bwrap wrapping it, or (Windows, unsandboxed) the shell that runs its shim. */
interface Invocation {
  readonly file: string
  readonly args: ReadonlyArray<string>
  readonly env: Readonly<Record<string, string>>
}

/** Runs a CLI. Non-zero exits still yield output (both CLIs exit 1 when logged out); null when not installed. */
const runCli = (inv: Invocation, label: string, input?: string, requireSuccess = false): Effect.Effect<CliOutput | null, InternalError> =>
  Effect.async<CliOutput | null, InternalError>((resume) => {
    const child = execFile(inv.file, [...inv.args], { env: { ...inv.env }, timeout: STATUS_TIMEOUT_MS }, (err, stdout, stderr) => {
      if (err && (err as NodeJS.ErrnoException).code === "ENOENT") return resume(Effect.succeed(null))
      if (err && err.killed) return resume(Effect.fail(new InternalError({ message: `${label}: timed out` })))
      if (err && requireSuccess) return resume(Effect.fail(new InternalError({ message: `${label}: command failed` })))
      resume(Effect.succeed({ stdout, stderr }))
    })
    child.stdin?.on("error", () => {})
    child.stdin?.end(input)
    return Effect.sync(() => child.kill())
  })

const stripAnsi = (text: string): string => text.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, "")

/** Last meaningful CLI output line, with links and the submitted code hidden, capped for an error message. */
const lastLine = (text: string, secrets: ReadonlyArray<string>): string => {
  const redacted = secrets.reduce(
    (acc, secret) => acc.split(secret).join("<code>"),
    stripAnsi(text).replace(/https?:\/\/\S+/g, "<link>"),
  )
  const line = redacted
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l !== "")
    .pop()
  return (line ?? "").slice(0, MESSAGE_MAX)
}

interface Pending {
  readonly key: string
  readonly child: ChildProcess
  /** Everything the CLI has printed so far (stdout and stderr). */
  output: string
  /** Resolves with the exit code once the process has closed (null when it never started). */
  readonly done: Promise<number | null>
  /** Run after each chunk of output and on close; wakes whoever is waiting. */
  readonly listeners: Set<() => void>
  timer: NodeJS.Timeout
}

/** Resolves with the first parse of the output that succeeds, or null on close or timeout. */
const waitFor = <A>(entry: Pending, parse: (text: string) => A | null, timeoutMs: number): Promise<A | null> => {
  const { promise, resolve } = Promise.withResolvers<A | null>()
  const finish = (value: A | null) => {
    clearTimeout(timer)
    entry.listeners.delete(check)
    resolve(value)
  }
  const check = () => {
    const found = parse(entry.output)
    if (found !== null) finish(found)
  }
  const timer = setTimeout(() => finish(null), timeoutMs)
  entry.listeners.add(check)
  void entry.done.then(() => finish(parse(entry.output)))
  check()
  return promise
}

export const CliAuthLive = Layer.effect(
  CliAuth,
  Effect.gen(function* () {
    const config = yield* Config
    const pending = new Map<string, Pending>()
    const keyOf = (user: string, provider: CliProvider) => `${user}\0${provider}`

    const killEntry = (entry: Pending) => {
      clearTimeout(entry.timer)
      if (pending.get(entry.key) === entry) pending.delete(entry.key)
      killProcessGroup(entry.child.pid, "SIGKILL")
    }

    // Sign-ins are children of the box; a box exiting must not leave them running.
    process.on("exit", () => {
      for (const entry of pending.values()) killProcessGroup(entry.child.pid, "SIGKILL")
    })

    /** The user's root, which is also the CLIs' HOME. Only plain logins name a directory. */
    const rootOf = (user: string): Effect.Effect<string, BadRequest> =>
      USER_PATTERN.test(user)
        ? Effect.succeed(join(config.dataDir, "users", user))
        : Effect.fail(new BadRequest({ message: "signed-in user is not a valid login" }))

    const providerDir = (user: string, provider: CliProvider): Effect.Effect<string, BadRequest> =>
      Effect.map(rootOf(user), (root) => join(root, AGENT_CLIS[provider].dir))

    const ensureDir = (path: string): Effect.Effect<void, InternalError> =>
      Effect.tryPromise({
        try: async () => {
          await mkdir(path, { recursive: true, mode: 0o700 })
          await chmod(path, 0o700)
        },
        catch: () => new InternalError({ message: "cannot create the sign-in directory" }),
      })

    const ensureUserDirs = (user: string, provider: CliProvider): Effect.Effect<void, BadRequest | InternalError> =>
      Effect.gen(function* () {
        const root = yield* rootOf(user)
        yield* ensureDir(join(config.dataDir, "users"))
        yield* ensureDir(root)
        yield* ensureDir(yield* providerDir(user, provider))
      })

    /**
     * Environment for running `provider`'s CLI as `user`: their HOME and config homes, never the box user's login. One
     * variable names one home, and OpenCode's free and Go logins share `XDG_DATA_HOME`: each gets its own, and the
     * other's is left out rather than letting whichever provider comes last decide what the CLI reads.
     */
    const cliEnv = (user: string, provider: CliProvider): Effect.Effect<Record<string, string>, BadRequest | InternalError> =>
      Effect.gen(function* () {
        const root = yield* rootOf(user)
        const path = config.sandboxPath ?? (config.sandbox === "strict" ? null : (process.env.PATH ?? "/usr/bin:/bin"))
        if (path === null) {
          return yield* Effect.fail(
            new InternalError({ message: "CLOUDAGENTS_SANDBOX_PATH is not set; the agent CLIs are not on the toolchain" }),
          )
        }
        const ssl = config.sandboxSslCertFile
        const own = AGENT_CLIS[provider]
        return {
          ...(config.sandbox === "off" ? platformEnv() : {}),
          PATH: path,
          HOME: root,
          ...Object.fromEntries(
            CLI_PROVIDERS.filter((candidate) => AGENT_CLIS[candidate].configEnv !== own.configEnv).map((candidate) => [
              AGENT_CLIS[candidate].configEnv,
              join(root, AGENT_CLIS[candidate].dir),
            ]),
          ),
          [own.configEnv]: join(root, own.dir),
          BROWSER: "/bin/false",
          NO_COLOR: "1",
          ...(ssl === null ? {} : { SSL_CERT_FILE: ssl, NIX_SSL_CERT_FILE: ssl }),
        }
      })

    /**
     * How to run `provider`'s CLI `args` for `user`: inside bwrap with only the user's dir writable, so it dies with
     * the box and sees nothing else of the host; directly (or through POSIX sh for Windows `.cmd` shims) only when the
     * sandbox is disabled (local debugging). Sign-in keeps the box network; discovery runs in its thread workspace with
     * no network at all, so repo-controlled config cannot reach the box's loopback services.
     */
    const invoke = (
      user: string,
      provider: CliProvider,
      args: ReadonlyArray<string>,
      discovery?: { readonly workspacePath: string; readonly cwd: string },
    ): Effect.Effect<Invocation, BadRequest | InternalError> =>
      Effect.gen(function* () {
        const bin = AGENT_CLIS[provider].bin
        const env = yield* cliEnv(user, provider)
        if (config.sandbox === "off") {
          // Windows installs the CLIs as `.cmd` shims, which spawn cannot launch directly; the repo's POSIX shell
          // runs them like agent commands do, with SystemRoot and the rest of the platform env in place.
          if (process.platform === "win32") {
            return { file: shell(), args: ["-c", [bin, ...args].map(posixQuote).join(" ")], env }
          }
          return { file: bin, args, env }
        }
        const bwrap = findExecutable("bwrap")
        if (bwrap === null) return yield* Effect.fail(new InternalError({ message: "bwrap (bubblewrap) not found on PATH" }))
        const root = yield* rootOf(user)
        const sandbox =
          discovery === undefined
            ? { network: "host" as const }
            : { network: "none" as const, workspacePath: discovery.workspacePath, cwd: discovery.cwd }
        const level = config.sandbox === "strict" ? "strict" : "basic"
        return {
          file: bwrap,
          args: cliBwrapArgs(root, env, [bin, ...args], {
            ...sandbox,
            level,
            homeToolArgs: level === "basic" ? boxHomeToolArgs() : [],
          }),
          env: {},
        }
      })

    /**
     * A thread's workspace, and only a thread's workspace: discovery reads project commands/skills from it and must
     * never be handed an arbitrary host path. The workspace is the box's own directory, which the agent cannot
     * replace; checkouts inside it are agent-writable, so discovery binds the workspace and only starts in them.
     */
    const threadWorkspace = (workspacePath: string): Effect.Effect<string, BadRequest> => {
      const root = resolve(config.threadsDir)
      const target = resolve(workspacePath)
      const rel = relative(root, target)
      return rel === "" || rel.startsWith("..") || isAbsolute(rel)
        ? Effect.fail(new BadRequest({ message: "thread workspace is outside the threads directory" }))
        : Effect.succeed(target)
    }

    /** `cwd` as an absolute path inside `workspace` (lexically: it is only ever resolved inside the sandbox). */
    const insideWorkspace = (workspace: string, cwd: string): Effect.Effect<string, BadRequest> => {
      const target = resolve(cwd)
      const rel = relative(workspace, target)
      return rel.startsWith("..") || isAbsolute(rel)
        ? Effect.fail(new BadRequest({ message: "discovery directory is outside the thread workspace" }))
        : Effect.succeed(target)
    }

    const commandCache = new Map<string, { readonly at: number; readonly commands: ReadonlyArray<HarnessCommand> }>()
    const discoveryRuns = new Map<string, Promise<ReadonlyArray<HarnessCommand>>>()
    const COMMAND_CACHE_MS = 30_000
    const COMMAND_CACHE_MAX = 64

    /**
     * Runs the provider CLI for `user` in `workspacePath`, started in `cwd`, and returns its real command list.
     * Concurrent requests for the same user, provider and directory share one child; a short cache keeps the composer
     * from spawning per key.
     */
    const discoverCommands = (
      user: string,
      provider: CliProvider,
      workspacePath: string,
      cwd: string,
    ): Effect.Effect<ReadonlyArray<HarnessCommand>, BadRequest | InternalError> =>
      Effect.gen(function* () {
        const workspace = yield* threadWorkspace(workspacePath)
        const dir = yield* insideWorkspace(workspace, cwd)
        const key = `${user}\0${provider}\0${dir}`
        const cached = commandCache.get(key)
        if (cached !== undefined && Date.now() - cached.at < COMMAND_CACHE_MS) return cached.commands
        const spec = AGENT_CLIS[provider]
        const probe = spec.probe
        // A CLI Kestrel does not probe offers no commands of its own here.
        if (probe === null) return []
        // The CLI refuses to start without its config home; it is still the user's own empty home, never the box's.
        yield* ensureUserDirs(user, provider)
        const inv = yield* invoke(user, provider, probe.args, { workspacePath: workspace, cwd: dir })
        return yield* Effect.tryPromise({
          try: () => {
            const running = discoveryRuns.get(key)
            if (running !== undefined) return running
            const launch = { file: inv.file, args: inv.args, env: inv.env, cwd: dir }
            const pending = limitDiscovery(() => probe.discoverCommands(launch))
              .then((commands) => {
                commandCache.delete(key)
                commandCache.set(key, { at: Date.now(), commands })
                while (commandCache.size > COMMAND_CACHE_MAX) {
                  const oldest = commandCache.keys().next().value
                  if (oldest === undefined) break
                  commandCache.delete(oldest)
                }
                return commands
              })
              .finally(() => discoveryRuns.delete(key))
            discoveryRuns.set(key, pending)
            return pending
          },
          catch: (e) =>
            new InternalError({ message: e instanceof Error ? e.message : `${spec.bin} command discovery failed` }),
        })
      })

    const usageCache = new Map<string, { readonly at: number; readonly usage: ProviderUsage }>()
    const usageRuns = new Map<string, Promise<ProviderUsage>>()
    /** Bumped when a banked reset is spent, so a read that started before it does not cache the old limits. */
    const usageEpochs = new Map<string, number>()
    /** Providers throttle these reads, so a panel left open or several open tabs share one answer. */
    const USAGE_CACHE_MS = 60_000
    const USAGE_CACHE_MAX = 64

    /**
     * Asks the provider's CLI for `user`'s limits. It runs like a status check, in the user's own home with no thread
     * workspace, because the provider must be reachable. A signed-out answer is not cached: a sign-in shows at once.
     */
    const readUsage = (user: string, provider: CliProvider, fresh = false): Effect.Effect<ProviderUsage, BadRequest> =>
      Effect.gen(function* () {
        const spec = AGENT_CLIS[provider]
        const probe = spec.probe
        if (probe === null) return yield* Effect.fail(new InternalError({ message: `${spec.bin} reports no limits` }))
        const env = yield* cliEnv(user, provider)
        if (process.platform !== "win32" && findExecutable(spec.bin, env.PATH ?? "") === null) {
          return yield* Effect.fail(new InternalError({ message: `${spec.bin} is not installed on the box` }))
        }
        const signedOut: ProviderUsage = { provider, status: "signed_out", plan: null, windows: [] }
        const present = yield* Effect.promise(async () =>
          stat(join(env.HOME ?? "", spec.dir)).then((s) => s.isDirectory(), () => false),
        )
        if (!present) return signedOut
        const key = keyOf(user, provider)
        const cached = fresh ? undefined : usageCache.get(key)
        if (cached !== undefined && Date.now() - cached.at < USAGE_CACHE_MS) return cached.usage
        const epoch = usageEpochs.get(key) ?? 0
        const inv = yield* invoke(user, provider, probe.args)
        const launch = { file: inv.file, args: inv.args, env: inv.env, cwd: yield* rootOf(user) }
        return yield* Effect.tryPromise({
          try: () => {
            const running = usageRuns.get(key)
            if (running !== undefined) return running
            const pending = limitDiscovery(() => probe.probeUsage(launch))
              .then((usage) => {
                usageCache.delete(key)
                const current = (usageEpochs.get(key) ?? 0) === epoch
                if (current && usage.status !== "signed_out") usageCache.set(key, { at: Date.now(), usage })
                while (usageCache.size > USAGE_CACHE_MAX) {
                  const oldest = usageCache.keys().next().value
                  if (oldest === undefined) break
                  usageCache.delete(oldest)
                }
                return usage
              })
              .finally(() => {
                if (usageRuns.get(key) === pending) usageRuns.delete(key)
              })
            usageRuns.set(key, pending)
            return pending
          },
          catch: (e) => new InternalError({ message: e instanceof Error ? e.message : `${spec.bin} usage failed` }),
        })
      }).pipe(
        Effect.catchTag("InternalError", (e) =>
          Effect.succeed<ProviderUsage>({ provider, status: "unavailable", plan: null, windows: [], error: e.message }),
        ),
      )

    /** The limits of every CLI that reports them; a CLI Kestrel does not probe has none to show. */
    const providerUsage = (user: string, fresh = false) =>
      Effect.all(
        CLI_PROVIDERS.filter((provider) => AGENT_CLIS[provider].probe !== null).map((provider) =>
          readUsage(user, provider, fresh),
        ),
        { concurrency: "unbounded" },
      )

    const useBankedReset = (user: string, provider: CliProvider, resetId: string) =>
      Effect.gen(function* () {
        const spec = AGENT_CLIS[provider]
        const probe = spec.probe
        const bankedReset = probe?.useBankedReset ?? null
        if (probe === null || bankedReset === null) {
          return yield* Effect.fail(new BadRequest({ message: `${spec.bin} has no banked resets` }))
        }
        const env = yield* cliEnv(user, provider)
        if (process.platform !== "win32" && findExecutable(spec.bin, env.PATH ?? "") === null) {
          return yield* Effect.fail(new InternalError({ message: `${spec.bin} is not installed on the box` }))
        }
        const inv = yield* invoke(user, provider, probe.args)
        const launch = { file: inv.file, args: inv.args, env: inv.env, cwd: yield* rootOf(user) }
        const key = keyOf(user, provider)
        return yield* Effect.tryPromise({
          try: () => limitDiscovery(() => bankedReset(launch, resetId)),
          catch: (e) => new InternalError({ message: e instanceof Error ? e.message : `${spec.bin} reset failed` }),
        }).pipe(
          // Whatever the outcome, the limits and the list of resets may have changed.
          Effect.ensuring(
            Effect.sync(() => {
              usageEpochs.set(key, (usageEpochs.get(key) ?? 0) + 1)
              usageCache.delete(key)
              usageRuns.delete(key)
            }),
          ),
        )
      })

    /**
     * One CLI's login as the box sees it. A CLI the box cannot run (not installed where the sandbox looks, or failing)
     * reports why in `error` rather than failing the whole status, so the other CLI still shows.
     */
    const readStatus = (user: string, provider: CliProvider): Effect.Effect<CliAuthStatus, BadRequest> =>
      Effect.gen(function* () {
        const spec = AGENT_CLIS[provider]
        const env = yield* cliEnv(user, provider)
        // Windows runs `.cmd` shims through sh, which this lookup cannot see; there the CLI's own exit tells.
        if (process.platform !== "win32" && findExecutable(spec.bin, env.PATH ?? "") === null) {
          return { provider, loggedIn: false, account: null, error: `${spec.bin} is not installed on the box (not on its PATH)` }
        }
        // The Go plan signs in by importing its key, which OpenCode 2.1 adds, and the free models sign in through the
        // Console device flow, which 2.0.7 adds: an older CLI reports why here, so the Connections page never offers a
        // sign-in that cannot work.
        let minimum: HarnessMinimum | null = null
        if (provider === "opencode") minimum = MODEL_HARNESS.opencode.minVersion
        if (provider === "opencode-go") minimum = MODEL_HARNESS["opencode-go"].minVersion
        if (minimum !== null) {
          // The version probe runs in the user's own home, and a sandbox bind cannot name a home that does not exist yet.
          yield* ensureDir(yield* rootOf(user))
          const printed = yield* runCli(yield* invoke(user, provider, ["--version"]), `${spec.bin} --version`)
          if (!meetsMinimum(printed === null ? "" : printed.stdout + printed.stderr, minimum)) {
            return {
              provider,
              loggedIn: false,
              account: null,
              error: `${spec.bin} must be version ${minimum.join(".")} or newer${provider === "opencode-go" ? " for OpenCode Go" : " for the OpenCode Console sign-in"}`,
            }
          }
        }
        // No directory means no login: skip spawning the CLI.
        const dir = yield* providerDir(user, provider)
        const present = yield* Effect.promise(() => stat(dir).then((s) => s.isDirectory(), () => false))
        if (!present) return { provider, loggedIn: false, account: null }
        // A CLI without a status command is signed in while its token file exists; its stored login may also name the
        // signed-in account.
        if (spec.status.kind === "file") {
          const token = join(dir, spec.status.path)
          const signedIn = yield* Effect.promise(() => stat(token).then((s) => s.isFile(), () => false))
          if (!signedIn) return { provider, loggedIn: false, account: null }
          const account = yield* readAccountLabel(dir, spec.identity)
          return { provider, loggedIn: true, account }
        }
        const inv = yield* invoke(user, provider, spec.status.args)
        const out = yield* runCli(inv, `${spec.bin} status`)
        if (out === null) return { provider, loggedIn: false, account: null }
        const parsed = yield* spec.status.parse(out)
        // Status commands report how the CLI signed in, not who; the CLI's own stored login names the user, when it has
        // one. The account label is an email, never a method or token; null when no stored identity names one.
        if (!parsed.loggedIn) return { ...parsed, account: null }
        const account = yield* readAccountLabel(dir, spec.identity)
        return { ...parsed, account: account ?? parsed.account }
      }).pipe(
        Effect.catchTag("InternalError", (e) =>
          Effect.succeed<CliAuthStatus>({ provider, loggedIn: false, account: null, error: e.message }),
        ),
      )

    const status = (user: string) =>
      Effect.all(
        CLI_PROVIDERS.map((provider) => readStatus(user, provider)),
        { concurrency: "unbounded" },
      )

    const startLogin = (user: string, provider: CliProvider): Effect.Effect<CliLoginStart, BadRequest | InternalError> =>
      Effect.gen(function* () {
        const spec = AGENT_CLIS[provider]
        const signIn = spec.signIn
        if (signIn.kind !== "page") return yield* Effect.fail(new BadRequest({ message: `${provider} signs in with an API key` }))
        yield* ensureUserDirs(user, provider)
        const key = keyOf(user, provider)
        const previous = pending.get(key)
        if (previous) {
          killEntry(previous)
          yield* Effect.promise(() => previous.done)
        }
        const inv = yield* invoke(user, provider, signIn.args(yield* providerDir(user, provider)))
        const child = yield* Effect.try({
          try: () =>
            ownGroup(spawn(inv.file, [...inv.args], { env: { ...inv.env }, stdio: ["pipe", "pipe", "pipe"], detached: NEW_PROCESS_GROUP })),
          catch: () => new InternalError({ message: `${spec.bin} could not be started` }),
        })
        child.stdin?.on("error", () => {})
        const { promise: done, resolve: settle } = Promise.withResolvers<number | null>()
        child.once("error", () => settle(null))
        child.once("close", (code) => settle(code))
        const expiresAt = Date.now() + PENDING_TTL_MS
        const entry: Pending = {
          key,
          child,
          output: "",
          done,
          listeners: new Set(),
          timer: setTimeout(() => killEntry(entry), PENDING_TTL_MS),
        }
        const onChunk = (chunk: Buffer) => {
          entry.output += chunk.toString("utf8")
          for (const listener of entry.listeners) listener()
        }
        child.stdout?.on("data", onChunk)
        child.stderr?.on("data", onChunk)
        child.on("close", () => {
          clearTimeout(entry.timer)
          if (pending.get(key) === entry) pending.delete(key)
          for (const listener of entry.listeners) listener()
        })
        pending.set(key, entry)

        const link = yield* Effect.promise(() => waitFor(entry, (text) => signIn.parseLoginLink(stripAnsi(text)), LINK_TIMEOUT_MS))
        if (link === null) {
          killEntry(entry)
          const detail = lastLine(entry.output, [])
          return yield* Effect.fail(
            new InternalError({ message: `${spec.bin} did not print a sign-in link${detail === "" ? "" : `: ${detail}`}` }),
          )
        }
        return {
          provider,
          url: link.url,
          userCode: link.userCode,
          needsCode: signIn.needsCode,
          expiresAt: new Date(expiresAt).toISOString(),
        }
      })

    const submitCode = (
      user: string,
      provider: CliProvider,
      code: string,
    ): Effect.Effect<CliAuthStatus, BadRequest | InternalError> =>
      Effect.gen(function* () {
        yield* rootOf(user)
        const spec = AGENT_CLIS[provider]
        if (spec.signIn.kind !== "page" || !spec.signIn.needsCode) {
          return yield* Effect.fail(
            new BadRequest({ message: `${provider} signs in with a device code on the provider's page; there is no code to submit` }),
          )
        }
        const text = code.trim()
        if (text === "") return yield* Effect.fail(new BadRequest({ message: "code is empty" }))
        if (/[\r\n]/.test(text) || text.length > CODE_MAX) {
          return yield* Effect.fail(new BadRequest({ message: "code must be one line of at most 512 characters" }))
        }
        const entry = pending.get(keyOf(user, provider))
        if (!entry) {
          return yield* Effect.fail(new BadRequest({ message: `no sign-in is pending for ${provider}; start one first` }))
        }
        const before = entry.output.length
        entry.child.stdin?.write(`${text}\n`)
        // A rejected code gets the CLI's answer while the sign-in stays pending, so the user can retry;
        // the CLI does not exit on rejection.
        const rejection = yield* Effect.promise(() =>
          waitFor(
            entry,
            (output) => {
              const reply = output.slice(before)
              return CODE_REJECTED.test(reply) ? lastLine(reply, [text]) : null
            },
            CODE_TIMEOUT_MS,
          ),
        )
        if (rejection !== null) return yield* Effect.fail(new BadRequest({ message: rejection }))
        // An accepted code ends the CLI with exit 0; no exit by now means it did not answer in time.
        if (entry.child.exitCode === null) {
          killEntry(entry)
          return yield* Effect.fail(new InternalError({ message: `${spec.bin}: the code was not checked in time` }))
        }
        if (entry.child.exitCode !== 0) {
          const detail = lastLine(entry.output.slice(before), [text])
          return yield* Effect.fail(new BadRequest({ message: detail === "" ? "the code was rejected" : detail }))
        }
        return yield* readStatus(user, provider)
      })

    const logout = (user: string, provider: CliProvider): Effect.Effect<void, BadRequest | InternalError> =>
      Effect.gen(function* () {
        yield* rootOf(user)
        usageCache.delete(keyOf(user, provider))
        const current = pending.get(keyOf(user, provider))
        if (current) {
          killEntry(current)
          // The CLI owns an open credential database; wait for it to release its files before removing the directory.
          yield* Effect.promise(() => current.done)
        }
        const dir = yield* providerDir(user, provider)
        const present = yield* Effect.promise(() => stat(dir).then((s) => s.isDirectory(), () => false))
        // Revoke with the CLI when there is a login to revoke; a failed revoke still removes the local login.
        const revoke = AGENT_CLIS[provider].logout
        if (present && revoke !== null) {
          const inv = yield* invoke(user, provider, revoke)
          yield* runCli(inv, `${AGENT_CLIS[provider].bin} logout`).pipe(Effect.ignore)
        }
        yield* Effect.tryPromise({
          try: () => rm(dir, { recursive: true, force: true }),
          catch: () => new InternalError({ message: "cannot remove the sign-in directory" }),
        })
        for (const key of [...commandCache.keys()]) {
          if (key.startsWith(`${user}\0`)) commandCache.delete(key)
        }
      })

    const submitKey = (user: string, provider: CliProvider, rawKey: string): Effect.Effect<CliAuthStatus, BadRequest | InternalError> =>
      Effect.gen(function* () {
        const spec = AGENT_CLIS[provider]
        const signIn = spec.signIn
        if (signIn.kind !== "key") return yield* Effect.fail(new BadRequest({ message: `${provider} signs in on the provider's page` }))
        const key = rawKey.trim()
        if (key.length < 8 || key.length > 4096 || /[\r\n]/.test(key)) {
          return yield* Effect.fail(new BadRequest({ message: "API key must be one line of 8–4096 characters" }))
        }
        yield* ensureUserDirs(user, provider)
        // Import skips an existing credential ID, so remove just that credential, retaining the CLI's sessions.
        if (spec.logout !== null) {
          const revoke = yield* invoke(user, provider, spec.logout)
          yield* runCli(revoke, `${spec.bin} logout`)
        }
        const inv = yield* invoke(user, provider, signIn.args)
        const stored = yield* runCli(inv, `${spec.bin} key import`, signIn.stdin(key), true)
        if (stored === null) return yield* Effect.fail(new InternalError({ message: `${spec.bin} is not installed` }))
        usageCache.delete(keyOf(user, provider))
        usageEpochs.set(keyOf(user, provider), (usageEpochs.get(keyOf(user, provider)) ?? 0) + 1)
        const result = yield* readStatus(user, provider)
        if (!result.loggedIn) return yield* Effect.fail(new InternalError({ message: `${spec.bin} did not store the key` }))
        return result
      })

    const loggedInDirs = (user: string): Effect.Effect<ReadonlyArray<CliLoginDir>, BadRequest | InternalError> =>
      Effect.map(
        Effect.all(
          CLI_PROVIDERS.map((provider) =>
            Effect.flatMap(readStatus(user, provider), (s) =>
              s.loggedIn
                ? Effect.map(providerDir(user, provider), (dir): CliLoginDir | null => ({ provider, dir }))
                : Effect.succeed(null),
            ).pipe(
              // A status check that fails must not block runs: the run falls back to the broker's keys.
              Effect.catchAll((e) =>
                Effect.as(Effect.logWarning(`${provider} status for ${user} failed: ${e.message}`), null),
              ),
            ),
          ),
          { concurrency: "unbounded" },
        ),
        (dirs) => dirs.filter((d): d is CliLoginDir => d !== null),
      )

    const shutdown = () =>
      Effect.sync(() => {
        for (const entry of [...pending.values()]) killEntry(entry)
        killActiveDiscovery()
      })

    return {
      status,
      startLogin,
      submitCode,
      submitKey,
      logout,
      loggedInDirs,
      discoverCommands,
      providerUsage,
      useBankedReset,
      shutdown,
    }
  }),
)
