import type { Message, SendMessageResponse, Task } from "@cloudagents/protocol"
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { Effect } from "effect"
import { z } from "zod"
import { type RunContext, guard, runTool, text, truncate } from "./common"

const DEFAULT_READ_LIMIT = 20
const MAX_READ_LIMIT = 100

export interface ThreadToolDeps {
  readonly threads: {
    /** The user a thread belongs to: the tools reach that user's threads only. */
    readonly owner: (taskId: string) => Effect.Effect<string, unknown>
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
