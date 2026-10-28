import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { Effect } from "effect"
import { z } from "zod"
import { type RunContext, guard, runTool, text, truncate } from "./common"

export interface WorkspaceToolDeps {
  readonly workspace: {
    readonly exec: (
      taskId: string,
      command: string,
      timeoutMs: number,
    ) => Effect.Effect<{ exitCode: number; stdout: string; stderr: string }, unknown>
  }
}

export const registerWorkspaceTools = (server: McpServer, ctx: RunContext, deps: WorkspaceToolDeps): void => {
  server.registerTool(
    "workspace_exec",
    {
      description:
        "Run a shell command in the task's git worktree (the agent's working directory). Returns the exit code, " +
        "stdout and stderr (each truncated to 20000 characters). A non-zero exit code is reported in the output, " +
        "not as a tool error.",
      inputSchema: {
        command: z.string().describe("Shell command, run with sh -c in the worktree"),
        timeoutSec: z.number().positive().optional().describe("Timeout in seconds, default 120"),
      },
    },
    ({ command, timeoutSec }: { command: string; timeoutSec?: number }) =>
      guard(() =>
        runTool(
          Effect.gen(function* () {
            const timeoutMs = Math.round((timeoutSec ?? 120) * 1000)
            const result = yield* deps.workspace.exec(ctx.taskId, command, timeoutMs)
            return text(
              `exit code: ${result.exitCode}\n--- stdout ---\n${truncate(result.stdout)}\n` +
                `--- stderr ---\n${truncate(result.stderr)}`,
            )
          }),
        ),
      ),
  )
}
