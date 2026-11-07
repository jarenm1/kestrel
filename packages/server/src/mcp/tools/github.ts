import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { Effect } from "effect"
import { z } from "zod"
import type { LabelChange, PullRequestCommentInput, PullRequestTarget, ReviewerChange } from "../../core/service"
import type { NewReview, PostedComment, PostedReview, PullRequest, PullRequestChanges, PullRequestStatus, GitHubReference } from "../../github/api"
import { type RunContext, guard, runTool, text, truncate } from "./common"

export interface GitHubToolDeps {
  readonly github: {
    readonly push: (taskId: string, checkoutId?: string, branch?: string) => Effect.Effect<string, unknown>
    readonly openPullRequest: (
      taskId: string,
      input: { readonly title: string; readonly body: string; readonly draft: boolean; readonly checkoutId?: string; readonly branch?: string },
    ) => Effect.Effect<{ readonly pullRequest: PullRequest; readonly created: boolean }, unknown>
    readonly pullRequestStatus: (taskId: string, checkoutId?: string, number?: number) => Effect.Effect<PullRequestStatus, unknown>
    readonly readReference: (
      taskId: string,
      input: { readonly repo: string; readonly number: number; readonly kind: "pr" | "issue" },
    ) => Effect.Effect<GitHubReference, unknown>
    readonly reviewPullRequest: (
      taskId: string,
      input: NewReview & { readonly number: number; readonly checkoutId?: string },
    ) => Effect.Effect<PostedReview, unknown>
    readonly updatePullRequest: (taskId: string, input: PullRequestTarget & PullRequestChanges) => Effect.Effect<PullRequest, unknown>
    readonly commentOnPullRequest: (
      taskId: string,
      input: PullRequestTarget & PullRequestCommentInput,
    ) => Effect.Effect<PostedComment | null, unknown>
    readonly changeReviewers: (taskId: string, input: PullRequestTarget & ReviewerChange) => Effect.Effect<void, unknown>
    readonly changeLabels: (taskId: string, input: PullRequestTarget & LabelChange) => Effect.Effect<void, unknown>
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
  if (pr.conversation.length > 0) {
    lines.push("recent review and conversation comments:")
    for (const comment of pr.conversation) lines.push(`- ${comment.author}: ${comment.body} (${comment.url})`)
  }
  return lines.join("\n")
}

const formatReference = (reference: GitHubReference): string => {
  const lines = [
    `${reference.kind === "pr" ? "pull request" : "issue"} #${reference.number}: ${reference.title}`,
    `url: ${reference.url}`,
    `state: ${reference.state}${reference.kind === "pr" && reference.draft ? " (draft)" : ""}`,
    `author: ${reference.author}`,
    `created: ${reference.createdAt} (updated ${reference.updatedAt})`,
  ]
  if (reference.labels.length > 0) lines.push(`labels: ${reference.labels.join(", ")}`)
  if (reference.kind === "issue") {
    if (reference.stateReason !== null) lines.push(`state reason: ${reference.stateReason}`)
  } else {
    const mergeable =
      reference.mergeable === null
        ? "unknown (GitHub is still computing; retry shortly)"
        : reference.mergeable
          ? "yes"
          : `no (${reference.mergeableState})`
    const checksLine =
      reference.checks === null
        ? "checks: unavailable to the connected account"
        : `checks: ${reference.checks.passed}/${reference.checks.total} passed` +
          (reference.checks.failing.length > 0 ? `; failing: ${reference.checks.failing.join(", ")}` : "") +
          (reference.checks.pending.length > 0 ? `; pending: ${reference.checks.pending.join(", ")}` : "")
    lines.push(
      `branches: ${reference.headRef} -> ${reference.baseRef} (head ${reference.headSha})`,
      `mergeable: ${mergeable}`,
      `review: ${reference.reviewDecision}`,
      checksLine,
    )
  }
  lines.push("", "body:", reference.body.trim() === "" ? "(empty)" : reference.body)
  if (reference.kind === "pr") {
    if (reference.files.length > 0) {
      lines.push("", `changed files (${reference.files.length}):`)
      for (const file of reference.files) lines.push(`- ${file.path} (${file.status}, +${file.additions} -${file.deletions})`)
    }
    const reviews = reference.reviews.filter((review) => review.body.trim() !== "")
    if (reviews.length > 0) {
      lines.push("", "reviews:")
      for (const review of reviews) lines.push(`- ${review.author} (${review.state}): ${review.body}`)
    }
    if (reference.reviewComments.length > 0) {
      lines.push("", "review comments (newest first):")
      for (const comment of reference.reviewComments) {
        lines.push(`- ${comment.path}${comment.line === null ? "" : `:${comment.line}`} (${comment.author}): ${comment.body}`)
      }
    }
  }
  if (reference.conversation.length > 0) {
    lines.push("", "conversation:")
    for (const comment of reference.conversation) lines.push(`- ${comment.author}: ${comment.body} (${comment.url})`)
  }
  return lines.join("\n")
}

const checkoutArg = z.string().optional().describe("Checkout id from repo_checkout; needed when the thread has several checkouts")

const numberArg = z
  .number()
  .int()
  .positive()
  .optional()
  .describe("Pull request number in the checkout's repository; default: this checkout's pull request")

const rejected = (message: string) => Effect.fail(new Error(message))

/** Checks the flat tool arguments against the action they name, then builds the typed comment input. */
const commentInputOf = (args: {
  readonly action: "create" | "edit" | "delete"
  readonly body?: string
  readonly replyTo?: number
  readonly commentId?: number
  readonly kind?: "conversation" | "review"
}): Effect.Effect<PullRequestCommentInput, Error> => {
  const { body, replyTo, commentId, kind } = args
  const blank = body === undefined || body.trim() === ""
  if (args.action === "create") {
    if (blank) return rejected("a new comment needs body text")
    if (kind !== undefined || commentId !== undefined) return rejected("create takes body and optional replyTo; kind and commentId are for edit and delete")
    return Effect.succeed({ action: "create", body, replyTo })
  }
  if (commentId === undefined || kind === undefined) return rejected(`${args.action} needs commentId and kind`)
  if (replyTo !== undefined) return rejected("replyTo is only for create")
  if (args.action === "edit") {
    if (blank) return rejected("an edited comment needs body text")
    return Effect.succeed({ action: "edit", kind, commentId, body })
  }
  if (body !== undefined) return rejected("delete takes commentId and kind, not body")
  return Effect.succeed({ action: "delete", kind, commentId })
}

export const registerGitHubTools = (server: McpServer, ctx: RunContext, deps: GitHubToolDeps): void => {
  server.registerTool(
    "git_push",
    {
      description:
        "Push a checkout's branch to its GitHub remote so it can be reviewed. Commit your work first: uncommitted " +
        "changes are not pushed. Pass branch to push a local branch from a linked worktree. The base and default branches are never pushed and nothing is force-pushed.",
      inputSchema: { checkout: checkoutArg, branch: z.string().min(1).optional().describe("Local branch to push, including a linked worktree's branch; default: checkout branch") },
    },
    ({ checkout, branch }: { checkout?: string; branch?: string }) =>
      guard(() =>
        runTool(
          Effect.gen(function* () {
            const pushed = yield* deps.github.push(ctx.taskId, checkout, branch)
            return text(`pushed ${pushed}`)
          }),
        ),
      ),
  )

  server.registerTool(
    "github_pr_create",
    {
      description:
        "Open a GitHub pull request from a checkout's branch into its base branch. Pushes the branch first (commit " +
        "your work before calling this). Pass branch for a linked worktree's local branch; such a PR is not linked to the checkout. If a pull request is already open for the branch, returns that one instead.",
      inputSchema: {
        title: z.string().describe("Pull request title"),
        body: z.string().optional().describe("Pull request description"),
        draft: z.boolean().optional().describe("Open as a draft (default false)"),
        checkout: checkoutArg,
        branch: z.string().min(1).optional().describe("Local branch to push and open a pull request for; default: checkout branch"),
      },
    },
    ({ title, body, draft, checkout, branch }: { title: string; body?: string; draft?: boolean; checkout?: string; branch?: string }) =>
      guard(() =>
        runTool(
          Effect.gen(function* () {
            const { pullRequest, created } = yield* deps.github.openPullRequest(ctx.taskId, {
              title,
              body: body ?? "",
              draft: draft ?? false,
              checkoutId: checkout,
              branch,
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
        "Show the live GitHub status of a pull request this thread manages: mergeability, review decision, check results " +
        "and recent review comments. Defaults to the checkout's pull request; name `number` for a pull request the " +
        "thread registered, including one it watches in a repository it has not checked out. Requires a pull request " +
        "opened with github_pr_create, checked out with repo_checkout, or watched with github_pr_watch.",
      inputSchema: { checkout: checkoutArg, number: numberArg },
    },
    ({ checkout, number }: { checkout?: string; number?: number }) =>
      guard(() =>
        runTool(
          Effect.gen(function* () {
            const status = yield* deps.github.pullRequestStatus(ctx.taskId, checkout, number)
            return text(truncate(formatStatus(status)))
          }),
        ),
      ),
  )

  server.registerTool(
    "github_reference_read",
    {
      description:
        "Read an issue or pull request by explicit repository and number, without a checkout. repo is owner/name on " +
        "github.com. kind must match what the number really is: GitHub numbers issues and pull requests together, so " +
        "passing the wrong kind is an error rather than silent reinterpretation. Returns the current title, body, " +
        "state, author, URL and conversation; for a pull request also its branches, mergeability, review decision, " +
        "checks, changed files and review comments. Uses the connected GitHub account, so private references it can " +
        "see are readable.",
      inputSchema: {
        repo: z.string().min(1).describe("Repository as owner/name on github.com"),
        number: z
          .number()
          .int()
          .positive()
          .max(Number.MAX_SAFE_INTEGER)
          .describe("Issue or pull request number in that repository"),
        kind: z.enum(["pr", "issue"]).describe('"pr" for a pull request, "issue" for an issue; the actual kind must match'),
      },
    },
    ({ repo, number, kind }: { repo: string; number: number; kind: "pr" | "issue" }) =>
      guard(() =>
        runTool(
          Effect.gen(function* () {
            const reference = yield* deps.github.readReference(ctx.taskId, { repo, number, kind })
            return text(truncate(formatReference(reference)))
          }),
        ),
      ),
  )

  server.registerTool(
    "github_pr_review",
    {
      description:
        "Post a review on a pull request of a checkout's GitHub repository, as the repository owner. event is COMMENT " +
        "(default) or REQUEST_CHANGES; approval is not offered. Line comments go on the pull request's diff: give the " +
        "file path, the line, and side (RIGHT for the new code, the default; LEFT for the old code).",
      inputSchema: {
        checkout: checkoutArg,
        number: z.number().int().positive().describe("Pull request number in the checkout's repository"),
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
      checkout,
      body,
      event,
      comments,
    }: {
      number: number
      checkout?: string
      body: string
      event?: "COMMENT" | "REQUEST_CHANGES"
      comments?: ReadonlyArray<{ path: string; line: number; side?: "LEFT" | "RIGHT"; body: string }>
    }) =>
      guard(() =>
        runTool(
          Effect.gen(function* () {
            const review = yield* deps.github.reviewPullRequest(ctx.taskId, {
              number,
              checkoutId: checkout,
              body,
              event: event ?? "COMMENT",
              comments: comments ?? [],
            })
            return text(`posted review on pull request #${number}: ${review.url}`)
          }),
        ),
      ),
  )

  server.registerTool(
    "github_pr_update",
    {
      description:
        "Edit a pull request of a checkout's GitHub repository: title, description, base branch, open or close it, or " +
        "move it between draft and ready for review. Only the fields you pass change. Defaults to this checkout's pull request.",
      inputSchema: {
        checkout: checkoutArg,
        number: numberArg,
        title: z.string().optional().describe("New title"),
        body: z.string().optional().describe("New description; an empty string clears it"),
        base: z.string().min(1).optional().describe("Branch the pull request merges into"),
        state: z.enum(["open", "closed"]).optional().describe("Open or close the pull request"),
        draft: z.boolean().optional().describe("true to convert to a draft, false to mark ready for review"),
      },
    },
    ({
      checkout,
      number,
      title,
      body,
      base,
      state,
      draft,
    }: {
      checkout?: string
      number?: number
      title?: string
      body?: string
      base?: string
      state?: "open" | "closed"
      draft?: boolean
    }) =>
      guard(() =>
        runTool(
          Effect.gen(function* () {
            if ([title, body, base, state, draft].every((field) => field === undefined)) {
              return yield* rejected("github_pr_update needs at least one field to change")
            }
            if (title !== undefined && title.trim() === "") return yield* rejected("pull request title cannot be empty")
            const pr = yield* deps.github.updatePullRequest(ctx.taskId, { checkoutId: checkout, number, title, body, base, state, draft })
            return text(`updated pull request #${pr.number}: ${pr.url}\nstate: ${pr.state}${pr.draft ? " (draft)" : ""}, title: ${pr.title}`)
          }),
        ),
      ),
  )

  server.registerTool(
    "github_pr_comment",
    {
      description:
        "Create, edit or delete a comment on a pull request of a checkout's GitHub repository. create posts to the " +
        "conversation, or replies to a review comment on the diff when replyTo is given. edit and delete act on one of " +
        "your comments by commentId; kind says whether it is a conversation comment or a diff review comment. " +
        "Defaults to this checkout's pull request.",
      inputSchema: {
        checkout: checkoutArg,
        number: numberArg,
        action: z.enum(["create", "edit", "delete"]).describe("create, edit or delete a comment"),
        body: z.string().optional().describe("Comment text (create and edit)"),
        replyTo: z.number().int().positive().optional().describe("Review comment id to reply to (create only)"),
        commentId: z.number().int().positive().optional().describe("Comment id (edit and delete)"),
        kind: z
          .enum(["conversation", "review"])
          .optional()
          .describe("conversation for the pull request's conversation, review for comments on its diff (edit and delete)"),
      },
    },
    (args: {
      checkout?: string
      number?: number
      action: "create" | "edit" | "delete"
      body?: string
      replyTo?: number
      commentId?: number
      kind?: "conversation" | "review"
    }) =>
      guard(() =>
        runTool(
          Effect.gen(function* () {
            const input = yield* commentInputOf(args)
            const posted = yield* deps.github.commentOnPullRequest(ctx.taskId, { checkoutId: args.checkout, number: args.number, ...input })
            if (input.action === "delete") return text(`deleted comment ${input.commentId}`)
            return text(`${input.action === "create" ? "posted" : "edited"} comment: ${posted?.url ?? ""}`)
          }),
        ),
      ),
  )

  server.registerTool(
    "github_pr_reviewers",
    {
      description:
        "Ask users or teams to review a pull request of a checkout's GitHub repository, or remove a review request that is " +
        "still pending. reviewers are logins; teamReviewers are team slugs. Defaults to this checkout's pull request.",
      inputSchema: {
        checkout: checkoutArg,
        number: numberArg,
        action: z.enum(["add", "remove"]).describe("add to request reviews, remove to withdraw requests"),
        reviewers: z.array(z.string().min(1)).optional().describe("GitHub logins"),
        teamReviewers: z.array(z.string().min(1)).optional().describe("Team slugs in the repository's organization"),
      },
    },
    ({
      checkout,
      number,
      action,
      reviewers,
      teamReviewers,
    }: {
      checkout?: string
      number?: number
      action: "add" | "remove"
      reviewers?: string[]
      teamReviewers?: string[]
    }) =>
      guard(() =>
        runTool(
          Effect.gen(function* () {
            const people = reviewers ?? []
            const teams = teamReviewers ?? []
            if (people.length === 0 && teams.length === 0) return yield* rejected("name at least one reviewer or team reviewer")
            yield* deps.github.changeReviewers(ctx.taskId, { checkoutId: checkout, number, action, reviewers: people, teamReviewers: teams })
            const names = [...people, ...teams.map((team) => `team ${team}`)].join(", ")
            return text(action === "add" ? `requested review from ${names}` : `removed review request for ${names}`)
          }),
        ),
      ),
  )

  server.registerTool(
    "github_pr_labels",
    {
      description:
        "Add or remove labels on a pull request of a checkout's GitHub repository. Labels must already exist in the " +
        "repository. Defaults to this checkout's pull request.",
      inputSchema: {
        checkout: checkoutArg,
        number: numberArg,
        action: z.enum(["add", "remove"]).describe("add or remove the labels"),
        labels: z.array(z.string().min(1)).min(1).describe("Label names"),
      },
    },
    ({ checkout, number, action, labels }: { checkout?: string; number?: number; action: "add" | "remove"; labels: string[] }) =>
      guard(() =>
        runTool(
          Effect.gen(function* () {
            yield* deps.github.changeLabels(ctx.taskId, { checkoutId: checkout, number, action, labels })
            return text(`${action === "add" ? "added" : "removed"} labels: ${labels.join(", ")}`)
          }),
        ),
      ),
  )
}
