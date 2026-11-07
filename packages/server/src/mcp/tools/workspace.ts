import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { Effect, Schema } from "effect"
import { CheckoutRequest, type Checkout, type ThreadPullRequest } from "@cloudagents/protocol"
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
    readonly checkout: (
      taskId: string,
      request: CheckoutRequest,
    ) => Effect.Effect<
      { readonly checkout: Checkout; readonly pullRequest?: ThreadPullRequest; readonly path: string; readonly instructionFiles: ReadonlyArray<string>; readonly note: string | null },
      unknown
    >
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
    "repo_checkout",
    {
      description:
        "Check a GitHub repository out into this thread's workspace, on a new branch forked from `baseBranch` (default: " +
        "the repository's default branch). With `pullRequest`, the checkout takes over that pull request: it is on the " +
        "pull request's own branch at its head, git_push updates the pull request, and the pull request tools and " +
        "github_pr_watch work without opening one. A pull request from a fork or one that is not open starts a new branch " +
        "instead, and the result says so. The checkout is a directory under the workspace root; the result names its path " +
        "and checkout id. Asking for a repository the thread already has returns that checkout; naming its pull request " +
        "again fetches the latest head and the result gives the commit to merge. `repo` is `owner/name` on github.com, " +
        "otherwise an https clone URL. Later runs of the thread start in its first checkout.",
      inputSchema: {
        repo: z.string().describe("`owner/name` on github.com, or an https clone URL"),
        baseBranch: z.string().optional().describe("Branch to fork from; default: the repository's default branch"),
        pullRequest: z
          .number()
          .int()
          .positive()
          .optional()
          .describe("Pull request number to take over, instead of forking a new branch"),
      },
    },
    ({ repo, baseBranch, pullRequest }: { repo: string; baseBranch?: string; pullRequest?: number }) =>
      guard(() =>
        runTool(
          Effect.gen(function* () {
            const request = yield* Schema.decodeUnknown(CheckoutRequest)({ repo, baseBranch, pullRequest }).pipe(
              Effect.mapError((e) => new Error(`invalid repo_checkout arguments: ${e.message}`)),
            )
            const { checkout, pullRequest: linkedPullRequest, path, instructionFiles, note } = yield* deps.workspace.checkout(ctx.taskId, request)
            const linked = linkedPullRequest === undefined ? "" : `, pull request #${linkedPullRequest.number}`
            return text(
              `checked out ${checkout.repo} at ${path} (checkout id ${checkout.id}, branch ${checkout.branch}, base ${checkout.baseBranch}${linked})` +
                (note === null ? "" : `\n${note}`) +
                (instructionFiles.length === 0 ? "" : `\nRead ${instructionFiles.join(" and ")} before working in it.`),
            )
          }),
        ),
      ),
  )

  server.registerTool(
    "workspace_exec",
    {
      description:
        "Run a shell command with sh -c in the thread's workspace root (repo_checkout puts repositories under it). Use this only " +
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
        command: z.string().describe("Shell command, run with sh -c in the workspace root"),
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
