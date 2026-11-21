import { expect, test } from "bun:test"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js"
import { Effect } from "effect"
import type { PullRequest } from "../../github/api"
import { type GitHubToolDeps, registerGitHubTools } from "./github"

/** Connects the GitHub tools to an in-memory client; `calls` records what each core operation received. */
const connect = async (
  github: Partial<GitHubToolDeps["github"]>,
  screenshot: GitHubToolDeps["screenshot"] = () => Effect.fail(new Error("the desktop is not running; call desktop_open first")),
) => {
  const server = new McpServer({ name: "test", version: "1" })
  registerGitHubTools(server, { taskId: "task", runId: "run" }, { github, screenshot } as unknown as GitHubToolDeps)
  const client = new Client({ name: "test", version: "1" })
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)])
  return {
    client,
    close: async () => {
      await client.close()
      await server.close()
    },
  }
}

const pullRequest: PullRequest = {
  number: 7,
  nodeId: "PR_node",
  url: "https://github.com/jarenm1/kestrel/pull/7",
  title: "Title",
  state: "open",
  draft: true,
  author: "alice",
  createdAt: "2025-12-30T00:00:00Z",
  updatedAt: "2025-12-31T00:00:00Z",
  mergedAt: null,
  closedAt: null,
  additions: 1,
  deletions: 0,
  changedFiles: 1,
  labels: [],
  requestedReviewers: [],
  headSha: "abc123",
  baseRef: "main",
  headRef: "cloudagents/topic",
  headRepo: "acme/widget",
  mergeable: true,
  mergeableState: "clean",
}

test("github_pr_update passes only the named fields and rejects a call that names none", async () => {
  const calls: unknown[] = []
  const { client, close } = await connect({
    updatePullRequest: (taskId, input) => Effect.sync(() => (calls.push([taskId, input]), pullRequest)),
  })
  try {
    const result = await client.callTool({ name: "github_pr_update", arguments: { draft: false, title: "New" } })
    expect(result.isError).not.toBe(true)
    expect(JSON.stringify(result)).toContain("updated pull request #7")
    expect(calls).toEqual([["task", { checkoutId: undefined, number: undefined, title: "New", body: undefined, base: undefined, state: undefined, draft: false }]])

    const empty = await client.callTool({ name: "github_pr_update", arguments: {} })
    expect(empty.isError).toBe(true)
    expect(JSON.stringify(empty)).toContain("at least one field")
    const blank = await client.callTool({ name: "github_pr_update", arguments: { title: "   " } })
    expect(blank.isError).toBe(true)
    expect(calls).toHaveLength(1)
  } finally {
    await close()
  }
})

test("github_pr_comment checks each action's arguments before it reaches GitHub", async () => {
  const calls: unknown[] = []
  const { client, close } = await connect({
    commentOnPullRequest: (taskId, input) => Effect.sync(() => (calls.push([taskId, input]), input.action === "delete" ? null : { id: 90, url: "https://c/90" })),
  })
  try {
    const created = await client.callTool({ name: "github_pr_comment", arguments: { action: "create", body: "hi", replyTo: 55 } })
    expect(created.isError).not.toBe(true)
    expect(JSON.stringify(created)).toContain("posted comment: https://c/90")

    const deleted = await client.callTool({ name: "github_pr_comment", arguments: { action: "delete", commentId: 9, kind: "conversation" } })
    expect(deleted.isError).not.toBe(true)
    expect(JSON.stringify(deleted)).toContain("deleted comment 9")

    expect(calls).toEqual([
      ["task", { checkoutId: undefined, number: undefined, action: "create", body: "hi", replyTo: 55 }],
      ["task", { checkoutId: undefined, number: undefined, action: "delete", kind: "conversation", commentId: 9 }],
    ])

    const invalid = [
      { action: "create" },
      { action: "create", body: "hi", kind: "review" },
      { action: "edit", body: "x", kind: "review" },
      { action: "delete", kind: "review", commentId: 9, body: "x" },
      { action: "delete", kind: "review", commentId: 9, replyTo: 4 },
    ]
    for (const args of invalid) {
      const result = await client.callTool({ name: "github_pr_comment", arguments: args })
      expect(result.isError).toBe(true)
    }
    expect(calls).toHaveLength(2)
  } finally {
    await close()
  }
})

test("github_pr_reviewers and github_pr_labels forward their names and reject empty requests", async () => {
  const calls: unknown[] = []
  const { client, close } = await connect({
    changeReviewers: (taskId, input) => Effect.sync(() => void calls.push(["reviewers", taskId, input])),
    changeLabels: (taskId, input) => Effect.sync(() => void calls.push(["labels", taskId, input])),
  })
  try {
    const requested = await client.callTool({ name: "github_pr_reviewers", arguments: { action: "add", reviewers: ["octocat"], teamReviewers: ["core"] } })
    expect(JSON.stringify(requested)).toContain("requested review from octocat, team core")

    const none = await client.callTool({ name: "github_pr_reviewers", arguments: { action: "remove" } })
    expect(none.isError).toBe(true)

    const labelled = await client.callTool({ name: "github_pr_labels", arguments: { action: "remove", labels: ["ui", "bug"] } })
    expect(JSON.stringify(labelled)).toContain("removed labels: ui, bug")

    expect(calls).toEqual([
      ["reviewers", "task", { checkoutId: undefined, number: undefined, action: "add", reviewers: ["octocat"], teamReviewers: ["core"] }],
      ["labels", "task", { checkoutId: undefined, number: undefined, action: "remove", labels: ["ui", "bug"] }],
    ])
  } finally {
    await close()
  }
})

test("evidence_attach_to_pr captures the desktop and posts it to the linked pull request", async () => {
  const calls: unknown[] = []
  const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47])
  const { client, close } = await connect(
    {
      attachEvidence: (taskId, input) =>
        Effect.sync(() => {
          calls.push([taskId, input])
          return {
            commentUrl: "https://github.com/jarenm1/kestrel/pull/7#issuecomment-90",
            imageUrl: "https://github.com/jarenm1/kestrel/blob/kestrel-evidence/x.png",
          }
        }),
    },
    (taskId) =>
      Effect.sync(() => {
        calls.push(["screenshot", taskId])
        return png
      }),
  )
  try {
    const result = await client.callTool({
      name: "evidence_attach_to_pr",
      arguments: { caption: "Settings dialog", checkout: "co-1", number: 7 },
    })
    expect(result.isError).not.toBe(true)
    expect(JSON.stringify(result)).toContain("https://github.com/jarenm1/kestrel/pull/7#issuecomment-90")
    expect(calls).toEqual([
      ["screenshot", "task"],
      ["task", { caption: "Settings dialog", bytes: png, mimeType: "image/png", checkoutId: "co-1", number: 7 }],
    ])

    const blank = await client.callTool({ name: "evidence_attach_to_pr", arguments: { caption: "" } })
    expect(blank.isError).toBe(true)
    expect(calls).toHaveLength(2)
  } finally {
    await close()
  }
})

test("evidence_attach_to_pr reports a desktop that is not running without touching GitHub", async () => {
  let attached = 0
  const { client, close } = await connect({
    attachEvidence: () =>
      Effect.sync(() => {
        attached++
        return { commentUrl: "https://c/90", imageUrl: "https://i/1.png" }
      }),
  })
  try {
    const result = await client.callTool({ name: "evidence_attach_to_pr", arguments: { caption: "Evidence" } })
    expect(result.isError).toBe(true)
    expect(JSON.stringify(result)).toContain("desktop_open")
    expect(attached).toBe(0)
  } finally {
    await close()
  }
})
