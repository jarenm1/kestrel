import { CheckoutRequest, type CreateTaskBody, type Message, type ModelCatalog, type SendMessageResponse, type Task } from "@cloudagents/protocol"
import { randomUUID } from "node:crypto"
import Ajv from "ajv"
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { Effect, Schema } from "effect"
import { z } from "zod"
import type { DelegateInput, DelegatedStatus } from "../../core/service"
import { type RunContext, agentModelInput, describeError, guard, runTool, text, truncate } from "./common"

const DEFAULT_READ_LIMIT = 20
const MAX_READ_LIMIT = 100
const outputValidator = new Ajv({ strict: false, allErrors: true, addUsedSchema: false })
const outputSchema = z.record(z.string(), z.unknown()).refine((schema) => {
  try { return JSON.stringify(schema).length <= 16000 && Boolean(outputValidator.compile(schema)) } catch { return false }
}, "Must be a valid JSON Schema of at most 16000 characters")

export interface ThreadToolDeps {
  readonly models: {
    readonly list: (user: string) => Effect.Effect<ModelCatalog, unknown>
  }
  readonly threads: {
    readonly maxConcurrentRuns: number
    /** The user a thread belongs to: the tools reach that user's threads only. */
    readonly owner: (taskId: string) => Effect.Effect<string, unknown>
    readonly create: (user: string, input: CreateTaskBody, delegation?: undefined, spawnedByTaskId?: string) => Effect.Effect<Task, unknown>
    readonly archive: (user: string, taskId: string) => Effect.Effect<Task, unknown>
    readonly list: (user: string) => Effect.Effect<ReadonlyArray<Task>, unknown>
    readonly messages: (user: string, taskId: string) => Effect.Effect<ReadonlyArray<Message>, unknown>
    readonly send: (fromTaskId: string, toTaskId: string, text: string) => Effect.Effect<SendMessageResponse, unknown>
    readonly delegate: (taskId: string, runId: string, input: DelegateInput) => Effect.Effect<Task, unknown>
    readonly delegatedStatus: (taskId: string, childId: string) => Effect.Effect<DelegatedStatus, unknown>
    readonly cancelDelegation: (taskId: string, childId: string) => Effect.Effect<DelegatedStatus, unknown>
    readonly acknowledgeDelegation: (taskId: string, childId: string) => Effect.Effect<boolean, unknown>
    readonly withSlotReleased: <A, E>(taskId: string, runId: string, wait: Effect.Effect<A, E>) => Effect.Effect<A, E>
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

const formatDelegation = (status: DelegatedStatus): string => {
  const run = status.run
  return [`thread ${status.task.id} "${status.task.title}"`, `run: ${run?.id ?? "not started"}`, `status: ${status.task.delegation?.cancelledAt ? "cancelled" : status.resultStatus ?? (status.task.status === "failed" ? "failed to start" : "starting")}`,
    ...(status.waitingForChildren ? ["work state: waiting for delegated children"] : []),
    ...(status.usageLimit === null ? [] : [`work state: stopped by a provider usage limit; ${status.usageLimit.resetsAt === null ? "checking when it resets" : `resumes automatically at ${status.usageLimit.resetsAt}`}. Its result arrives after it resumes, unless the user returns it early.`]),
    ...(status.usage.inputTokens === null && status.usage.outputTokens === null && status.usage.costUsd === null ? [] : [`usage: input tokens ${status.usage.inputTokens ?? "unknown"}, output tokens ${status.usage.outputTokens ?? "unknown"}, cost USD ${status.usage.costUsd ?? "unknown"}`]),
    ...(status.structured === null ? [] : [`structured output: ${status.structured.valid ? "valid" : `invalid (${status.structured.error ?? "schema validation failed"})`}`]),
    ...(status.task.status === "needs_input" ? ["The child needs user input; open its thread."] : []),
    ...(status.result === null ? [] : [`result:\n${truncate(status.result)}`])].join("\n")
}

export const registerThreadTools = (server: McpServer, ctx: RunContext, deps: ThreadToolDeps): void => {
  server.registerTool("delegation_capabilities", {
    description: "Show delegation limits and accepted models. Model names are supported by Kestrel but may require the user's provider credentials.",
    inputSchema: {},
  }, () => guard(() => runTool(Effect.gen(function* () {
    const user = yield* deps.threads.owner(ctx.taskId)
    const catalog = yield* deps.models.list(user)
    return text(`Models: ${catalog.models.map((model) => model.id).join(", ")}\nConcurrent runs on this box: ${deps.threads.maxConcurrentRuns === 0 ? "unlimited" : deps.threads.maxConcurrentRuns}\nMaximum delegation depth: 4\nMaximum batch size: 10\nMaximum wait: 30 seconds\nModel credentials are checked when the child starts.`)
  }))))
  server.registerTool("delegate_task", {
    description: "Start durable delegated work in a separate Kestrel thread and workspace. Supply all context needed; conversation and files are not inherited. The result is automatically delivered when the original run ends. A requestId names one task for this whole thread: reuse it on retries, including from a later run, to get the existing child instead of a duplicate. A child needing input must be answered by the user in its thread.",
    inputSchema: {
      title: z.string().trim().min(1).describe("Short title for the delegated task"),
      message: z.string().trim().min(1).describe("Complete task and context for the child"),
      role: z.enum(["general", "implementation", "research", "review", "design", "test"]).optional().describe("Optional role guidance for the child"),
      requestId: z.string().trim().min(1).max(200).optional().describe("Stable key for this request, unique within this thread; reuse on retries"),
      model: agentModelInput.optional().describe("Model for the child; omitted inherits the parent's model when known"),
      outputSchema: outputSchema.optional().describe("Optional JSON Schema for the child's final response; validation is reported with the result"),
      repo: z.string().optional().describe("Repository to check out in the child workspace"),
      baseBranch: z.string().optional().describe("Branch to fork from; requires repo"),
      pullRequest: z.number().int().positive().optional().describe("Pull request to check out; requires repo"),
    },
  }, ({ title, message, role, requestId, model, outputSchema, repo, baseBranch, pullRequest }) => guard(() => runTool(Effect.gen(function* () {
    if (repo === undefined && (baseBranch !== undefined || pullRequest !== undefined)) return yield* Effect.fail(new Error("baseBranch and pullRequest require repo"))
    const checkout = repo === undefined ? undefined : yield* Schema.decodeUnknown(CheckoutRequest)({ repo, baseBranch, pullRequest }).pipe(
      Effect.mapError((e) => new Error(`invalid checkout arguments: ${e.message}`)),
    )
    const task = yield* deps.threads.delegate(ctx.taskId, ctx.runId, { title, message: role === undefined ? message : `Role: ${role}\n\n${message}`, requestId: requestId ?? randomUUID(), ...(model === undefined ? {} : { model }), ...(outputSchema === undefined ? {} : { outputSchema }), ...(checkout === undefined ? {} : { checkout }) })
    return text(formatDelegation(yield* deps.threads.delegatedStatus(ctx.taskId, task.id)))
  }))))

  server.registerTool("delegate_batch", {
    description: "Delegate up to 10 tasks with shared context. Provide a stable requestId for safe retries. All arguments are validated before dispatch; if a later checkout or launch fails, earlier children remain running and a retry with the same requestId (from this run or a later one) resumes the batch.",
    inputSchema: {
      requestId: z.string().trim().min(1).max(160).describe("Stable batch key, unique within this thread; reuse on retry"),
      context: z.string().trim().min(1).describe("Background shared with every child"),
      tasks: z.array(z.object({
        title: z.string().trim().min(1),
        message: z.string().trim().min(1),
        role: z.enum(["general", "implementation", "research", "review", "design", "test"]).optional(),
        model: agentModelInput.optional(),
        outputSchema: outputSchema.optional(),
        repo: z.string().optional(),
        baseBranch: z.string().optional(),
        pullRequest: z.number().int().positive().optional(),
      })).min(1).max(10),
    },
  }, ({ requestId, context, tasks }) => guard(() => runTool(Effect.gen(function* () {
    const inputs = yield* Effect.forEach(tasks, (item, index) => Effect.gen(function* () {
      if (item.repo === undefined && (item.baseBranch !== undefined || item.pullRequest !== undefined)) return yield* Effect.fail(new Error(`task ${index + 1}: baseBranch and pullRequest require repo`))
      const checkout = item.repo === undefined ? undefined : yield* Schema.decodeUnknown(CheckoutRequest)({ repo: item.repo, baseBranch: item.baseBranch, pullRequest: item.pullRequest }).pipe(
        Effect.mapError((e) => new Error(`task ${index + 1}: invalid checkout: ${e.message}`)),
      )
      return { title: item.title, message: `${item.role === undefined ? "" : `Role: ${item.role}\n\n`}Shared context:\n${context}\n\nTask:\n${item.message}`, requestId: `batch:${requestId}:${index}`, ...(item.model === undefined ? {} : { model: item.model }), ...(item.outputSchema === undefined ? {} : { outputSchema: item.outputSchema }), ...(checkout === undefined ? {} : { checkout }) }
    }))
    const results: string[] = []
    for (const [index, input] of inputs.entries()) {
      const task = yield* deps.threads.delegate(ctx.taskId, ctx.runId, input).pipe(Effect.mapError((e) => new Error(`Batch stopped at task ${index + 1}; started thread IDs: ${results.join(", ") || "none"}. Retry the same batch requestId. ${describeError(e)}`)))
      results.push(task.id)
    }
    return text(`Delegated threads:\n${results.map((id, index) => `${index + 1}. ${id}`).join("\n")}`)
  }))))

  server.registerTool("delegation_status", {
    description: "Read the original run status and final result of work delegated by this thread. Results remain available after follow-up messages.",
    inputSchema: { threadId: z.string().min(1).describe("Child thread id returned by delegate_task") },
  }, ({ threadId }) => guard(() => runTool(Effect.map(deps.threads.delegatedStatus(ctx.taskId, threadId), (status) => text(formatDelegation(status))))))

  server.registerTool("delegation_wait", {
    description: "Wait for a delegated task to finish or need user input. While blocked, this run lends its execution slot to queued work and reacquires it before returning. Timeout leaves the child running; reacquiring a busy slot may delay the return beyond the timeout. Completion is also delivered automatically.",
    inputSchema: { threadId: z.string().min(1), timeoutSec: z.number().int().min(1).max(30).optional().describe("Maximum wait in seconds (default 30)") },
  }, ({ threadId, timeoutSec }) => guard(() => runTool(Effect.gen(function* () {
    const outcome = yield* deps.threads.withSlotReleased(ctx.taskId, ctx.runId, Effect.gen(function* () {
    const deadline = Date.now() + (timeoutSec ?? 30) * 1000
    while (true) {
      const status = yield* deps.threads.delegatedStatus(ctx.taskId, threadId)
      if (status.task.status === "needs_input" && !status.task.delegation?.cancelledAt) return { status, finished: false, timedOut: false }
      const finished = status.task.delegation?.cancelledAt || (status.run !== null && status.run.status !== "running" && !status.waitingForChildren && status.usageLimit === null) || (status.run === null && status.task.status === "failed")
      if (finished) return { status, finished: true, timedOut: false }
      if (Date.now() >= deadline) return { status, finished: false, timedOut: true }
      yield* Effect.sleep("1 second")
    }
    }))
    // Reacquiring capacity can block or be interrupted. Keep automatic delivery
    // recoverable until the parent can receive the tool result.
    if (outcome.finished) {
      const claimed = yield* deps.threads.acknowledgeDelegation(ctx.taskId, threadId)
      return text(claimed ? formatDelegation(outcome.status) : `${formatDelegation({ ...outcome.status, result: null })}\nResult was already delivered or acknowledged; use delegation_status to read it again.`)
    }
    return text(`${formatDelegation(outcome.status)}${outcome.timedOut ? "\nWait timed out; the task continues." : ""}`)
  }))))

  server.registerTool("delegation_cancel", {
    description: "Cancel the original run of a task delegated by this thread. The child thread and its history remain available.",
    inputSchema: { threadId: z.string().min(1) },
  }, ({ threadId }) => guard(() => runTool(Effect.map(deps.threads.cancelDelegation(ctx.taskId, threadId), (status) => text(formatDelegation(status))))))

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
        const task = yield* deps.threads.create(owner, { title, ...(checkout === undefined ? {} : { checkout }) }, undefined, ctx.taskId)
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
        "moves the thread and the threads it spawned or delegated to the archive, stops the current run and desktop, " +
        "and preserves their history and files; the user can unarchive each of them later. The call may end the run before it returns.",
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
