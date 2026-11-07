import { Context, Effect, Layer, Option } from "effect"
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
  type ModelDiscoverySource,
  type ModelInfo,
  type ProviderUsage,
  type UseBankedResetResult,
} from "@cloudagents/protocol"
import { AGENT_CLIS, CLI_PROVIDERS, MODEL_HARNESS, type AgentCli, type CliOutput, type HarnessMinimum } from "./agent-clis"
import { meetsMinimum } from "./capabilities"
import { Config } from "./config"
import { killActiveDiscovery, limitCliProbe, limitDiscovery } from "./harness-commands"
import {
  NATIVE_MODEL_PROVIDER,
  discoverNativeModels,
  nativeDiscoveryArgs,
  type HarnessModelDiscovery,
} from "./harness-model-discovery"
import { NEW_PROCESS_GROUP, killProcessGroup, ownGroup, platformEnv, shell } from "./process"
import { openCodeGoKey as parseOpenCodeGoKey } from "./provider-usage"
import { boxHomeToolArgs, cliBwrapArgs, findExecutable } from "./sandbox"

/** POSIX quoting for one argv element run through `sh -c`. */
const posixQuote = (value: string): string => `'${value.replace(/'/g, `'\\''`)}'`

/** `argv` under `script`'s pseudo-terminal, for a CLI that reads its input only from a terminal; null on Windows. */
const terminalCommand = (argv: ReadonlyArray<string>): ReadonlyArray<string> | null => {
  if (process.platform === "win32") return null
  // BSD script takes the command as arguments; util-linux script takes one shell command line.
  if (process.platform === "darwin") return ["script", "-q", "/dev/null", ...argv]
  return ["script", "-qfec", argv.map(posixQuote).join(" "), "/dev/null"]
}

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
/** Native model discovery's whole answer must fit the relay's request budget; each child is bounded below this too. */
const NATIVE_DISCOVERY_BUDGET_MS = 17_000
/** One CLI's model-discovery child, before the remaining overall budget shortens it. */
const PER_CLI_DISCOVERY_TIMEOUT_MS = 15_000
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
   * The active OpenCode Go key from `user`'s OpenCode credential store (`auth export`), or null when it has none. The
   * key stays on the host: only a brokered Go route's grant carries it, never a sandboxed process or state file.
   */
  readonly opencodeGoKey: (user: string) => Effect.Effect<string | null, BadRequest | InternalError>
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
   * The models `user`'s native CLI logins can run, with one source status per CLI. Each CLI starts in an isolated,
   * box-owned empty workspace with the user's own login home and its provider's network; it never starts a model turn
   * or writes a thread. A signed-out or non-enumerating CLI reports that in its source rather than failing the catalog.
   */
  readonly discoverModels: (user: string) => Effect.Effect<HarnessModelDiscovery, BadRequest | InternalError>
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
  Effect.tryPromise({
    try: (signal) => limitCliProbe(() => {
      // A cancelled catalog read may still be queued. Never start its probe after it loses its budget.
      if (signal.aborted) return Promise.reject(signal.reason)
      const { promise, resolve, reject } = Promise.withResolvers<CliOutput | null>()
      const child = execFile(
        inv.file, [...inv.args],
        { env: { ...inv.env }, timeout: STATUS_TIMEOUT_MS, signal },
        (err, stdout, stderr) => {
          if (err && (err as NodeJS.ErrnoException).code === "ENOENT") return resolve(null)
          if (err && err.killed) return reject(new InternalError({ message: `${label}: timed out` }))
          if (err && requireSuccess) return reject(new InternalError({ message: `${label}: command failed` }))
          resolve({ stdout, stderr })
        },
      )
      child.stdin?.on("error", () => {})
      child.stdin?.end(input)
      return promise
    }),
    catch: (cause) => cause instanceof InternalError
      ? cause
      : new InternalError({ message: `${label}: CLI probe unavailable` }),
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
        // `script` runs its command through $SHELL; the user's login shell (for example NixOS' nu) is not in the
        // sandbox, so terminal sign-ins get the toolchain's shell instead of inheriting an unavailable path.
        const shellPath = findExecutable("bash", path) ?? findExecutable("sh", path) ?? "/bin/sh"
        return {
          ...(config.sandbox === "off" ? platformEnv() : {}),
          PATH: path,
          SHELL: shellPath,
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
     * sandbox is disabled (local debugging). Sign-in keeps the box network; command discovery runs in its thread
     * workspace with no network at all, so repo-controlled config cannot reach the box's loopback services. Model
     * discovery needs its provider's network (the CLI fetches its own catalog), so it asks for it explicitly and keeps
     * the same empty workspace isolation.
     */
    const invoke = (
      user: string,
      provider: CliProvider,
      args: ReadonlyArray<string>,
      discovery?: { readonly workspacePath: string; readonly cwd: string; readonly network?: "host" | "none" },
      terminal = false,
    ): Effect.Effect<Invocation, BadRequest | InternalError> =>
      Effect.gen(function* () {
        const bin = AGENT_CLIS[provider].bin
        const env = yield* cliEnv(user, provider)
        const command = terminal ? terminalCommand([bin, ...args]) : [bin, ...args]
        if (command === null) {
          return yield* Effect.fail(new InternalError({ message: `${bin} signs in only from a terminal, which this box cannot provide` }))
        }
        if (config.sandbox === "off") {
          // Windows installs the CLIs as `.cmd` shims, which spawn cannot launch directly; the repo's POSIX shell
          // runs them like agent commands do, with SystemRoot and the rest of the platform env in place.
          if (process.platform === "win32") {
            return { file: shell(), args: ["-c", command.map(posixQuote).join(" ")], env }
          }
          return { file: command[0] as string, args: command.slice(1), env }
        }
        const bwrap = findExecutable("bwrap")
        if (bwrap === null) return yield* Effect.fail(new InternalError({ message: "bwrap (bubblewrap) not found on PATH" }))
        const root = yield* rootOf(user)
        const sandbox =
          discovery === undefined
            ? { network: "host" as const }
            : {
                network: discovery.network ?? ("none" as const),
                workspacePath: discovery.workspacePath,
                cwd: discovery.cwd,
              }
        const level = config.sandbox === "strict" ? "strict" : "basic"
        return {
          file: bwrap,
          args: cliBwrapArgs(root, env, command, {
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
    /** `opencode auth export` is a process launch per Go-routed run; one turn reuses a bit-identical answer. */
    const goKeyCache = new Map<string, { readonly at: number; readonly key: string | null }>()
    const GO_KEY_CACHE_MS = 30_000
    const GO_KEY_CACHE_MAX = 64

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
          return {
            provider,
            loggedIn: false,
            account: null,
            error: `${spec.bin} is not installed on the box (not on its PATH)`,
            cannotSignIn: true,
          }
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
              cannotSignIn: true,
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
        // The status command itself was missing (a Windows shim that no longer exists): no login can exist.
        if (out === null) return { provider, loggedIn: false, account: null, cannotSignIn: true }
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

    /** A fixed, path-free reason a source failed: a CLI's output and the box's paths never reach the catalog. */
    const discoveryFailure = (message: string): string => {
      if (message.includes("timed out")) return "model discovery timed out"
      if (message.includes("printed too much")) return "the CLI printed too much"
      if (message.includes("could not be started")) return "the CLI could not be started"
      if (message.includes("exited before answering")) return "the CLI exited before answering"
      if (message.includes("refused") || message.includes("could not initialize")) return "the CLI refused model discovery"
      return "model discovery failed"
    }

    /**
     * One CLI's models and its source entry. A signed-out CLI is not spawned; one that fails or runs out of the
     * overall budget becomes an `error` source, so the other providers' models still reach the picker.
     */
    const discoverProviderModels = (
      user: string,
      provider: CliProvider,
      workspace: string,
      deadline: number,
    ): Effect.Effect<{ readonly models: ReadonlyArray<ModelInfo>; readonly source: ModelDiscoverySource }, BadRequest> =>
      Effect.gen(function* () {
        const spec = AGENT_CLIS[provider]
        const source = (status: ModelDiscoverySource["status"], message?: string): ModelDiscoverySource => ({
          provider: NATIVE_MODEL_PROVIDER[provider],
          source: provider,
          status,
          ...(message === undefined ? {} : { message }),
          checkedAt: new Date().toISOString(),
        })
        const timedOut = (): {
          readonly models: ReadonlyArray<ModelInfo>
          readonly source: ModelDiscoverySource
        } => ({ models: [], source: source("error", "model discovery timed out") })
        const login = yield* readStatus(user, provider)
        if (!login.loggedIn) {
          return {
            models: [],
            source: source("unsupported", login.error === undefined ? "not signed in" : `${spec.bin} is not signed in or unavailable`),
          }
        }
        // A status probe can consume the budget (OpenCode checks its version first); do not start a child after it.
        if (Date.now() >= deadline) return timedOut()
        return yield* Effect.gen(function* () {
          // The CLI refuses to start without its config home; it is still the user's own, never the box's.
          yield* ensureUserDirs(user, provider)
          const inv = yield* invoke(user, provider, nativeDiscoveryArgs(provider, yield* providerDir(user, provider)), {
            workspacePath: workspace,
            cwd: workspace,
            network: "host",
          })
          const found = yield* Effect.tryPromise({
            try: () =>
              limitDiscovery(() => {
                // A queued child that only gets a slot after the budget must not start at all.
                const left = deadline - Date.now()
                if (left <= 0) return Promise.reject(new Error(`${provider} model discovery timed out`))
                return discoverNativeModels(
                  provider,
                  { file: inv.file, args: inv.args, env: inv.env, cwd: workspace },
                  Math.min(PER_CLI_DISCOVERY_TIMEOUT_MS, left),
                )
              }),
            catch: (e) => new InternalError({ message: e instanceof Error ? e.message : `${spec.bin} model discovery failed` }),
          })
          return { models: found.models, source: source(found.status, found.message) }
        }).pipe(
          Effect.catchTag("InternalError", (e) =>
            Effect.succeed<{
              readonly models: ReadonlyArray<ModelInfo>
              readonly source: ModelDiscoverySource
            }>({ models: [], source: source("error", discoveryFailure(e.message)) }),
          ),
        )
      })

    /**
     * Every native CLI's models for `user`. The CLIs run in one box-owned, empty workspace per user (never a thread
     * workspace), read-only inside their sandbox, so no project config, thread or checkout is read or written; each
     * child is bounded and killed with its process group, and the whole load fits NATIVE_DISCOVERY_BUDGET_MS so a slow
     * provider becomes its own source status instead of starving the catalog response.
     */
    const discoverModels = (user: string): Effect.Effect<HarnessModelDiscovery, BadRequest | InternalError> =>
      Effect.gen(function* () {
        yield* rootOf(user)
        const scratch = join(config.dataDir, "discovery")
        const workspace = join(scratch, user)
        yield* ensureDir(scratch)
        yield* ensureDir(workspace)
        const deadline = Date.now() + NATIVE_DISCOVERY_BUDGET_MS
        const timedOut = (
          provider: CliProvider,
        ): { readonly models: ReadonlyArray<ModelInfo>; readonly source: ModelDiscoverySource } => ({
          models: [],
          source: {
            provider: NATIVE_MODEL_PROVIDER[provider],
            source: provider,
            status: "error",
            message: "model discovery timed out",
            checkedAt: new Date().toISOString(),
          },
        })
        const found = yield* Effect.all(
          CLI_PROVIDERS.map((provider) =>
            discoverProviderModels(user, provider, workspace, deadline).pipe(
              Effect.timeoutOption(NATIVE_DISCOVERY_BUDGET_MS),
              Effect.map(Option.getOrElse(() => timedOut(provider))),
            ),
          ),
          { concurrency: "unbounded" },
        )
        const models = new Map<string, ModelInfo>()
        for (const entry of found) for (const model of entry.models) models.set(model.id, model)
        return { models: [...models.values()], sources: found.map((entry) => entry.source) }
      })

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
        const inv = yield* invoke(user, provider, signIn.args(yield* providerDir(user, provider)), undefined, signIn.terminal)
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
        const signIn = spec.signIn
        if (signIn.kind !== "page" || !signIn.needsCode) {
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
        // A terminal's Enter is a carriage return.
        entry.child.stdin?.write(`${text}${signIn.terminal ? "\r" : "\n"}`)
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
        if (provider === "opencode-go") goKeyCache.delete(user)
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
        goKeyCache.delete(user)
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

    const opencodeGoKey = (user: string): Effect.Effect<string | null, BadRequest | InternalError> =>
      Effect.gen(function* () {
        // Every Go-routed chat run and text generation asks for this key; a short cache keeps one turn from paying an
        // extra CLI launch each time. Saving or disconnecting a key clears the entry immediately.
        const cached = goKeyCache.get(user)
        if (cached !== undefined && Date.now() - cached.at < GO_KEY_CACHE_MS) return cached.key
        const inv = yield* invoke(user, "opencode-go", ["auth", "export", "--standalone"])
        const output = yield* runCli(inv, "opencode auth export", undefined, true)
        if (output === null) return null
        let printed: unknown
        try {
          printed = JSON.parse(output.stdout)
        } catch {
          return yield* Effect.fail(
            new InternalError({ message: "opencode auth export did not print JSON; cannot read the OpenCode Go credential" }),
          )
        }
        if (!Array.isArray(printed)) {
          return yield* Effect.fail(
            new InternalError({ message: "opencode auth export printed an unexpected shape; cannot read the OpenCode Go credential" }),
          )
        }
        const key = parseOpenCodeGoKey(printed)
        goKeyCache.set(user, { at: Date.now(), key })
        while (goKeyCache.size > GO_KEY_CACHE_MAX) {
          const oldest = goKeyCache.keys().next().value
          if (oldest === undefined) break
          goKeyCache.delete(oldest)
        }
        return key
      })

    return {
      status,
      startLogin,
      submitCode,
      submitKey,
      logout,
      loggedInDirs,
      opencodeGoKey,
      discoverCommands,
      discoverModels,
      providerUsage,
      useBankedReset,
      shutdown,
    }
  }),
)
