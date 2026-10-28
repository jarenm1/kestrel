import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { Effect } from "effect"
import { z } from "zod"
import type { NewReview, PostedReview, PullRequest, PullRequestStatus } from "../../github/api"
import { type RunContext, guard, runTool, text, truncate } from "./common"

export interface GitHubToolDeps {
  readonly github: {
    readonly push: (taskId: string) => Effect.Effect<string, unknown>
    readonly openPullRequest: (
      taskId: string,
      input: { readonly title: string; readonly body: string; readonly draft: boolean },
    ) => Effect.Effect<{ readonly pullRequest: PullRequest; readonly created: boolean }, unknown>
    readonly pullRequestStatus: (taskId: string) => Effect.Effect<PullRequestStatus, unknown>
    readonly reviewPullRequest: (
      taskId: string,
      input: NewReview & { readonly number: number },
    ) => Effect.Effect<PostedReview, unknown>
  }
}

const formatStatus = (pr: PullRequestStatus): string => {
  const { checks } = pr
  const mergeable =
    pr.mergeable === null ? "unknown (GitHub is still computing; retry shortly)" : pr.mergeable ? "yes" : `no (${pr.mergeableState})`
  const lines = [
    `pull request #${pr.number}: ${pr.title}`,
    `url: ${pr.url}`,
    `state: ${pr.state}${pr.draft ? " (draft)" : ""}`,
    `head: ${pr.headSha}`,
    `mergeable: ${mergeable}`,
    `review: ${pr.reviewDecision}`,
    `checks: ${checks.passed}/${checks.total} passed` +
      (checks.failing.length > 0 ? `; failing: ${checks.failing.join(", ")}` : "") +
      (checks.pending.length > 0 ? `; pending: ${checks.pending.join(", ")}` : ""),
  ]
  if (pr.reviewComments.length > 0) {
    lines.push("recent review comments (newest first):")
    for (const c of pr.reviewComments) {
      lines.push(`- ${c.path}${c.line === null ? "" : `:${c.line}`} (${c.author}): ${c.body}`)
    }
  }
  return lines.join("\n")
}

export const registerGitHubTools = (server: McpServer, ctx: RunContext, deps: GitHubToolDeps): void => {
  server.registerTool(
    "git_push",
    {
      description:
        "Push this task's branch to its GitHub remote so it can be reviewed. Commit your work first: uncommitted " +
        "changes are not pushed. The base branch is never pushed and nothing is force-pushed.",
      inputSchema: {},
    },
    () =>
      guard(() =>
        runTool(
          Effect.gen(function* () {
            const branch = yield* deps.github.push(ctx.taskId)
            return text(`pushed ${branch}`)
          }),
        ),
      ),
  )

  server.registerTool(
    "github_pr_create",
    {
      description:
        "Open a GitHub pull request from this task's branch into its base branch. Pushes the branch first (commit " +
        "your work before calling this). If a pull request is already open for the branch, returns that one instead.",
      inputSchema: {
        title: z.string().describe("Pull request title"),
        body: z.string().optional().describe("Pull request description"),
        draft: z.boolean().optional().describe("Open as a draft (default false)"),
      },
    },
    ({ title, body, draft }: { title: string; body?: string; draft?: boolean }) =>
      guard(() =>
        runTool(
          Effect.gen(function* () {
            const { pullRequest, created } = yield* deps.github.openPullRequest(ctx.taskId, {
              title,
              body: body ?? "",
              draft: draft ?? false,
            })
            const verb = created ? "opened" : "already open:"
            return text(`${verb} pull request #${pullRequest.number}: ${pullRequest.url}`)
          }),
        ),
      ),
  )

  server.registerTool(
    "github_pr_status",
    {
      description:
        "Show the live GitHub status of this task's pull request: mergeability, review decision, check results and " +
        "recent review comments. Requires a pull request opened with github_pr_create.",
      inputSchema: {},
    },
    () =>
      guard(() =>
        runTool(
          Effect.gen(function* () {
            const status = yield* deps.github.pullRequestStatus(ctx.taskId)
            return text(truncate(formatStatus(status)))
          }),
        ),
      ),
  )

  server.registerTool(
    "github_pr_review",
    {
      description:
        "Post a review on a pull request of this task's GitHub repository, as the repository owner. event is COMMENT " +
        "(default) or REQUEST_CHANGES; approval is not offered. Line comments go on the pull request's diff: give the " +
        "file path, the line, and side (RIGHT for the new code, the default; LEFT for the old code).",
      inputSchema: {
        number: z.number().int().positive().describe("Pull request number in this task's repository"),
        body: z.string().describe("Review summary"),
        event: z.enum(["COMMENT", "REQUEST_CHANGES"]).optional().describe("Review event (default COMMENT)"),
        comments: z
          .array(
            z.object({
              path: z.string().describe("File path in the pull request"),
              line: z.number().int().positive().describe("Line the comment applies to"),
              side: z.enum(["LEFT", "RIGHT"]).optional().describe("Diff side (default RIGHT)"),
              body: z.string().describe("Comment text"),
            }),
          )
          .optional()
          .describe("Line comments on the diff"),
      },
    },
    ({
      number,
      body,
      event,
      comments,
    }: {
      number: number
      body: string
      event?: "COMMENT" | "REQUEST_CHANGES"
      comments?: ReadonlyArray<{ path: string; line: number; side?: "LEFT" | "RIGHT"; body: string }>
    }) =>
      guard(() =>
        runTool(
          Effect.gen(function* () {
            const review = yield* deps.github.reviewPullRequest(ctx.taskId, {
              number,
              body,
              event: event ?? "COMMENT",
              comments: comments ?? [],
            })
            return text(`posted review on pull request #${number}: ${review.url}`)
          }),
        ),
      ),
  )
}
