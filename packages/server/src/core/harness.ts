import { Context, Effect, Either, Layer, Runtime } from "effect"
import { spawn, type ChildProcess } from "node:child_process"
import { createWriteStream, type WriteStream } from "node:fs"
import { chmod, mkdir, writeFile } from "node:fs/promises"
import { createInterface } from "node:readline"
import { basename, join } from "node:path"
import {
  InternalError,
  type AgentEffort,
  type AgentModel,
  type CliProvider,
  type Message,
  type Run,
  type ServerEvent,
  type Task,
} from "@cloudagents/protocol"
import { CliAuth } from "../cliauth"
import { CredentialBroker } from "../broker"
import { Config } from "../config"
import { NEW_PROCESS_GROUP, killProcessGroup, ownGroup } from "../process"
import { SANDBOX_HOME, agentHome, initBox, prepareLaunch, sandboxSettingsOf } from "../sandbox"
import { EventHub } from "./events"
import { StateStore, newId, nowIso, type Mutable, type StoreState } from "./state"

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
  /** Kills a running run and marks it cancelled; a cancelled run's question is dropped. */
  readonly cancel: (runId: string) => Effect.Effect<void, InternalError>
  /** Marks a run that never started as failed. */
  readonly abort: (runId: string, reason: string) => Effect.Effect<void, InternalError>
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
  resultText: string | null
}

const KILL_GRACE_MS = 3000

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

    const finish = (runId: string, exitCode: number | null, spawnError: string | null) =>
      Effect.gen(function* () {
        // The run's broker token dies with the run, whatever the outcome.
        yield* broker.revoke(runId)
        const entry = active.get(runId)
        if (!entry) return
        active.delete(runId)
        entry.log.end()
        if (spawnError) entry.stderrLines.push(spawnError)

        const outcome = yield* store.update((s) => {
          const run = s.runs.find((r) => r.id === runId)
          // Cancelled (or otherwise finished) runs keep their state.
          if (!run || run.status !== "running") return Either.right(null)
          const task = s.tasks.find((t) => t.id === run.taskId)
          if (!task) return Either.right(null)
          const ok = exitCode === 0
          const now = nowIso()
          run.status = ok ? "succeeded" : "failed"
          run.exitCode = exitCode
          run.endedAt = now
          // An agent that asked for input keeps that state until the user answers.
          if (task.status !== "needs_input") task.status = ok ? "done" : "failed"
          task.updatedAt = now
          const text =
            entry.resultText ??
            (entry.stdoutLines.join("\n").trim() ||
              entry.stderrLines.join("\n").trim() ||
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

    /** Remembers the agent session a run runs under, so the task's next run can resume it. */
    const recordSession = (runId: string, sessionId: string) =>
      store
        .update((s) => {
          s.runSessions = [...s.runSessions.filter((x) => x.runId !== runId), { runId, sessionId }]
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
          killProcessGroup(entry.child.pid, "SIGTERM")
          const timer = setTimeout(() => {
            if (active.has(runId)) killProcessGroup(entry.child.pid, "SIGKILL")
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
          if (
            typeof parsed === "object" &&
            parsed !== null &&
            "type" in parsed &&
            parsed.type === "result" &&
            "result" in parsed &&
            typeof parsed.result === "string"
          ) {
            entry.resultText = parsed.result
          }
          const sessionId = sessionIdOf(parsed)
          if (sessionId !== null) runFork(recordSession(runId, sessionId))
          publish({ _tag: "agent.output", taskId: entry.taskId, runId, stream: "event", text: line })
          return
        } catch {
          // not JSON after all; fall through to raw stdout
        }
      }
      entry.stdoutLines.push(line)
      publish({ _tag: "agent.output", taskId: entry.taskId, runId, stream: "stdout", text: line })
    }

    const shape: AgentHarnessShape = {
      spawn: (task, run, prompt, display, user, resumeSession, choice) =>
        Effect.gen(function* () {
          const runDir = join(config.runsDir, run.id)
          const homeDir = join(config.homesDir, task.id)
          const mcpUrl = `${config.mcpBaseUrl}/mcp/${task.id}`
          const mcpConfigHost = join(homeDir, ".cloudagents", "mcp.json")
          const mcpConfigAgent = join(agentHome(settings, homeDir), ".cloudagents", "mcp.json")

          const started = yield* Effect.gen(function* () {
            // The run's token authorizes its MCP session as well as its model calls.
            const lease = yield* broker.issue(run.id, user)
            yield* Effect.tryPromise({
              try: async () => {
                await mkdir(runDir, { recursive: true })
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
              worktreePath: task.worktreePath,
              gitCommonDir: join(config.reposDir, task.repoId, ".git"),
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
              command: config.agentCommand,
              roBinds: config.fakeAgentRoBinds,
              binds: loginDirs.map((d) => ({ host: d.host, sandbox: d.inside })),
            })

            return yield* Effect.try({
              try: () => {
                const child = ownGroup(
                  spawn(launch.file, [...launch.args], {
                    cwd: launch.cwd,
                    env: { ...launch.env },
                    detached: NEW_PROCESS_GROUP,
                    stdio: ["ignore", "pipe", "pipe"],
                  }),
                )
                const log = createWriteStream(join(runDir, "output.log"), { flags: "a" })
                const entry: ActiveRun = {
                  child,
                  log,
                  taskId: task.id,
                  stdoutLines: [],
                  stderrLines: [],
                  resultText: null,
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
                return null
              },
              catch: (e) => new InternalError({ message: `failed to spawn agent: ${String(e)}` }),
            })
          }).pipe(Effect.either)

          if (Either.isLeft(started)) {
            yield* shape.abort(run.id, started.left.message)
            return yield* Effect.fail(started.left)
          }
        }),

      cancel: (runId) => stopRun(runId, false),

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

      stopAll: () =>
        Effect.forEach([...active.keys()], (runId) => stopRun(runId, true).pipe(Effect.ignore), {
          discard: true,
        }),
    }
    return shape
  }),
)

/**
 * The agent session a JSON output line names, or null. Claude Code's stream-json opens with
 * `{"type":"system","subtype":"init","session_id":…}`; `codex exec --json` opens with
 * `{"type":"thread.started","thread_id":…}`.
 */
const sessionIdOf = (event: unknown): string | null => {
  if (typeof event !== "object" || event === null || !("type" in event)) return null
  if (event.type === "system" && "subtype" in event && event.subtype === "init" && "session_id" in event) {
    return typeof event.session_id === "string" ? event.session_id : null
  }
  if (event.type === "thread.started" && "thread_id" in event) {
    return typeof event.thread_id === "string" ? event.thread_id : null
  }
  return null
}
