import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { Effect } from "effect"
import { z } from "zod"
import { type RunContext, guard, runTool, text } from "./common"

const DEFAULT_TIMEOUT_SEC = 120
const MAX_TIMEOUT_SEC = 600

/** A stream as the core captured it: its first and last bytes, and the bytes dropped between them. */
interface ExecOutput {
  readonly head: string
  readonly tail: string
  readonly omittedBytes: number
}

export interface WorkspaceToolDeps {
  readonly workspace: {
    readonly exec: (
      taskId: string,
      command: string,
      timeoutMs: number,
    ) => Effect.Effect<{ exitCode: number; timedOut: boolean; stdout: ExecOutput; stderr: ExecOutput }, unknown>
  }
}

/** Head, then a marker for the dropped middle, then the tail: errors usually end up at the end. */
const formatStream = (out: ExecOutput): string =>
  out.omittedBytes === 0 ? out.head + out.tail : `${out.head}\n[... ${out.omittedBytes} bytes omitted ...]\n${out.tail}`

export const registerWorkspaceTools = (server: McpServer, ctx: RunContext, deps: WorkspaceToolDeps): void => {
  server.registerTool(
    "workspace_exec",
    {
      description:
        "Run a shell command with sh -c in the task's git worktree (the agent's working directory). Use this only " +
        "when the command needs the task's desktop DISPLAY, or when your harness has no shell of its own; if you " +
        "have a shell, use that instead. Returns the exit code, stdout and stderr; a non-zero exit code is reported " +
        "in the output, not as a tool error. Each stream keeps its first and last 10000 bytes; the middle is " +
        "replaced by a `[... N bytes omitted ...]` marker. The command is killed with its whole process group " +
        `after timeoutSec (default ${DEFAULT_TIMEOUT_SEC}, max ${MAX_TIMEOUT_SEC}); the output printed so far is ` +
        "returned with a `timed out after Ns (process group killed)` line. The call returns as soon as the main " +
        "process exits, so `sleep 30 & echo started` returns at once. To start a long-lived process, redirect its " +
        "output and background it: `nohup cmd >log 2>&1 &`. Output a backgrounded process writes after the call " +
        "returns goes to closed pipes and is lost (it gets SIGPIPE).",
      inputSchema: {
        command: z.string().describe("Shell command, run with sh -c in the worktree"),
        timeoutSec: z
          .number()
          .positive()
          .max(MAX_TIMEOUT_SEC)
          .optional()
          .describe(`Timeout in seconds, default ${DEFAULT_TIMEOUT_SEC}, at most ${MAX_TIMEOUT_SEC}`),
      },
    },
    ({ command, timeoutSec }: { command: string; timeoutSec?: number }) =>
      guard(() =>
        runTool(
          Effect.gen(function* () {
            const timeoutMs = Math.round((timeoutSec ?? DEFAULT_TIMEOUT_SEC) * 1000)
            const result = yield* deps.workspace.exec(ctx.taskId, command, timeoutMs)
            const status = result.timedOut
              ? `timed out after ${timeoutMs / 1000}s (process group killed)\nexit code: none`
              : `exit code: ${result.exitCode}`
            return text(
              `${status}\n--- stdout ---\n${formatStream(result.stdout)}\n--- stderr ---\n${formatStream(result.stderr)}`,
            )
          }),
        ),
      ),
  )
}
