import type { TaskStatus } from "@cloudagents/protocol"
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { Effect } from "effect"
import { z } from "zod"
import { type RunContext, guard, runTool, text } from "./common"

export interface TaskToolDeps {
  readonly report: (
    taskId: string,
    runId: string,
    input: { status: TaskStatus; message: string },
  ) => Effect.Effect<void, unknown>
}

export const registerTaskTools = (server: McpServer, ctx: RunContext, deps: TaskToolDeps): void => {
  server.registerTool(
    "task_report",
    {
      description:
        "Report the task's state to the user. Use 'working' while making progress, 'needs_input' when you need " +
        "an answer from the user, 'done' when the work is complete, or 'failed' if you cannot complete it.",
      inputSchema: {
        status: z.enum(["working", "needs_input", "done", "failed"]).describe("Current task state"),
        message: z.string().describe("Short message for the user"),
      },
    },
    ({ status, message }: { status: "working" | "needs_input" | "done" | "failed"; message: string }) =>
      guard(() =>
        runTool(
          Effect.gen(function* () {
            const mapped: TaskStatus = status === "working" ? "running" : status
            yield* deps.report(ctx.taskId, ctx.runId, { status: mapped, message })
            return text(`reported ${mapped}`)
          }),
        ),
      ),
  )
}
