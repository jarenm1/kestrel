import type { Message, TaskStatus } from "@cloudagents/protocol"
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import type { RequestHandlerExtra } from "@modelcontextprotocol/sdk/shared/protocol.js"
import type { ServerNotification, ServerRequest } from "@modelcontextprotocol/sdk/types.js"
import { Effect } from "effect"
import { z } from "zod"
import { type RunContext, guard, runTool, text } from "./common"

const MAX_OPTIONS = 10
const MAX_OPTION_CHARS = 200
const PROGRESS_EVERY_MS = 15_000

export interface TaskAttachmentInput {
  readonly mimeType: string
  readonly bytes: Uint8Array
}

export interface AskToolInput {
  readonly question: string
  readonly options: ReadonlyArray<string>
  readonly attachments: ReadonlyArray<TaskAttachmentInput>
}

export interface TaskToolDeps {
  readonly report: (
    taskId: string,
    runId: string,
    input: { status: TaskStatus; message: string; attachments: ReadonlyArray<TaskAttachmentInput> },
  ) => Effect.Effect<void, unknown>
  readonly ask: (taskId: string, runId: string, input: AskToolInput) => Effect.Effect<string, unknown>
  readonly inbox: (taskId: string, runId: string) => Effect.Effect<ReadonlyArray<Message>, unknown>
  readonly desktop: { readonly screenshot: (taskId: string) => Effect.Effect<Uint8Array, unknown> }
}

/** The desktop as a PNG attachment, when the agent asked for one; nothing otherwise. */
const screenshotIfAsked = (deps: TaskToolDeps, taskId: string, asked: boolean) =>
  Effect.gen(function* () {
    if (!asked) return []
    const bytes = yield* deps.desktop.screenshot(taskId)
    return [{ mimeType: "image/png", bytes }]
  })

/**
 * While a question waits, progress pings let MCP clients that reset their call timeout on progress keep the call
 * open. Clients that send no progress token get no pings.
 */
const pingWhileWaiting = (extra: RequestHandlerExtra<ServerRequest, ServerNotification>): Effect.Effect<never> => {
  const progressToken = extra._meta?.progressToken
  if (progressToken === undefined) return Effect.never
  let progress = 0
  return Effect.forever(
    Effect.sleep(PROGRESS_EVERY_MS).pipe(
      Effect.zipRight(
        Effect.tryPromise(() => {
          progress += 1
          return extra.sendNotification({
            method: "notifications/progress",
            params: { progressToken, progress, message: "waiting for the user" },
          })
        }),
      ),
      Effect.ignore,
    ),
  )
}

/**
 * Fails when the client abandons the call: it cancels the request, or the connection closes. The question then stays
 * pending, and the user's next message answers it.
 */
const abandonedCall = (extra: RequestHandlerExtra<ServerRequest, ServerNotification>): Effect.Effect<never, Error> =>
  Effect.async<never, Error>((resume) => {
    const fail = () => resume(Effect.fail(new Error("the call was cancelled")))
    if (extra.signal.aborted) return fail()
    extra.signal.addEventListener("abort", fail, { once: true })
    return Effect.sync(() => extra.signal.removeEventListener("abort", fail))
  })

export const registerTaskTools = (server: McpServer, ctx: RunContext, deps: TaskToolDeps): void => {
  server.registerTool(
    "task_report",
    {
      description:
        "Report the task's state to the user. Use 'working' while making progress, 'needs_input' when you need " +
        "an answer from the user (prefer task_ask, which waits for the answer), 'done' when the work is complete, " +
        "or 'failed' if you cannot complete it. Set attachScreenshot to attach a PNG of the current desktop (it must be running; see desktop_open).",
      inputSchema: {
        status: z.enum(["working", "needs_input", "done", "failed"]).describe("Current task state"),
        message: z.string().describe("Short message for the user"),
        attachScreenshot: z.boolean().optional().describe("Attach a PNG screenshot of the task desktop to the message"),
      },
    },
    ({
      status,
      message,
      attachScreenshot,
    }: {
      status: "working" | "needs_input" | "done" | "failed"
      message: string
      attachScreenshot?: boolean
    }) =>
      guard(() =>
        runTool(
          Effect.gen(function* () {
            const mapped: TaskStatus = status === "working" ? "running" : status
            const attachments = yield* screenshotIfAsked(deps, ctx.taskId, attachScreenshot === true)
            yield* deps.report(ctx.taskId, ctx.runId, { status: mapped, message, attachments })
            return text(`reported ${mapped}`)
          }),
        ),
      ),
  )

  server.registerTool(
    "task_ask",
    {
      description:
        "Ask the user a question and wait for their answer. Use it when you need a decision you cannot make alone. " +
        "The question appears in the chat with the options as buttons; the user can also type a reply. The call " +
        "waits until the user answers, however long that takes, then returns the answer text. If the call is dropped " +
        "before an answer, the question stays open: the user's next message answers it and resumes this task. " +
        "Set attachScreenshot to show the user the current desktop with the question (it must be running; see desktop_open).",
      inputSchema: {
        question: z.string().min(1).describe("The question to ask the user"),
        options: z
          .array(z.string().min(1).max(MAX_OPTION_CHARS))
          .min(1)
          .max(MAX_OPTIONS)
          .optional()
          .describe(`Up to ${MAX_OPTIONS} short answers the user can pick, each at most ${MAX_OPTION_CHARS} characters`),
        attachScreenshot: z.boolean().optional().describe("Attach a PNG screenshot of the task desktop to the question"),
      },
    },
    ({
      question,
      options,
      attachScreenshot,
    }: {
      question: string
      options?: string[]
      attachScreenshot?: boolean
    }, extra: RequestHandlerExtra<ServerRequest, ServerNotification>) =>
      guard(() =>
        runTool(
          Effect.gen(function* () {
            const attachments = yield* screenshotIfAsked(deps, ctx.taskId, attachScreenshot === true)
            const answer = yield* deps.ask(ctx.taskId, ctx.runId, { question, options: options ?? [], attachments }).pipe(
              Effect.raceFirst(pingWhileWaiting(extra)),
              Effect.raceFirst(abandonedCall(extra)),
            )
            return text(answer)
          }),
        ),
      ),
  )

  server.registerTool(
    "task_inbox",
    {
      description:
        "Read the messages the user sent you while this run is going, and mark them read. Each message is returned " +
        "once. Check it between steps of a long task, and whenever the user may have changed their mind.",
    },
    () =>
      guard(() =>
        runTool(
          Effect.gen(function* () {
            const messages = yield* deps.inbox(ctx.taskId, ctx.runId)
            if (messages.length === 0) return text("No new messages from the user.")
            return text(messages.map((m) => m.text).join("\n\n"))
          }),
        ),
      ),
  )
}
