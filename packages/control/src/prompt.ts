import type { PullRequestInfo } from "./github"

export interface PromptInput {
  readonly name: string
  /** The automation's own prompt, as the user wrote it. */
  readonly prompt: string
  readonly reason: string
  readonly repo: string | null
  readonly pr: PullRequestInfo | null
}

/**
 * The message that starts an automation's task: the user's prompt followed by the trigger context. For a pull
 * request the task forks from the PR head (see the box's `pullRequest` option), so the reviewer needs the base
 * branch to see the PR's own changes.
 */
export const composePrompt = (input: PromptInput): string => {
  const lines = [input.prompt, "", "---", `Automation "${input.name}" started this task (${input.reason}).`]
  if (input.repo !== null) lines.push(`Repository: ${input.repo}`)
  const pr = input.pr
  if (pr !== null) {
    lines.push(
      `Pull request #${pr.number}: "${pr.title}" by ${pr.author}, ${pr.headRef} into ${pr.baseRef} (${pr.url}).`,
      `This task starts at the pull request head. To see the PR's changes run \`git diff ${pr.baseRef}...HEAD\`.`,
      `Post your review with the github_pr_review tool on pull request ${pr.number}.`,
    )
  }
  return lines.join("\n")
}
