import { Context, Effect, Either, Layer, Runtime, Schema } from "effect"
import { spawn, type ChildProcess } from "node:child_process"
import { createWriteStream, type WriteStream } from "node:fs"
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises"
import { createInterface } from "node:readline"
import { basename, join } from "node:path"
import {
  InternalError,
  RunItems,
  DEFAULT_MODEL_PROVIDER,
  modelInfo,
  type AgentEffort,
  type AgentItem,
  type AgentModel,
  type ContextUsage,
  type CliProvider,
  type Message,
  type ModelProvider,
  type Run,
  type ServerEvent,
  type Task,
} from "@cloudagents/protocol"
import { CliAuth } from "../cliauth"
import { CredentialBroker } from "../broker"
import { Config, VERSION } from "../config"
import { NEW_PROCESS_GROUP, killProcessGroup, ownGroup } from "../process"
import { SANDBOX_HOME, agentHome, initBox, prepareLaunch, sandboxSettingsOf } from "../sandbox"
import { EventHub } from "./events"
import { StateStore, newId, nowIso, type Mutable, type StoreState } from "./state"
import { makeCodexDriver, type CodexDriver, type CodexRunInput } from "./codex-app-server"
import { makeTranscript, type Transcript } from "./transcript"

export interface AgentHarnessShape {
  /**
   * Starts the harness for a run that is already persisted as `running` (see Core.sendMessage).
   * On spawn failure the run is aborted before the error is returned. `user` is the signed-in user
   * the run is for: their CLI logins replace the broker's API keys, and the broker uses their keys.
   * `resumeSession` is the agent session this run continues, or null for a fresh run.
   * `choice` is the model/effort the user picked for this message; omitted fields use the harness default.
   */
  readonly spawn: (
    task: Task,
    run: Run,
    prompt: string,
    display: string | null,
    user: string,
    resumeSession: string | null,
    choice: AgentChoice,
  ) => Effect.Effect<void, InternalError>
  /**
   * Stops a running run and marks it cancelled; a cancelled run's question is dropped. A Codex turn is interrupted
   * first, so it ends cleanly in its session; the process is killed when it does not exit in time.
   */
  readonly cancel: (runId: string) => Effect.Effect<void, InternalError>
  /**
   * Adds `text` to the run's live turn (Codex `turn/steer`). False when the run's harness cannot take it now (no
   * Codex turn going); the message then waits in the run's inbox for task_inbox.
   */
  readonly steer: (runId: string, text: string) => Effect.Effect<boolean>
  /** Marks a run that never started as failed. */
  readonly abort: (runId: string, reason: string) => Effect.Effect<void, InternalError>
  /** A run's display items: the live list while it runs, the persisted final list afterwards. */
  readonly items: (runId: string) => Effect.Effect<ReadonlyArray<AgentItem>, InternalError>
  /**
   * Plays a recorded fixture through the normal run pipeline (stdout -> items -> finish) instead
   * of launching an agent. Dev-only `/replay` flow; the fixture path is trusted repo state.
   */
  readonly replay: (task: Task, run: Run, fixturePath: string) => Effect.Effect<void, InternalError>
  /** Stops every active run at shutdown; their questions stay pending for the next start. */
  readonly stopAll: () => Effect.Effect<void>
}

export class AgentHarness extends Context.Tag("cloudagents/AgentHarness")<AgentHarness, AgentHarnessShape>() {}

/** Per-message agent choice; omitted fields leave the harness default. */
export interface AgentChoice {
  readonly model?: AgentModel
  readonly effort?: AgentEffort
}

interface ActiveRun {
  readonly child: ChildProcess
  readonly log: WriteStream
  readonly taskId: string
  readonly stdoutLines: string[]
  readonly stderrLines: string[]
  /** Display items in insertion order; a replacement keeps its original position. */
  readonly items: Map<string, AgentItem>
  /** When each item was last published, and replacements held back until ITEM_PUBLISH_MS has passed. */
  readonly published: Map<string, number>
  readonly held: Map<string, AgentItem>
  heldTimer: ReturnType<typeof setTimeout> | null
  readonly transcript: Transcript
  /** Context use last stored on the task. */
  context: ContextUsage | null
  /** Agent session id, once the CLI names it. */
  sessionId: string | null
  /** The app-server conversation of a Codex run; null for Claude runs and replays, which only print. */
  codex: CodexDriver | null
}

/** What a run starts from besides its process: the session's last context use, and its Codex turn if it is one. */
interface RunSession {
  readonly seed: ContextUsage | null
  readonly codex: Omit<CodexRunInput, "clientVersion"> | null
}

/** How to start a run's child process; real agent launches and replays differ only here. */
interface ProcessSpec {
  readonly file: string
  readonly args: ReadonlyArray<string>
  readonly cwd: string
  readonly env: NodeJS.ProcessEnv
}

const KILL_GRACE_MS = 3000
/**
 * Least time between two publishes of the same item. Codex streams text, reasoning and command output a token at a
 * time, and every event is a relay message; the latest version always goes out when the window ends.
 */
const ITEM_PUBLISH_MS = 100
/** App-server notifications that stream a token at a time; their effect reaches the app as items, not raw lines. */
const DELTA_METHOD = /\/(delta|outputDelta|summaryTextDelta|textDelta)$/

/** Env var pointing each CLI at a user's login, and the broker keys that login replaces. */
const LOGIN_ENV: Record<CliProvider, { readonly env: string; readonly broker: ReadonlyArray<string> }> = {
  "claude-cli": { env: "CLAUDE_CONFIG_DIR", broker: ["ANTHROPIC_API_KEY", "ANTHROPIC_BASE_URL"] },
  "codex-cli": { env: "CODEX_HOME", broker: ["OPENAI_API_KEY", "OPENAI_BASE_URL"] },
}

export const AgentHarnessLive = Layer.effect(
  AgentHarness,
  Effect.gen(function* () {
    const config = yield* Config
    const store = yield* StateStore
    const hub = yield* EventHub
    const broker = yield* CredentialBroker
    const cliAuth = yield* CliAuth
    const settings = sandboxSettingsOf(config)
    if (settings.systemd) {
      yield* initBox(settings.systemd)
      yield* Effect.logInfo(
        `agent sandboxes run in systemd slice ${settings.systemd.boxSlice}.slice, per task: MemoryMax=${settings.systemd.limits.memoryMax} CPUQuota=${settings.systemd.limits.cpuQuota} TasksMax=${settings.systemd.limits.tasksMax}`,
      )
    }
    const runtime = yield* Effect.runtime<never>()
    const runFork = Runtime.runFork(runtime)
    const active = new Map<string, ActiveRun>()

    const publish = hub.publish

    /** Applies `f` to a run and its task inside one state update; publishes what changed. */
    const patchRunAndTask = (
      runId: string,
      f: (run: Mutable<Run>, task: Mutable<Task>, s: StoreState) => void,
    ): Effect.Effect<void, InternalError> =>
      Effect.gen(function* () {
        const changed = yield* store.update((s) => {
          const run = s.runs.find((r) => r.id === runId)
          if (!run) return Either.right(null)
          const task = s.tasks.find((t) => t.id === run.taskId)
          if (!task) return Either.right(null)
          f(run, task, s)
          task.updatedAt = nowIso()
          return Either.right({ run: { ...run }, task: { ...task } })
        })
        if (changed === null) return
        publish({ _tag: "run.updated", run: changed.run })
        publish({ _tag: "task.updated", task: changed.task })
      })

    /** Stores the task's context use (null clears it) and publishes the task; not an activity, so `updatedAt` stays. */
    const setContext = (taskId: string, context: ContextUsage | null) =>
      Effect.gen(function* () {
        const changed = yield* store.update((s) => {
          const task = s.tasks.find((t) => t.id === taskId)
          if (!task) return Either.right(null)
          if (context === null) delete task.context
          else task.context = context
          return Either.right({ ...task })
        })
        if (changed !== null) publish({ _tag: "task.updated", task: changed })
      }).pipe(Effect.catchAll((e) => Effect.logWarning(`task ${taskId}: could not store context use: ${e.message}`)))

    /** Publishes the items held back by ITEM_PUBLISH_MS now. */
    const flushHeld = (runId: string, entry: ActiveRun) => {
      clearTimeout(entry.heldTimer ?? undefined)
      entry.heldTimer = null
      const now = Date.now()
      for (const item of entry.held.values()) {
        entry.published.set(item.id, now)
        publish({ _tag: "agent.item", taskId: entry.taskId, runId, item })
      }
      entry.held.clear()
    }

    /** Stores a run's item and publishes it: a new item at once, a replacement at most every ITEM_PUBLISH_MS. */
    const putItem = (runId: string, entry: ActiveRun, item: AgentItem) => {
      entry.items.set(item.id, item)
      const now = Date.now()
      const last = entry.published.get(item.id)
      if (last === undefined || now - last >= ITEM_PUBLISH_MS) {
        entry.held.delete(item.id)
        entry.published.set(item.id, now)
        publish({ _tag: "agent.item", taskId: entry.taskId, runId, item })
        return
      }
      entry.held.set(item.id, item)
      entry.heldTimer ??= setTimeout(() => flushHeld(runId, entry), ITEM_PUBLISH_MS)
    }

    const finish = (runId: string, exitCode: number | null, spawnError: string | null) =>
      Effect.gen(function* () {
        // The run's broker token dies with the run, whatever the outcome.
        yield* broker.revoke(runId)
        const entry = active.get(runId)
        if (!entry) return
        active.delete(runId)
        entry.log.end()
        if (spawnError) entry.stderrLines.push(spawnError)
        // A Codex run is over when its turn is, whatever app-server's exit code; a refused request or an early exit
        // shows as the run's error, unless the run was stopped on purpose.
        entry.codex?.close()
        const codexOutcome = entry.codex?.outcome() ?? null
        const cancelled = (yield* store.read).runs.find((r) => r.id === runId)?.status !== "running"
        if (codexOutcome?.status === "failed" && codexOutcome.error !== null && !cancelled) {
          putItem(runId, entry, { _tag: "error", id: "codex-run", text: codexOutcome.error })
        }
        flushHeld(runId, entry)
        // The items are the run's display history; keep them next to the raw log for later reads.
        yield* Effect.tryPromise({
          try: () =>
            writeFile(join(config.runsDir, runId, "items.json"), JSON.stringify([...entry.items.values()]), "utf8"),
          catch: (e) => new InternalError({ message: `cannot write run items: ${String(e)}` }),
        }).pipe(Effect.catchAll((e) => Effect.logWarning(`run ${runId}: ${e.message}`)))

        const outcome = yield* store.update((s) => {
          const run = s.runs.find((r) => r.id === runId)
          // Cancelled (or otherwise finished) runs keep their state.
          if (!run || run.status !== "running") return Either.right(null)
          const task = s.tasks.find((t) => t.id === run.taskId)
          if (!task) return Either.right(null)
          const ok = entry.codex === null ? exitCode === 0 : codexOutcome?.status === "completed"
          const now = nowIso()
          run.status = ok ? "succeeded" : "failed"
          run.exitCode = exitCode
          run.endedAt = now
          // An agent that asked for input keeps that state until the user answers.
          if (task.status !== "needs_input") task.status = ok ? "done" : "failed"
          task.updatedAt = now
          // A Codex run's stderr is app-server's own log, not the agent's output.
          const failure = codexOutcome?.status === "failed" ? codexOutcome.error : null
          const text =
            entry.transcript.finalText() ??
            failure ??
            (entry.stdoutLines.join("\n").trim() ||
              (entry.codex === null ? entry.stderrLines.join("\n").trim() : "") ||
              (ok ? "Run finished with no output." : `Run failed (exit code ${exitCode ?? "none"}).`))
          const message: Message = {
            id: newId(),
            taskId: task.id,
            role: "agent",
            text,
            runId,
            createdAt: now,
          }
          s.messages.push(message)
          return Either.right({ run: { ...run }, task: { ...task }, message })
        })
        if (outcome === null) return
        publish({ _tag: "message.created", message: outcome.message })
        publish({ _tag: "run.updated", run: outcome.run })
        publish({ _tag: "task.updated", task: outcome.task })
      }).pipe(
        Effect.catchAll((e) => Effect.logError(`run ${runId} finalize failed: ${e.message}`)),
      )

    /** Remembers the agent session a run runs under and its provider, so the task's next run can resume it. */
    const recordSession = (runId: string, sessionId: string, provider: ModelProvider) =>
      store
        .update((s) => {
          s.runSessions = [...s.runSessions.filter((x) => x.runId !== runId), { runId, sessionId, provider }]
          return Either.right(null)
        })
        .pipe(Effect.catchAll((e) => Effect.logWarning(`run ${runId}: could not record its session: ${e.message}`)))

    /**
     * Kills a running run and marks it cancelled. A cancel also drops the run's question. At shutdown (`shutdown`),
     * a run that waits on a question keeps it, and its task keeps waiting, for the next start.
     */
    const stopRun = (runId: string, shutdown: boolean): Effect.Effect<void, InternalError> =>
      Effect.gen(function* () {
        yield* broker.revoke(runId)
        const entry = active.get(runId)
        if (entry) {
          // An interrupted Codex turn ends on its own and closes the process; anything else is signalled now.
          const interrupted = entry.codex?.interrupt() ?? false
          if (!interrupted) killProcessGroup(entry.child.pid, "SIGTERM")
          const timer = setTimeout(() => {
            if (!active.has(runId)) return
            if (interrupted) {
              killProcessGroup(entry.child.pid, "SIGTERM")
              setTimeout(() => active.has(runId) && killProcessGroup(entry.child.pid, "SIGKILL"), KILL_GRACE_MS).unref()
            } else {
              killProcessGroup(entry.child.pid, "SIGKILL")
            }
          }, KILL_GRACE_MS)
          timer.unref()
        }
        yield* patchRunAndTask(runId, (run, task, s) => {
          if (run.status !== "running") return
          run.status = "cancelled"
          run.exitCode = null
          run.endedAt = nowIso()
          if (shutdown && s.pendingAsks.some((a) => a.runId === runId)) return
          s.pendingAsks = s.pendingAsks.filter((a) => a.runId !== runId)
          task.status = "idle"
        })
      })

    const handleLine = (runId: string, stream: "stdout" | "stderr", line: string) => {
      const entry = active.get(runId)
      if (!entry) return
      entry.log.write(`${line}\n`)
      if (stream === "stderr") {
        entry.stderrLines.push(line)
        publish({ _tag: "agent.output", taskId: entry.taskId, runId, stream, text: line })
        return
      }
      const trimmed = line.trim()
      if (trimmed.startsWith("{")) {
        try {
          const parsed: unknown = JSON.parse(trimmed)
          entry.codex?.receive(parsed)
          // Every parsed line goes through the run's transcript, whether or not it yields items.
          for (const item of entry.transcript.push(parsed)) putItem(runId, entry, item)
          const context = entry.transcript.context()
          if (context !== null && context !== entry.context) {
            entry.context = context
            runFork(setContext(entry.taskId, context))
          }
          const session = sessionOf(parsed)
          if (session !== null) {
            entry.sessionId = session.sessionId
            runFork(recordSession(runId, session.sessionId, session.provider))
          }
          const method = typeof parsed === "object" && parsed !== null && "method" in parsed ? parsed.method : null
          if (typeof method !== "string" || !DELTA_METHOD.test(method)) {
            publish({ _tag: "agent.output", taskId: entry.taskId, runId, stream: "event", text: line })
          }
          return
        } catch {
          // not JSON after all; fall through to raw stdout
        }
      }
      entry.stdoutLines.push(line)
      publish({ _tag: "agent.output", taskId: entry.taskId, runId, stream: "stdout", text: line })
    }

    /**
     * Starts the run's child and wires stdout/stderr into the shared line, finish and cancel paths. A real agent
     * launch and a replay differ only in the `ProcessSpec`; a Codex run also talks to app-server over stdin.
     */
    const startRun = (task: Task, run: Run, spec: ProcessSpec, session: RunSession): Effect.Effect<void, InternalError> =>
      Effect.gen(function* () {
        const runDir = join(config.runsDir, run.id)
        yield* Effect.tryPromise({
          try: () => mkdir(runDir, { recursive: true }),
          catch: (e) => new InternalError({ message: `cannot prepare run dir: ${String(e)}` }),
        })
        yield* Effect.try({
          try: () => {
            const child = ownGroup(
              spawn(spec.file, [...spec.args], {
                cwd: spec.cwd,
                env: { ...spec.env },
                detached: NEW_PROCESS_GROUP,
                stdio: ["pipe", "pipe", "pipe"],
              }),
            )
            const log = createWriteStream(join(runDir, "output.log"), { flags: "a" })
            const entry: ActiveRun = {
              child,
              log,
              taskId: task.id,
              stdoutLines: [],
              stderrLines: [],
              items: new Map(),
              published: new Map(),
              held: new Map(),
              heldTimer: null,
              transcript: makeTranscript(session.seed),
              context: session.seed,
              sessionId: null,
              codex: null,
            }
            const stdin = child.stdin
            // A closed pipe (the CLI is gone) shows up as the child's exit, not as a write error.
            stdin.on("error", () => undefined)
            // Claude runs and replays only print; they read an empty stdin.
            if (session.codex === null) stdin.end()
            else {
              entry.codex = makeCodexDriver(
                { ...session.codex, clientVersion: VERSION },
                {
                  send: (message) => {
                    const line = JSON.stringify(message)
                    log.write(`>> ${line}\n`)
                    stdin.write(`${line}\n`)
                  },
                  onThread: (threadId) => {
                    entry.sessionId = threadId
                    runFork(recordSession(run.id, threadId, "openai"))
                  },
                  // The turn is over: app-server exits once its stdin closes, or is killed when it does not.
                  onDone: () => {
                    stdin.end()
                    setTimeout(() => active.has(run.id) && killProcessGroup(child.pid, "SIGTERM"), KILL_GRACE_MS).unref()
                  },
                },
              )
            }
            active.set(run.id, entry)
            createInterface({ input: child.stdout }).on("line", (line) => handleLine(run.id, "stdout", line))
            createInterface({ input: child.stderr }).on("line", (line) => handleLine(run.id, "stderr", line))
            child.on("error", (err) => {
              runFork(finish(run.id, null, `failed to start agent: ${err.message}`))
            })
            child.on("close", (code) => {
              runFork(finish(run.id, code, null))
            })
            entry.codex?.start()
          },
          catch: (e) => new InternalError({ message: `failed to spawn agent: ${String(e)}` }),
        })
      })

    const readItems = (runId: string): Effect.Effect<ReadonlyArray<AgentItem>, InternalError> =>
      Effect.gen(function* () {
        const entry = active.get(runId)
        if (entry) return [...entry.items.values()]
        const file = join(config.runsDir, runId, "items.json")
        const text = yield* Effect.tryPromise({
          try: async () => {
            try {
              return await readFile(file, "utf8")
            } catch (e) {
              // No items file means the run produced none (or never got as far as writing one).
              if ((e as NodeJS.ErrnoException).code === "ENOENT") return null
              throw e
            }
          },
          catch: (e) => new InternalError({ message: `cannot read run items: ${String(e)}` }),
        })
        if (text === null) return []
        return yield* Schema.decodeUnknown(Schema.parseJson(RunItems))(text).pipe(
          Effect.mapError((e) => new InternalError({ message: `cannot decode run items: ${e.message}` })),
        )
      })

    const shape: AgentHarnessShape = {
      spawn: (task, run, prompt, display, user, resumeSession, choice) =>
        Effect.gen(function* () {
          const provider = choice.model === undefined ? DEFAULT_MODEL_PROVIDER : modelInfo(choice.model).provider
          const homeDir = join(config.homesDir, task.id)
          const mcpUrl = `${config.mcpBaseUrl}/mcp/${task.id}`
          const mcpConfigHost = join(homeDir, ".cloudagents", "mcp.json")
          const mcpConfigAgent = join(agentHome(settings, homeDir), ".cloudagents", "mcp.json")

          const started = yield* Effect.gen(function* () {
            // The run's token authorizes its MCP session as well as its model calls.
            const lease = yield* broker.issue(run.id, user)
            yield* Effect.tryPromise({
              try: async () => {
                await mkdir(join(homeDir, ".cloudagents"), { recursive: true })
                const mcpJson = {
                  mcpServers: {
                    cloudagents: { type: "http", url: mcpUrl, headers: { Authorization: `Bearer ${lease.token}` } },
                  },
                }
                // The file carries the run's token: owner-only, including when it already existed.
                await writeFile(mcpConfigHost, JSON.stringify(mcpJson, null, 2), { encoding: "utf8", mode: 0o600 })
                await chmod(mcpConfigHost, 0o600)
              },
              catch: (e) => new InternalError({ message: `cannot prepare run dir: ${String(e)}` }),
            })

            // A user's own CLI logins replace the broker's API keys for that provider.
            const logins = yield* cliAuth.loggedInDirs(user).pipe(Effect.mapError((e) => new InternalError({ message: e.message })))
            const loginDirs = logins.map((login) => ({
              provider: login.provider,
              host: login.dir,
              // Sandboxed runs see the login under their home; unsandboxed runs read it in place.
              inside: settings.enabled ? join(SANDBOX_HOME, ".kestrel", basename(login.dir)) : login.dir,
            }))
            const dropped = new Set(logins.flatMap((login) => LOGIN_ENV[login.provider].broker))
            const keptBroker = Object.fromEntries(Object.entries(lease.env).filter(([key]) => !dropped.has(key)))
            const loginEnv = Object.fromEntries(loginDirs.map((d) => [LOGIN_ENV[d.provider].env, d.inside]))
            const launch = yield* prepareLaunch({
              settings,
              taskId: task.id,
              kind: "run",
              workspacePath: join(config.threadsDir, task.id),
              mirrorDir: join(config.mirrorsDir, task.owner),
              homeDir,
              display,
              env: {
                CLOUDAGENTS_PROMPT: prompt,
                ...(choice.model === undefined ? {} : { CLOUDAGENTS_MODEL: choice.model }),
                ...(choice.effort === undefined ? {} : { CLOUDAGENTS_EFFORT: choice.effort }),
                CLOUDAGENTS_MCP_CONFIG: mcpConfigAgent,
                CLOUDAGENTS_MCP_URL: mcpUrl,
                CLOUDAGENTS_TASK_ID: task.id,
                CLOUDAGENTS_RUN_ID: run.id,
                CLOUDAGENTS_MCP_TOKEN: lease.token,
                // Claude Code's MCP tool-call timeout (ms). task_ask has no timeout of its own: the largest timer
                // delay lets a question wait as long as the user takes to answer.
                MCP_TOOL_TIMEOUT: String(2 ** 31 - 1),
                // Continues the agent session of the task's previous run, so the agent keeps the thread's context.
                ...(resumeSession === null ? {} : { CLOUDAGENTS_RESUME_SESSION: resumeSession }),
                ...keptBroker,
                ...loginEnv,
              },
              command: config.agentCommands[provider],
              roBinds: config.fakeAgentRoBinds,
              binds: loginDirs.map((d) => ({ host: d.host, sandbox: d.inside })),
            })

            // A fresh session starts empty; the previous session's context use no longer applies.
            if (resumeSession === null && task.context !== undefined) yield* setContext(task.id, null)
            yield* startRun(
              task,
              run,
              { file: launch.file, args: launch.args, cwd: launch.cwd, env: { ...launch.env } },
              {
                seed: resumeSession === null ? null : (task.context ?? null),
                codex:
                  provider === "openai"
                    ? {
                        text: run.prompt,
                        prompt,
                        resumeThread: resumeSession,
                        model: choice.model,
                        effort: choice.effort,
                        // The run's broker token, unless the user's own Codex login replaced it.
                        apiKey: keptBroker.OPENAI_API_KEY,
                      }
                    : null,
              },
            )
          }).pipe(Effect.either)

          if (Either.isLeft(started)) {
            yield* shape.abort(run.id, started.left.message)
            return yield* Effect.fail(started.left)
          }
        }),

      replay: (task, run, fixturePath) =>
        Effect.gen(function* () {
          // A replay is trusted repo code running on the host: it only reads a repo fixture and
          // prints its lines, so it needs no sandbox, broker token, MCP config or checkout. From stdout
          // on it takes the same paths as a real agent run (handleLine, finish, cancel).
          const serverDir = join(import.meta.dir, "..", "..")
          // The fixture is a session of its own.
          if (task.context !== undefined) yield* setContext(task.id, null)
          const started = yield* startRun(
            task,
            run,
            {
              file: process.execPath,
              args: [join(serverDir, "scripts", "replay-agent.ts"), fixturePath],
              cwd: serverDir,
              env: { ...process.env },
            },
            { seed: null, codex: null },
          ).pipe(Effect.either)
          if (Either.isLeft(started)) {
            yield* shape.abort(run.id, started.left.message)
            return yield* Effect.fail(started.left)
          }
        }),

      cancel: (runId) => stopRun(runId, false),

      steer: (runId, text) =>
        Effect.promise(() => active.get(runId)?.codex?.steer(text) ?? Promise.resolve(false)),

      abort: (runId, reason) =>
        Effect.gen(function* () {
          yield* broker.revoke(runId)
          const now = nowIso()
          const outcome = yield* store.update((s) => {
            const run = s.runs.find((r) => r.id === runId)
            if (!run || run.status !== "running") return Either.right(null)
            const task = s.tasks.find((t) => t.id === run.taskId)
            if (!task) return Either.right(null)
            run.status = "failed"
            run.exitCode = null
            run.endedAt = now
            task.status = "failed"
            task.updatedAt = now
            const message: Message = {
              id: newId(),
              taskId: task.id,
              role: "system",
              text: `Run could not start: ${reason}`,
              runId,
              createdAt: now,
            }
            s.messages.push(message)
            return Either.right({ run: { ...run }, task: { ...task }, message })
          })
          if (outcome === null) return
          publish({ _tag: "message.created", message: outcome.message })
          publish({ _tag: "run.updated", run: outcome.run })
          publish({ _tag: "task.updated", task: outcome.task })
        }),

      items: readItems,

      stopAll: () =>
        Effect.forEach([...active.keys()], (runId) => stopRun(runId, true).pipe(Effect.ignore), {
          discard: true,
        }),
    }
    return shape
  }),
)

/**
 * The agent session a JSON output line names, and the provider that minted it, or null. Claude Code's stream-json
 * opens with `{"type":"system","subtype":"init","session_id":…}`. A Codex run's thread comes from its driver.
 */
const sessionOf = (event: unknown): { readonly sessionId: string; readonly provider: ModelProvider } | null => {
  if (typeof event !== "object" || event === null || !("type" in event)) return null
  if (event.type === "system" && "subtype" in event && event.subtype === "init" && "session_id" in event) {
    return typeof event.session_id === "string" ? { sessionId: event.session_id, provider: "anthropic" } : null
  }
  return null
}
