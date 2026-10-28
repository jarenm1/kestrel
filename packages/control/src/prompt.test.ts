import { describe, expect, test } from "bun:test"
import type { PullRequestInfo } from "./github"
import { composePrompt } from "./prompt"

const pr: PullRequestInfo = {
  number: 7,
  title: "Add retries",
  url: "https://github.com/acme/app/pull/7",
  draft: false,
  author: "octo",
  headRef: "retries",
  baseRef: "main",
}

const base = { name: "Nightly", prompt: "Check the build.", reason: "manual" }

describe("composePrompt", () => {
  test("without a repository tells the agent to check one out on demand", () => {
    const text = composePrompt({ ...base, repo: null, pr: null })
    expect(text).toContain("Check the build.")
    expect(text).toContain("empty workspace with no repository")
    expect(text).toContain("`repo_checkout`")
    expect(text).not.toContain("Repository:")
  })

  test("with a repository names it and its checkout directory", () => {
    const text = composePrompt({ ...base, repo: "acme/app", pr: null })
    expect(text).toContain("Repository: acme/app.")
    expect(text).toContain("checked out in the directory `app`")
    expect(text).not.toContain("repo_checkout")
  })

  test("a pull request reviews the PR head against its base, inside the checkout", () => {
    const text = composePrompt({ ...base, reason: "pull_request.opened", repo: "acme/app", pr })
    expect(text).toContain('Pull request #7: "Add retries" by octo, retries into main')
    expect(text).toContain("git diff main...HEAD` in `app`.")
    expect(text).toContain("github_pr_review tool on pull request 7")
  })
})
