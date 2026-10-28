import { describe, expect, test } from "bun:test"
import {
  matchGithubTrigger,
  verifyGithubSignature,
  type GithubTrigger,
  type PullRequestEvent,
} from "./github"

const sign = async (secret: string, body: string): Promise<string> => {
  const encoder = new TextEncoder()
  const key = await crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, [
    "sign",
  ])
  const mac = await crypto.subtle.sign("HMAC", key, encoder.encode(body))
  return `sha256=${[...new Uint8Array(mac)].map((byte) => byte.toString(16).padStart(2, "0")).join("")}`
}

const pr = (overrides: Partial<PullRequestEvent["pr"]> = {}): PullRequestEvent["pr"] => ({
  number: 12,
  title: "Add thing",
  url: "https://github.com/acme/app/pull/12",
  draft: false,
  author: "bob",
  headRef: "feature",
  baseRef: "main",
  ...overrides,
})

const event = (overrides: Partial<PullRequestEvent> = {}): PullRequestEvent => ({
  action: "opened",
  repo: "acme/app",
  pr: pr(),
  requestedReviewer: null,
  ...overrides,
})

describe("verifyGithubSignature", () => {
  const body = '{"action":"opened"}'

  test("accepts the HMAC of the exact raw body", async () => {
    expect(await verifyGithubSignature("s3cret", body, await sign("s3cret", body))).toBe(true)
  })

  test("rejects a tampered body, a wrong secret, a missing or non-sha256 header", async () => {
    const header = await sign("s3cret", body)
    expect(await verifyGithubSignature("s3cret", `${body} `, header)).toBe(false)
    expect(await verifyGithubSignature("other", body, header)).toBe(false)
    expect(await verifyGithubSignature("s3cret", body, null)).toBe(false)
    expect(await verifyGithubSignature("s3cret", body, header.replace("sha256=", "sha1="))).toBe(false)
  })
})

describe("matchGithubTrigger", () => {
  const opened: GithubTrigger = { _tag: "github", events: ["pull_request.opened"] }

  test("fires for a listed event and returns the reason", () => {
    expect(matchGithubTrigger(opened, event())).toBe("pull_request.opened #12")
  })

  test("ignores unlisted events", () => {
    expect(matchGithubTrigger(opened, event({ action: "closed" }))).toBeNull()
  })

  test("review_requested filters on the requested login, case-insensitively", () => {
    const trigger: GithubTrigger = {
      _tag: "github",
      events: ["pull_request.review_requested"],
      reviewers: ["Alice"],
    }
    const action = "review_requested"
    expect(matchGithubTrigger(trigger, event({ action, requestedReviewer: "alice" }))).toBe(
      "pull_request.review_requested #12",
    )
    expect(matchGithubTrigger(trigger, event({ action, requestedReviewer: "carol" }))).toBeNull()
    expect(matchGithubTrigger(trigger, event({ action, requestedReviewer: null }))).toBeNull()
  })

  test("an empty reviewers list does not filter", () => {
    const trigger: GithubTrigger = {
      _tag: "github",
      events: ["pull_request.review_requested"],
      reviewers: [],
    }
    expect(matchGithubTrigger(trigger, event({ action: "review_requested", requestedReviewer: "carol" }))).not.toBeNull()
  })

  test("baseBranches restricts by target branch", () => {
    const trigger: GithubTrigger = { _tag: "github", events: ["pull_request.opened"], baseBranches: ["release"] }
    expect(matchGithubTrigger(trigger, event())).toBeNull()
    expect(matchGithubTrigger(trigger, event({ pr: pr({ baseRef: "release" }) }))).not.toBeNull()
  })

  test("drafts are skipped unless includeDrafts is true", () => {
    const draft = event({ pr: pr({ draft: true }) })
    expect(matchGithubTrigger(opened, draft)).toBeNull()
    expect(matchGithubTrigger({ ...opened, includeDrafts: true }, draft)).not.toBeNull()
  })
})
