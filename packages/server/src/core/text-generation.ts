import { Effect } from "effect"
import { spawn, type ChildProcess } from "node:child_process"
import { randomUUID } from "node:crypto"
import { createInterface } from "node:readline"
import { mkdir, readFile, rm } from "node:fs/promises"
import { basename, join } from "node:path"
import {
  InternalError,
  DEFAULT_MODEL_HARNESS,
  DEFAULT_MODEL_PROVIDER,
  modelInfo,
  modelUpstreamId,
  providerModels,
  type AgentEffort,
  type AgentModel,
  type Attachment,
  type ModelHarness,
  type ModelProvider,
  type RouteHarness,
  type TextGenerationSettings,
} from "@cloudagents/protocol"
import { AGENT_CLIS, harnessForModel, type Harness } from "../agent-clis"
import type { CliAuthShape } from "../cliauth"
import { brokerApiBase, DEFAULT_BROKER_API, type BrokerProvider, type CredentialBrokerShape } from "../broker"
import { loginsForModel, claudeTierEnv } from "./harness"
import { makeTranscript } from "./transcript"
import { makeAcpDriver } from "./acp"
import { NEW_PROCESS_GROUP, killProcessGroup, ownGroup } from "../process"
import { agentHome, prepareLaunch, removeTask, sandboxSettingsOf, stopTaskHolder, type Launch } from "../sandbox"
import { opencodeConfigContent, opencodeRouteModel, type ServerConfig } from "../config"

/** Dependencies the box already has for model runs; text generation reuses their credential and sandbox paths. */
export interface TextGeneratorDeps {
  readonly config: ServerConfig
  readonly cliAuth: CliAuthShape
  readonly broker: CredentialBrokerShape
}

export interface ThreadTitleRequest {
  readonly user: string
  /** The thread's first accepted message, framed with attachment names when it had files. */
  readonly source: string
  readonly settings: TextGenerationSettings
  /** The model the conversation itself was started with; used when no model is configured. */
  readonly conversationModel?: AgentModel
  readonly conversationEffort?: AgentEffort
}

export interface TextGenerator {
  /** A short thread title, or null when the provider returned nothing usable. */
  readonly threadTitle: (request: ThreadTitleRequest) => Effect.Effect<string | null, InternalError>
}

/** Longest message excerpt a title prompt carries: enough for intent, not the whole thread. */
const TITLE_SOURCE_MAX = 4000
/** Longest generated title kept, after trimming. */
export const TITLE_MAX = 80
/** How long a provider gets to answer before its whole process group is killed. */
const GENERATION_TIMEOUT_MS = 45_000
/** The most stdout/stderr held from a generation child. */
const OUTPUT_MAX_BYTES = 256 * 1024

const shellQuote = (value: string): string => `'${value.replace(/'/g, `'\\''`)}'`

/**
 * The model and thinking level generation uses: the configured model, or the conversation's model when it is null.
 * Only the conversation-model default inherits its thinking level; a separately selected model uses its own default.
 */
export const generationChoice = (
  settings: TextGenerationSettings,
  conversation: { readonly model?: AgentModel; readonly effort?: AgentEffort },
  provider: ModelProvider = DEFAULT_MODEL_PROVIDER,
): { readonly model: AgentModel; readonly effort?: AgentEffort } => {
  const model =
    settings.model ??
    conversation.model ??
    providerModels(provider).find((candidate) => candidate.shownByDefault)?.id ??
    providerModels(provider)[0]!.id
  const supported = modelInfo(model).efforts
  const effort =
    settings.effort !== null && supported.includes(settings.effort)
      ? settings.effort
      : settings.model === null && conversation.effort !== undefined && supported.includes(conversation.effort)
        ? conversation.effort
        : // No level was chosen: use the same default the composer shows (its fallback, else the lowest level).
          (modelInfo(model).defaultEffort ?? supported[0])
  return { model, ...(effort === undefined ? {} : { effort }) }
}

/**
 * The words a title is drawn from: what the user typed, then the names of files sent with it. An attachment-only
 * message still has a subject; a long message is cut to the part that states the request.
 */
export const titleSource = (text: string, attachments: ReadonlyArray<Attachment>): string => {
  const names = attachments.flatMap((attachment) => (attachment.name === undefined ? [] : [attachment.name]))
  const parts = [text.trim(), names.length === 0 ? "" : `Attached files: ${names.join(", ")}`].filter((part) => part !== "")
  const source = parts.join("\n\n").trim()
  return source.length > TITLE_SOURCE_MAX ? source.slice(0, TITLE_SOURCE_MAX) : source
}

/**
 * The title prompt is Kestrel's own, short like t3code's automatic thread naming: name the work, not the request.
 * The user's instructions are appended as requirements on top of it.
 */
export const threadTitlePrompt = (source: string, instructions: string): string => {
  const custom = instructions.trim()
  return [
    "Write a short title for this coding thread.",
    "",
    "- Use 3 to 8 words and at most 70 characters.",
    "- Name the concrete task or subject, not the fact that it is a request.",
    "- Use sentence case, no ending punctuation, and no quotes, Markdown or emoji.",
    "- Reply with the title only, on one line.",
    ...(custom === "" ? [] : ["", "Additional requirements:", custom]),
    "",
    "The user's first message:",
    '"""',
    source,
    '"""',
  ].join("\n")
}

/** A provider's answer cut to the one usable line: quotes, labels and Markdown fences removed. */
export const cleanGeneratedTitle = (raw: string): string | null => {
  for (const candidate of raw.split(/\r?\n/)) {
    let title = candidate.trim()
    if (title === "") continue
    title = title.replace(/^#+\s*/, "").trim()
    title = title.replace(/^["'`“”‘’]+|["'`“”‘’]+$/g, "").trim()
    title = title.replace(/^(?:title|thread title)\s*:\s*/i, "")
    title = title.replace(/^["'`“”‘’]+|["'`“”‘’]+$/g, "").trim()
    title = title.replace(/[.；;，,。:：]+$/, "").trim()
    title = title.replace(/\s+/g, " ")
    if (title === "") continue
    if (title.length > TITLE_MAX) title = `${[...title].slice(0, TITLE_MAX - 1).join("").trimEnd()}…`
    return title
  }
  return null
}

/**
 * Whether a generated title may still replace a thread's title: the thread still exists, is not archived, and kept
 * the provisional title it had when the first message was accepted. A rename, archive or delete since then wins.
 */
export const mayReplaceTitle = (
  task: { readonly owner: string; readonly title: string; readonly archivedAt?: string } | undefined,
  user: string,
  baseline: string,
): boolean => task !== undefined && task.owner === user && task.archivedAt === undefined && task.title === baseline

/**
 * The title request an accepted message makes, if any: only the first message of a thread that opted in with
 * `generateTitle`, and only a message the user sent (an automation or delegation keeps its explicit title).
 */
export const pendingTitleRequest = (
  task: { readonly title: string; readonly generateTitle?: boolean },
  from: { readonly id: string } | null,
  firstMessage: boolean,
  text: string,
  attachments: ReadonlyArray<Attachment>,
): { readonly baseline: string; readonly source: string } | null => {
  if (from !== null || task.generateTitle !== true || !firstMessage) return null
  const source = titleSource(text, attachments)
  return source === "" ? null : { baseline: task.title, source }
}

const toInternal = (message: string): InternalError => new InternalError({ message })

/** One child's captured streams and exit code. */
interface ChildOutput {
  readonly stdout: string
  readonly stderr: string
  readonly code: number | null
}

/**
 * Starts a prepared launch, optionally writes a prompt to stdin, and waits for it under a timeout. The whole process
 * group is killed whichever way it ends, so a provider CLI never outlives its title.
 */
const runChild = (
  launch: Pick<Launch, "file" | "args" | "cwd" | "env">,
  stdin: string | undefined,
): Effect.Effect<ChildOutput, InternalError> =>
  Effect.tryPromise({
    try: () => {
      const { promise, resolve, reject } = Promise.withResolvers<ChildOutput>()
      let child: ChildProcess
      try {
        child = ownGroup(
          spawn(launch.file, [...launch.args], {
            cwd: launch.cwd,
            env: { ...launch.env },
            detached: NEW_PROCESS_GROUP,
            stdio: ["pipe", "pipe", "pipe"],
            windowsHide: true,
          }),
        )
      } catch (e) {
        reject(new Error(`could not start: ${String(e)}`))
        return promise
      }
      let stdout = ""
      let stderr = ""
      let settled = false
      const finish = (action: () => void) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        child.stdout?.removeAllListeners()
        child.stderr?.removeAllListeners()
        child.removeAllListeners()
        child.stdin?.on("error", () => {})
        if (child.pid !== undefined) killProcessGroup(child.pid, "SIGKILL")
        action()
      }
      const timer = setTimeout(
        () => finish(() => reject(new Error(`timed out after ${GENERATION_TIMEOUT_MS / 1000}s`))),
        GENERATION_TIMEOUT_MS,
      )
      child.stdout?.on("data", (chunk: Buffer) => {
        if (stdout.length < OUTPUT_MAX_BYTES) stdout += chunk.toString("utf8").slice(0, OUTPUT_MAX_BYTES - stdout.length)
      })
      child.stderr?.on("data", (chunk: Buffer) => {
        if (stderr.length < OUTPUT_MAX_BYTES) stderr += chunk.toString("utf8").slice(0, OUTPUT_MAX_BYTES - stderr.length)
      })
      child.once("error", (error) => finish(() => reject(new Error(`could not start: ${error.message}`))))
      child.once("close", (code) => finish(() => resolve({ stdout, stderr, code })))
      child.stdin?.on("error", () => {})
      if (stdin === undefined) child.stdin?.end()
      else child.stdin?.end(stdin)
      return promise
    },
    catch: (e) => toInternal(`text generation failed: ${e instanceof Error ? e.message : String(e)}`),
  })

/** Runs an ACP harness for one turn with no MCP servers, collecting the assistant text it streams. */
const runAcp = (
  launch: Pick<Launch, "file" | "args" | "cwd" | "env">,
  prompt: string,
  model: string,
  effort: AgentEffort | undefined,
): Effect.Effect<string, InternalError> =>
  Effect.tryPromise({
    try: () => {
      const { promise, resolve, reject } = Promise.withResolvers<string>()
      let child: ChildProcess
      try {
        child = ownGroup(
          spawn(launch.file, [...launch.args], {
            cwd: launch.cwd,
            env: { ...launch.env },
            detached: NEW_PROCESS_GROUP,
            stdio: ["pipe", "pipe", "pipe"],
            windowsHide: true,
          }),
        )
      } catch (e) {
        reject(new Error(`could not start: ${String(e)}`))
        return promise
      }
      const transcript = makeTranscript(null, null)
      let text = ""
      let done = false
      let settled = false
      const finish = (action: () => void) => {
        if (settled) return
        settled = true
        done = true
        clearTimeout(timer)
        child.stdout?.removeAllListeners()
        child.stderr?.removeAllListeners()
        child.removeAllListeners()
        child.stdin?.on("error", () => {})
        if (child.pid !== undefined) killProcessGroup(child.pid, "SIGKILL")
        action()
      }
      const timer = setTimeout(
        () => finish(() => reject(new Error(`timed out after ${GENERATION_TIMEOUT_MS / 1000}s`))),
        GENERATION_TIMEOUT_MS,
      )
      const send = (message: unknown) => {
        if (done) return
        child.stdin!.write(`${JSON.stringify(message)}\n`)
      }
      const driver = makeAcpDriver(
        {
          prompt,
          cwd: launch.cwd,
          resumeSession: null,
          model,
          ...(effort === undefined ? {} : { effort }),
          mcpServers: [],
        },
        {
          send,
          onSession: () => undefined,
          onDone: (outcome) =>
            finish(() =>
              outcome.status === "completed"
                ? resolve(text || (transcript.finalText() ?? ""))
                : reject(
                    new Error(
                      outcome.status === "failed"
                        ? (outcome.error ?? "the agent failed to finish the turn")
                        : "the agent stopped the turn",
                    ),
                  ),
            ),
          // Generation is not a thread run: it may read nothing, write nothing and run no command.
          permission: "deny",
        },
      )
      child.stdout?.on("error", () => {})
      child.stderr?.on("data", () => {})
      child.stdin?.on("error", () => {})
      createInterface({ input: child.stdout! }).on("line", (line) => {
        if (done) return
        const trimmed = line.trim()
        if (!trimmed.startsWith("{")) return
        let parsed: unknown
        try {
          parsed = JSON.parse(trimmed)
        } catch {
          return
        }
        for (const item of transcript.push(parsed)) if (item._tag === "text") text = item.text
        driver.receive(parsed)
      })
      child.once("error", (error) => finish(() => reject(new Error(`could not start: ${error.message}`))))
      // A process that closes before the prompt's response never completed a turn: its output is not a title.
      child.once("close", () => finish(() => reject(new Error("the agent exited before its turn finished"))))
      driver.start()
      return promise
    },
    catch: (e) => toInternal(`text generation failed: ${e instanceof Error ? e.message : String(e)}`),
  })

/** The command for a routed/CLI harness with a one-shot mode, its prompt channel, and where Codex writes its answer. */
const oneShotCommand = (
  harness: Harness,
  model: string,
  effort: AgentEffort | undefined,
  lastMessage: string,
  openaiBaseUrl: string | undefined,
  routed: boolean,
): { readonly command: string; readonly stdin: boolean } => {
  if (harness.conversation === "claude") {
    const args = [
      "claude",
      "-p",
      "--output-format",
      "text",
      // No tools and no MCP servers: generation must not touch the thread or its files.
      "--tools",
      "",
      "--strict-mcp-config",
      "--disable-slash-commands",
      "--no-session-persistence",
      "--setting-sources",
      "",
      "--model",
      model,
      ...(effort === undefined ? [] : ["--effort", effort]),
    ]
    return { command: args.map(shellQuote).join(" "), stdin: true }
  }
  if (harness.conversation === "codex") {
    const providerArgs = routed
      ? [
          "-c", 'model_provider="kestrel"',
          "-c", 'model_providers.kestrel.name="Kestrel"',
          "-c", `model_providers.kestrel.base_url=${JSON.stringify(openaiBaseUrl ?? "")}`,
          "-c", 'model_providers.kestrel.env_key="OPENAI_API_KEY"',
          "-c", 'model_providers.kestrel.wire_api="responses"',
          "-c", "model_providers.kestrel.supports_websockets=false",
        ]
      : openaiBaseUrl === undefined
        ? []
        : ["-c", `openai_base_url=${JSON.stringify(openaiBaseUrl)}`]
    const args = [
      "codex",
      "exec",
      "--skip-git-repo-check",
      "--sandbox",
      "read-only",
      "--ignore-user-config",
      "--ignore-rules",
      "--ephemeral",
      "--output-last-message",
      lastMessage,
      "--model",
      model,
      ...providerArgs,
      ...(effort === undefined ? [] : ["-c", `model_reasoning_effort=${JSON.stringify(effort)}`]),
      "-",
    ]
    return { command: args.map(shellQuote).join(" "), stdin: true }
  }
  return { command: "", stdin: false }
}

export const makeTextGenerator = (deps: TextGeneratorDeps): TextGenerator => {
  const { config, cliAuth, broker } = deps
  const settings = sandboxSettingsOf(config)

  const threadTitle = (request: ThreadTitleRequest): Effect.Effect<string | null, InternalError> => {
    const id = `textgen-${randomUUID()}`
    const scratch = join(config.dataDir, "text-generation", "scratch", id)
    const homeDir = join(scratch, "home")
    const workspacePath = join(scratch, "workspace")
    const mirrorDir = join(scratch, "mirror")
    return Effect.gen(function* () {
      const conversationProvider = request.conversationModel === undefined ? DEFAULT_MODEL_PROVIDER : modelInfo(request.conversationModel).provider
      const selected = generationChoice(
        request.settings,
        {
          ...(request.conversationModel === undefined ? {} : { model: request.conversationModel }),
          ...(request.conversationEffort === undefined ? {} : { effort: request.conversationEffort }),
        },
        conversationProvider,
      )
      const info = modelInfo(selected.model)
      const provider = info.provider
      const harnessId: ModelHarness = info.harness ?? DEFAULT_MODEL_HARNESS[provider]
      const harness = harnessForModel(selected.model)
      const routed = info.harness !== undefined
      const prompt = threadTitlePrompt(request.source, request.settings.threadTitleInstructions)
      // Credentials are read before anything is written, so a refused read leaves no scratch directory.
      const channel: BrokerProvider | null = harness.broker ? (provider as BrokerProvider) : null
      const goKey =
        provider === "opencode-go" && channel !== null
          ? yield* cliAuth.opencodeGoKey(request.user).pipe(
              Effect.mapError((e) => toInternal(`cannot read the OpenCode Go key: ${e.message}`)),
            )
          : null
      const lease =
        channel === null
          ? null
          : yield* broker.issue(id, request.user, channel, {
              harness: harnessId as RouteHarness,
              opencodeGoKey: goKey,
              sessionId: id,
            })
      const logins = loginsForModel(
        selected.model,
        provider,
        yield* cliAuth.loggedInDirs(request.user).pipe(Effect.mapError((e) => toInternal(`cannot read CLI logins: ${e.message}`))),
      )
      const loginDirs = logins.map((login) => ({
        provider: login.provider,
        host: login.dir,
        inside: settings.level === "off" ? login.dir : join(agentHome(settings, homeDir), ".kestrel", basename(login.dir)),
      }))
      yield* Effect.tryPromise({
        try: () => Promise.all([mkdir(homeDir, { recursive: true }), mkdir(workspacePath, { recursive: true }), mkdir(mirrorDir, { recursive: true })]),
        catch: (e) => toInternal(`cannot prepare text generation: ${String(e)}`),
      })
      const dropped = new Set(logins.flatMap((login) => AGENT_CLIS[login.provider].brokerEnv))
      const brokerEnv = Object.fromEntries(Object.entries(lease?.env ?? {}).filter(([key]) => !dropped.has(key)))
      const loginEnv = Object.fromEntries(loginDirs.map((dir) => [AGENT_CLIS[dir.provider].configEnv, dir.inside]))
      const modelId = modelUpstreamId(selected.model)
      const opencodeEnv: Record<string, string> =
        harness.conversation === "acp" && harness.bin === "opencode"
          ? {
              OPENCODE_CONFIG_CONTENT: opencodeConfigContent(
                lease !== null && harnessId === "opencode" && channel !== null
                  ? {
                      // The config's base must be the API `brokerTarget` resolves for this provider.
                      baseURL: brokerApiBase(lease.base, channel, DEFAULT_BROKER_API[channel]),
                      api: DEFAULT_BROKER_API[channel],
                      upstreamModel: modelId,
                      name: provider,
                    }
                  : null,
              ),
            }
          : {}
      const command = routed ? config.agentRouteCommands[harnessId as RouteHarness] : config.agentCommands[provider]
      const agentEnv: Record<string, string> = {
        ...(config.fakeAgent ? { CLOUDAGENTS_TEXT_GENERATION: "1" } : {}),
        CLOUDAGENTS_MODEL: modelId,
        CLOUDAGENTS_HARNESS: harnessId,
        ...(selected.effort === undefined ? {} : { CLOUDAGENTS_EFFORT: selected.effort }),
        ...(provider !== "anthropic" && harness.conversation === "claude" ? claudeTierEnv(selected.model) : {}),
        ...brokerEnv,
        ...opencodeEnv,
        ...loginEnv,
      }
      const prepare = (command: string) =>
        prepareLaunch({
          settings,
          taskId: id,
          gitIdentity: { name: request.user, email: `${request.user}@kestrel.invalid` },
          kind: "exec",
          workspacePath,
          cwd: workspacePath,
          mirrorDir,
          homeDir,
          display: null,
          env: agentEnv,
          command,
          roBinds: config.fakeAgentRoBinds,
          binds: loginDirs.map((dir) => ({ host: dir.host, sandbox: dir.inside })),
        })
      const lastMessageInside = join(agentHome(settings, homeDir), "last-message.txt")
      const lastMessageHost = join(homeDir, "last-message.txt")

      const run = Effect.gen(function* () {
        const configured = command
        if (config.fakeAgent) {
          if (configured === "") return yield* Effect.fail(toInternal("no command is configured for this provider"))
          const launch = yield* prepare(configured)
          const output = yield* runChild(launch, prompt)
          if (output.code !== 0) return yield* Effect.fail(toInternal(`text generation failed (exit code ${output.code ?? "none"})`))
          return output.stdout
        }
        if (harness.conversation === "acp") {
          if (configured === "") return yield* Effect.fail(toInternal("no ACP command is configured for this provider"))
          const acpModel = routed && harnessId === "opencode" ? opencodeRouteModel(modelId) : modelId
          return yield* runAcp(yield* prepare(configured), prompt, acpModel, selected.effort)
        }
        const spec = oneShotCommand(harness, modelId, selected.effort, lastMessageInside, brokerEnv.OPENAI_BASE_URL, routed)
        if (spec.command === "") return yield* Effect.fail(toInternal("no one-shot command is configured for this provider"))
        const output = yield* runChild(yield* prepare(spec.command), spec.stdin ? prompt : undefined)
        if (output.code !== 0) return yield* Effect.fail(toInternal(`text generation failed (exit code ${output.code ?? "none"})`))
        if (harness.conversation === "codex") {
          // The file is the answer; stdout also carries progress and diagnostics, which must not become a title.
          return yield* Effect.tryPromise({
            try: () => readFile(lastMessageHost, "utf8"),
            catch: (e) => toInternal(`codex wrote no final message: ${String(e)}`),
          })
        }
        return output.stdout
      })
      const raw = yield* run
      return cleanGeneratedTitle(raw)
    }).pipe(
      // The token dies with the generation and the scratch workspace never outlives it, whatever the outcome.
      Effect.ensuring(broker.revoke(id).pipe(Effect.ignore)),
      Effect.ensuring(
        Effect.tryPromise({ try: () => rm(scratch, { recursive: true, force: true }), catch: () => undefined }).pipe(Effect.ignore),
      ),
      // Each generation owns its sandbox runtime; drop its holder and systemd slice instead of leaking both.
      Effect.ensuring(
        Effect.gen(function* () {
          yield* Effect.sync(() => stopTaskHolder(id))
          if (settings.systemd !== null) {
            yield* removeTask(settings.systemd, id).pipe(
              Effect.catchAll((e) => Effect.logWarning(`text generation ${id}: ${e.message}`)),
            )
          }
        }),
      ),
    )
  }

  return { threadTitle }
}
