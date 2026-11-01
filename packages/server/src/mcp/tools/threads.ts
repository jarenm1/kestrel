import { CheckoutRequest, type CreateTaskBody, type Message, type SendMessageResponse, type Task } from "@cloudagents/protocol"
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { Effect, Schema } from "effect"
import { z } from "zod"
import { type RunContext, describeError, guard, runTool, text, truncate } from "./common"

const DEFAULT_READ_LIMIT = 20
const MAX_READ_LIMIT = 100

export interface ThreadToolDeps {
  readonly threads: {
    /** The user a thread belongs to: the tools reach that user's threads only. */
    readonly owner: (taskId: string) => Effect.Effect<string, unknown>
    readonly create: (user: string, input: CreateTaskBody) => Effect.Effect<Task, unknown>
    readonly archive: (user: string, taskId: string) => Effect.Effect<Task, unknown>
    readonly list: (user: string) => Effect.Effect<ReadonlyArray<Task>, unknown>
    readonly messages: (user: string, taskId: string) => Effect.Effect<ReadonlyArray<Message>, unknown>
    readonly send: (fromTaskId: string, toTaskId: string, text: string) => Effect.Effect<SendMessageResponse, unknown>
  }
}

const formatThread = (task: Task): string => {
  const repos = task.checkouts.map((c) => c.repo)
  return [
    `${task.id} "${task.title}" (${task.status}, updated ${task.updatedAt})`,
    `  repos: ${repos.length === 0 ? "none" : repos.join(", ")}`,
  ].join("\n")
}

const formatMessage = (message: Message): string => {
  const from = message.fromThread
  const sender =
    message.role === "agent"
      ? "Agent"
      : message.role === "system"
        ? "System"
        : from === undefined
          ? "User"
          : `Agent of thread "${from.title}" (${from.id})`
  return `[${message.createdAt}] ${sender}:\n${message.text}`
}

export const registerThreadTools = (server: McpServer, ctx: RunContext, deps: ThreadToolDeps): void => {
  server.registerTool(
    "thread_spawn",
    {
      description:
        "Create a new thread for the user and start its agent on a task. The new thread has its own workspace and " +
        "conversation; it does not inherit this thread's files or conversation. Include all context it needs in the " +
        "message and say whether to reply using thread_send. Optionally check out a repository before starting. " +
        "Returns the thread and run ids; use thread_read and thread_send to follow up.",
      inputSchema: {
        title: z.string().trim().min(1).describe("Short title for the new thread"),
        message: z.string().trim().min(1).describe("Task and context for the new agent"),
        repo: z.string().optional().describe("Repository to check out: GitHub owner/name or HTTPS clone URL"),
        baseBranch: z.string().optional().describe("Branch to fork from; requires repo"),
        pullRequest: z.number().int().positive().optional().describe("Pull request to check out; requires repo"),
      },
    },
    ({ title, message, repo, baseBranch, pullRequest }: { title: string; message: string; repo?: string; baseBranch?: string; pullRequest?: number }) =>
      guard(() => runTool(Effect.gen(function* () {
        if (repo === undefined && (baseBranch !== undefined || pullRequest !== undefined)) {
          return yield* Effect.fail(new Error("baseBranch and pullRequest require repo"))
        }
        const checkout = repo === undefined ? undefined : yield* Schema.decodeUnknown(CheckoutRequest)({ repo, baseBranch, pullRequest }).pipe(
          Effect.mapError((e) => new Error(`invalid checkout arguments: ${e.message}`)),
        )
        const owner = yield* deps.threads.owner(ctx.taskId)
        const task = yield* deps.threads.create(owner, { title, ...(checkout === undefined ? {} : { checkout }) })
        const sent = yield* deps.threads.send(ctx.taskId, task.id, message).pipe(
          Effect.mapError((e) => new Error(`Created thread ${task.id}, but could not start its agent: ${describeError(e)}. Inspect the thread before retrying.`)),
        )
        return text(`created thread ${task.id} "${task.title}" (run ${sent.run.id})`)
      }))),
  )

  server.registerTool(
    "thread_close",
    {
      description:
        "Archive this thread when its work is finished and the user does not need to read the final response or take " +
        "any action. This is useful for automation runs with nothing to report, such as a scheduled check that found " +
        "no issues. Do not close when the user needs a result, review, decision, follow-up, or explanation of a failure; " +
        "leave the thread active so they can see it. Call only as the final action after all work is complete. Closing " +
        "moves the thread to the archive, stops the current run and desktop, and preserves its history and files; " +
        "the user can unarchive it later. The call may end the run before it returns.",
      inputSchema: {},
    },
    () =>
      guard(() =>
        runTool(
          Effect.gen(function* () {
            const owner = yield* deps.threads.owner(ctx.taskId)
            yield* deps.threads.archive(owner, ctx.taskId)
            return text("Thread archived.")
          }),
        ),
      ),
  )

  server.registerTool(
    "thread_list",
    {
      description:
        "List the user's other threads, each run by its own agent: id, title, status, last update and checked-out " +
        "repositories. Archived threads are left out; they take no messages. Use the ids with thread_read and thread_send.",
      inputSchema: {},
    },
    () =>
      guard(() =>
        runTool(
          Effect.gen(function* () {
            const owner = yield* deps.threads.owner(ctx.taskId)
            const others = (yield* deps.threads.list(owner)).filter(
              (t) => t.id !== ctx.taskId && t.archivedAt === undefined,
            )
            if (others.length === 0) return text("The user has no other threads.")
            return text(truncate(others.map(formatThread).join("\n")))
          }),
        ),
      ),
  )

  server.registerTool(
    "thread_read",
    {
      description:
        "Read the latest messages of another of the user's threads, oldest first: what its user and agent said, and " +
        "messages other agents sent it. Use it to learn what another agent is doing or has found before messaging it.",
      inputSchema: {
        threadId: z.string().min(1).describe("Id of the thread, from thread_list"),
        limit: z
          .number()
          .int()
          .min(1)
          .max(MAX_READ_LIMIT)
          .optional()
          .describe(`How many of the latest messages to return (default ${DEFAULT_READ_LIMIT})`),
      },
    },
    ({ threadId, limit }: { threadId: string; limit?: number }) =>
      guard(() =>
        runTool(
          Effect.gen(function* () {
            const owner = yield* deps.threads.owner(ctx.taskId)
            const messages = yield* deps.threads.messages(owner, threadId)
            const latest = [...messages]
              .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
              .slice(-(limit ?? DEFAULT_READ_LIMIT))
            if (latest.length === 0) return text("The thread has no messages yet.")
            return text(truncate(latest.map(formatMessage).join("\n\n")))
          }),
        ),
      ),
  )

  server.registerTool(
    "thread_send",
    {
      description:
        "Send a message to the agent of another of the user's threads. If that agent is working, the message waits " +
        "in its task_inbox; otherwise it starts the agent on the message, continuing that thread's conversation. The " +
        "message appears in that thread's chat as coming from this thread, and the agent is told how to answer. Its " +
        "answer reaches you the same way: in task_inbox while this run is going, or as a new message that starts " +
        "this thread again once it has ended. It never answers a question the thread asked its user. Say what you " +
        "need and whether you expect an answer; do not send acknowledgements or thanks.",
      inputSchema: {
        threadId: z.string().min(1).describe("Id of the thread to message, from thread_list"),
        message: z.string().min(1).describe("The message for that thread's agent"),
      },
    },
    ({ threadId, message }: { threadId: string; message: string }) =>
      guard(() =>
        runTool(
          Effect.gen(function* () {
            const sent = yield* deps.threads.send(ctx.taskId, threadId, message)
            return text(`sent message ${sent.message.id} to thread ${threadId} (its run ${sent.run.id})`)
          }),
        ),
      ),
  )
}
