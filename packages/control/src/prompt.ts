import type { PullRequestInfo } from "./github"

export interface PromptInput {
  readonly name: string
  /** The automation's own prompt, as the user wrote it. */
  readonly prompt: string
  readonly reason: string
  readonly repo: string | null
  readonly pr: PullRequestInfo | null
}

/** Where the box checks a repository out, under the task's working directory: its name without the owner. */
const checkoutDir = (repo: string): string => repo.slice(repo.indexOf("/") + 1)

/**
 * The message that starts an automation's task: the user's prompt followed by the trigger context. Every task
 * starts in an empty workspace; a repository is either checked out up front (a named repository, at the pull
 * request head for a pull request) or left for the agent to check out with `repo_checkout`.
 */
export const composePrompt = (input: PromptInput): string => {
  const lines = [input.prompt, "", "---", `Automation "${input.name}" started this task (${input.reason}).`]
  if (input.repo === null) {
    lines.push(
      "This thread starts in an empty workspace with no repository. If the work needs one, check it out with the `repo_checkout` tool.",
    )
  } else {
    lines.push(
      `Repository: ${input.repo}. The thread starts in an empty workspace, and this repository is already checked out in the directory \`${checkoutDir(input.repo)}\` under your working directory.`,
    )
  }
  const pr = input.pr
  if (pr !== null) {
    const where = input.repo === null ? "" : ` in \`${checkoutDir(input.repo)}\``
    lines.push(
      `Pull request #${pr.number}: "${pr.title}" by ${pr.author}, ${pr.headRef} into ${pr.baseRef} (${pr.url}).`,
      `This task starts at the pull request head. To see the PR's changes run \`git diff ${pr.baseRef}...HEAD\`${where}.`,
      `Post your review with the github_pr_review tool on pull request ${pr.number}.`,
    )
  }
  return lines.join("\n")
}
