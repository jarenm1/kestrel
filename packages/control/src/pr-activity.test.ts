import { describe, expect, test } from "bun:test"
import { pullRequestActivity } from "./pr-activity"

const repository = { full_name: "owner/repo" }
describe("pull request activity", () => {
  test("accepts submitted reviews and created PR comments", () => {
    expect(pullRequestActivity("pull_request_review", { action: "submitted", repository, pull_request: { number: 12 } }))
      .toEqual({ repo: "owner/repo", numbers: [12], kind: "review" })
    expect(pullRequestActivity("issue_comment", { action: "created", repository, issue: { number: 12, pull_request: {} } }))
      .toEqual({ repo: "owner/repo", numbers: [12], kind: "comment" })
    expect(pullRequestActivity("issue_comment", { action: "created", repository, issue: { number: 12 } })).toBeNull()
  })
  test("only completed checks associated with PRs are actionable", () => {
    expect(pullRequestActivity("check_run", { action: "completed", repository, check_run: { conclusion: "failure", pull_requests: [{ number: 12 }, { number: 12 }] } }))
      .toEqual({ repo: "owner/repo", numbers: [12], kind: "check" })
    expect(pullRequestActivity("check_run", { action: "completed", repository, check_run: { conclusion: null, pull_requests: [{ number: 12 }] } })).toBeNull()
    expect(pullRequestActivity("check_run", { action: "completed", repository, check_run: { conclusion: "success", pull_requests: [] } })).toBeNull()
  })
})

test("check runs without PR associations retain their head SHA for matching", () => {
  expect(pullRequestActivity("check_run", {
    action: "completed", repository, check_run: { conclusion: "failure", head_sha: "abcdef", pull_requests: [] },
  })).toEqual({ repo: "owner/repo", numbers: [], kind: "check", headSha: "abcdef" })
})

test("ignores pending reviews, edits and unrelated events", () => {
  expect(pullRequestActivity("pull_request_review", { action: "edited", repository, pull_request: { number: 12 } })).toBeNull()
  expect(pullRequestActivity("pull_request_review_comment", { action: "created", repository, pull_request: { number: 12 } }))
    .toEqual({ repo: "owner/repo", numbers: [12], kind: "review_comment" })
  expect(pullRequestActivity("push", { repository })).toBeNull()
})
