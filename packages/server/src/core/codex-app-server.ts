import type { HarnessCommand } from "@cloudagents/protocol"
import type { RunDriver, RunOutcome } from "./run-driver"
import { isRecord } from "./transcript"

/*
 * A Codex run speaks app-server's JSON-RPC over the CLI's stdin/stdout: `initialize`, then `thread/start` (or
 * `thread/resume` of the thread's session), then one turn. The process lives as long as the run; while its turn is
 * going, a user message steers it (`turn/steer`) and Stop interrupts it (`turn/interrupt`). Notifications are not
 * handled here: every stdout line also goes through the run's transcript.
 */

/**
 * The Codex commands a Kestrel thread can run, with Codex's own descriptions. The rest of Codex's slash commands
 * drive its terminal UI or have their own place in Kestrel (model picker, Diff tab, new thread).
 */
export const CODEX_COMMANDS: ReadonlyArray<HarnessCommand> = [
  { name: "review", description: "review my current changes and find issues", argumentHint: "[instructions]", prefix: "/" },
  { name: "compact", description: "summarize conversation to prevent hitting the context limit", prefix: "/" },
  { name: "init", description: "create an AGENTS.md file with instructions for Codex", prefix: "/" },
]

/** Codex's own `/init` prompt (codex-rs/tui/assets/prompt_for_init_command.md). */
const INIT_PROMPT = `Generate a file named AGENTS.md that serves as a contributor guide for this repository.
Before writing, check whether AGENTS.md already exists in the current working directory. If it does, do not overwrite or modify it.
Your goal is to produce a clear, concise, and well-structured document with descriptive headings and actionable explanations for each section.
Follow the outline below, but adapt as needed — add sections if relevant, and omit those that do not apply to this project.

Document Requirements

- Title the document "Repository Guidelines".
- Use Markdown headings (#, ##, etc.) for structure.
- Keep the document concise. 200-400 words is optimal.
- Keep explanations short, direct, and specific to this repository.
- Provide examples where helpful (commands, directory paths, naming patterns).
- Maintain a professional, instructional tone.

Recommended Sections

Project Structure & Module Organization

- Outline the project structure, including where the source code, tests, and assets are located.

Build, Test, and Development Commands

- List key commands for building, testing, and running locally (e.g., npm test, make build).
- Briefly explain what each command does.

Coding Style & Naming Conventions

- Specify indentation rules, language-specific style preferences, and naming patterns.
- Include any formatting or linting tools used.

Testing Guidelines

- Identify testing frameworks and coverage requirements.
- State test naming conventions and how to run tests.

Commit & Pull Request Guidelines

- Summarize commit message conventions found in the project’s Git history.
- Outline pull request requirements (descriptions, linked issues, screenshots, etc.).

(Optional) Add other sections if relevant, such as Security & Configuration Tips, Architecture Overview, or Agent-Specific Instructions.`

/**
 * What `/review` reviews without instructions. Codex's own default (`uncommittedChanges`) diffs the working
 * directory, but a thread's workspace is not a repository: its checkouts are directories inside it.
 */
const REVIEW_CHANGES = "Review the uncommitted changes in every git repository under the current directory."

type CodexCommandName = "review" | "compact" | "init"

/** The Codex command a message runs, or null for a plain prompt. Only the message's own text counts. */
export const codexCommandOf = (text: string): { readonly name: CodexCommandName; readonly args: string } | null => {
  const match = /^\/(review|compact|init)(?:\s+([\s\S]*))?$/.exec(text.trim())
  if (match === null) return null
  return { name: match[1] as CodexCommandName, args: (match[2] ?? "").trim() }
}

export interface CodexRunInput {
  /** The user's own message: decides whether the run is a Codex command. */
  readonly text: string
  /** What a plain turn sends: the message with the box's user context around it. */
  readonly prompt: string
  /** The thread's previous Codex session, or null for a fresh one. */
  readonly resumeThread: string | null
  readonly model?: string
  readonly effort?: string
  /**
   * Key to sign app-server in with (the run's broker token), or undefined when CODEX_HOME already holds the user's
   * own login. App-server reads no key from its environment; the login is stored in CODEX_HOME.
   */
  readonly apiKey?: string
  readonly clientVersion: string
}

export interface CodexDriverIo {
  /** Writes one JSON-RPC message to the CLI's stdin. */
  readonly send: (message: unknown) => void
  /** The run's Codex thread, once app-server has started or resumed it. */
  readonly onThread: (threadId: string) => void
  /** The run's turn is over (or never started); the process can be let go. Called once. */
  readonly onDone: (outcome: RunOutcome) => void
}

/** Server requests that approve an action. Kestrel's sandbox is the boundary, so every action is approved. */
const APPROVALS: Readonly<Record<string, unknown>> = {
  "item/commandExecution/requestApproval": { decision: "accept" },
  "item/fileChange/requestApproval": { decision: "accept" },
  execCommandApproval: { decision: "approved" },
  applyPatchApproval: { decision: "approved" },
}

const textInput = (text: string) => [{ type: "text", text, text_elements: [] }]

const errorText = (error: unknown): string =>
  isRecord(error) && typeof error.message === "string" ? error.message : "app-server refused the request"

export const makeCodexDriver = (input: CodexRunInput, io: CodexDriverIo): RunDriver => {
  const command = codexCommandOf(input.text)
  let nextId = 1
  const pending = new Map<number, (message: Record<string, unknown>) => void>()
  let threadId: string | null = null
  /** The run's own turn: from the request that started it, or the first `turn/started` for `/compact`. */
  let turnId: string | null = null
  let outcome: RunOutcome | null = null

  const request = (method: string, params: unknown, onResult: (message: Record<string, unknown>) => void) => {
    const id = nextId++
    pending.set(id, onResult)
    io.send({ method, id, params })
  }

  const finish = (result: RunOutcome) => {
    if (outcome !== null) return
    outcome = result
    io.onDone(result)
  }

  /** A failed request ends the run; its error is the run's error. */
  const orFail = (method: string, then: (result: Record<string, unknown>) => void) => (message: Record<string, unknown>) => {
    if (message.error !== undefined || !isRecord(message.result)) {
      finish({ status: "failed", error: `${method}: ${errorText(message.error)}` })
      return
    }
    then(message.result)
  }

  const startTurn = () => {
    const thread = threadId as string
    const effort = input.effort === undefined ? {} : { effort: input.effort }
    const adoptTurn = (result: Record<string, unknown>) => {
      const turn = result.turn
      if (isRecord(turn) && typeof turn.id === "string") turnId ??= turn.id
    }
    switch (command?.name) {
      case "compact":
        request("thread/compact/start", { threadId: thread }, orFail("thread/compact/start", () => undefined))
        return
      case "review":
        request(
          "review/start",
          { threadId: thread, target: { type: "custom", instructions: command.args === "" ? REVIEW_CHANGES : command.args } },
          orFail("review/start", adoptTurn),
        )
        return
      case "init":
        request("turn/start", { threadId: thread, input: textInput(INIT_PROMPT), ...effort }, orFail("turn/start", adoptTurn))
        return
      default:
        request("turn/start", { threadId: thread, input: textInput(input.prompt), ...effort }, orFail("turn/start", adoptTurn))
    }
  }

  const openThread = () => {
    // Kestrel's bwrap sandbox replaces Codex's own, and nobody is there to approve: approvals never stop a turn.
    const policy = { approvalPolicy: "never", sandbox: "danger-full-access", ...(input.model === undefined ? {} : { model: input.model }) }
    const onThread = (method: string) =>
      orFail(method, (result) => {
        const thread = result.thread
        if (!isRecord(thread) || typeof thread.id !== "string") {
          finish({ status: "failed", error: `${method}: no thread in the response` })
          return
        }
        threadId = thread.id
        io.onThread(thread.id)
        startTurn()
      })
    if (input.resumeThread === null) request("thread/start", policy, onThread("thread/start"))
    else request("thread/resume", { threadId: input.resumeThread, ...policy, excludeTurns: true }, onThread("thread/resume"))
  }

  const answerServerRequest = (message: Record<string, unknown>) => {
    const method = String(message.method)
    const approval = APPROVALS[method]
    io.send(
      approval === undefined
        ? { id: message.id, error: { code: -32601, message: `${method} is not supported by Kestrel` } }
        : { id: message.id, result: approval },
    )
  }

  const onNotification = (method: string, params: unknown) => {
    if (!isRecord(params)) return
    if (method === "turn/started" && isRecord(params.turn) && typeof params.turn.id === "string") {
      turnId ??= params.turn.id
      return
    }
    if (method !== "turn/completed" || !isRecord(params.turn)) return
    // A review runs inner turns of its own; only the run's turn ends the run.
    if (turnId !== null && params.turn.id !== turnId) return
    // The failed turn's error is in this notification, so the run's transcript shows it.
    switch (params.turn.status) {
      case "completed":
        finish({ status: "completed" })
        return
      case "interrupted":
        finish({ status: "interrupted" })
        return
      default:
        finish({ status: "failed", error: null })
    }
  }

  return {
    start: () => {
      if (command?.name === "compact" && input.resumeThread === null) {
        finish({ status: "failed", error: "There is no Codex conversation to compact yet." })
        return
      }
      request(
        "initialize",
        { clientInfo: { name: "kestrel", title: "Kestrel", version: input.clientVersion }, capabilities: { experimentalApi: true } },
        orFail("initialize", () => {
          io.send({ method: "initialized", params: {} })
          if (input.apiKey === undefined) openThread()
          else request("account/login/start", { type: "apiKey", apiKey: input.apiKey }, orFail("account/login/start", openThread))
        }),
      )
    },
    receive: (message) => {
      if (!isRecord(message)) return
      if (typeof message.method === "string") {
        if (message.id !== undefined) answerServerRequest(message)
        else onNotification(message.method, message.params)
        return
      }
      if (typeof message.id !== "number") return
      const onResult = pending.get(message.id)
      pending.delete(message.id)
      onResult?.(message)
    },
    steer: (text) => {
      if (threadId === null || turnId === null || outcome !== null) return Promise.resolve(false)
      const { promise, resolve } = Promise.withResolvers<boolean>()
      request("turn/steer", { threadId, expectedTurnId: turnId, input: textInput(text) }, (message) =>
        resolve(message.error === undefined),
      )
      return promise
    },
    interrupt: () => {
      if (threadId === null || turnId === null || outcome !== null) return false
      request("turn/interrupt", { threadId, turnId }, () => undefined)
      return true
    },
    close: () => {
      const unanswered = [...pending.values()]
      pending.clear()
      for (const onResult of unanswered) onResult({ error: { message: "Codex exited" } })
      finish({ status: "failed", error: "Codex exited before its turn finished." })
    },
    outcome: () => outcome,
  }
}
