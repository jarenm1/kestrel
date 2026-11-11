import { afterAll, describe, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Effect, Either, Layer } from "effect"
import { threadPullRequestId, type ThreadPullRequest } from "@cloudagents/protocol"
import { CliAuth } from "../cliauth"
import { CredentialBroker } from "../broker"
import { Config, type ServerConfig } from "../config"
import { CredentialStore } from "../credentials"
import { DesktopManager } from "../desktop"
import { GitHub, GitHubError, type GitHubShape, type PullRequestStatus } from "../github/api"
import { EventHubLive } from "./events"
import { AgentHarness } from "./harness"
import { CoreLive, CoreService } from "./service"
import { StateLive, StateStore } from "./state"
import { WorkspaceService } from "./workspace"

const roots: string[] = []
afterAll(async () => {
  await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })))
})

const newRoot = async (): Promise<string> => {
  const root = await mkdtemp(join(tmpdir(), "box-pr-view-"))
  roots.push(root)
  return root
}

const REPO = "acme/widget"
const NOW = "2026-01-01T00:00:00Z"

const statusOf = (overrides: Partial<PullRequestStatus>): PullRequestStatus => ({
  number: 7,
  nodeId: "node",
  url: `https://github.com/${REPO}/pull/7`,
  title: "Topic",
  state: "open",
  draft: false,
  author: "alice",
  createdAt: "2025-12-30T00:00:00Z",
  updatedAt: "2025-12-31T00:00:00Z",
  mergedAt: null,
  closedAt: null,
  additions: 12,
  deletions: 3,
  changedFiles: 2,
  labels: ["bug"],
  requestedReviewers: ["bob"],
  headSha: "abc123",
  baseRef: "main",
  headRef: "topic",
  headRepo: REPO,
  mergeable: true,
  mergeableState: "clean",
  reviewDecision: "none",
  checks: { total: 1, passed: 1, failing: [], pending: [] },
  reviewComments: [],
  conversation: [],
  ...overrides,
})

const registryEntry = (number: number): ThreadPullRequest => ({
  id: threadPullRequestId(REPO, number),
  repo: REPO,
  number,
  url: `https://github.com/${REPO}/pull/${number}`,
  source: "opened",
  watching: false,
  addedAt: NOW,
})

/** The real core against a stubbed GitHub: only what these methods ask for exists. */
const withCore = async <A>(
  github: Partial<GitHubShape>,
  body: (core: CoreService["Type"]) => Effect.Effect<A, unknown, never>,
  credential: { readonly github?: string } = { github: "token" },
): Promise<A> => {
  const root = await newRoot()
  const config = {
    port: 8899, host: "127.0.0.1", sandboxPort: 8899, mcpBaseUrl: "http://127.0.0.1:8899", dataDir: root,
    stateFile: join(root, "state.json"), mirrorsDir: join(root, "mirrors"), threadsDir: join(root, "threads"),
    shadowsDir: join(root, "shadows"), runsDir: join(root, "runs"), attachmentsDir: join(root, "attachments"), homesDir: join(root, "homes"),
    agentCommands: { anthropic: "", openai: "", openrouter: "", zai: "", deepseek: "", minimax: "", moonshot: "", opencode: "", "opencode-go": "", google: "", devin: "" }, agentRouteCommands: { claude: "", codex: "", opencode: "" }, fakeAgent: false, fakeAgentRoBinds: [], sandbox: "off", sandboxPath: null,
    nest: null,
    sandboxSslCertFile: null, systemd: null, maxConcurrentRuns: 2, relay: null, direct: null, toolkitsFlake: null,
    taskDiskMax: 1024 ** 3, desktopIdleStopAfterMs: 0, streamIdleCloseAfterMs: 0, githubApiUrl: "https://api.github.com",
    webrtc: { iceServers: [], turn: null, policy: "all", portRange: null, hostAddresses: [], denyPrivate: false },
  } as ServerConfig
  const configLayer = Layer.succeed(Config, config)
  const deps = Layer.mergeAll(
    configLayer,
    StateLive.pipe(Layer.provide(configLayer)),
    EventHubLive,
    Layer.succeed(DesktopManager, { watchStatus: () => Effect.void } as never),
    Layer.succeed(WorkspaceService, {} as never),
    Layer.succeed(CredentialStore, { get: () => Effect.succeed(credential) } as never),
    Layer.succeed(GitHub, github as never),
    Layer.succeed(CliAuth, {} as never),
    Layer.succeed(CredentialBroker, {} as never),
    Layer.succeed(AgentHarness, {} as never),
  )
  return Effect.runPromise(
    Effect.gen(function* () {
      const store = yield* StateStore
      const core = yield* CoreService
      yield* store.update((s) => {
        s.tasks.push({
          id: "t1",
          owner: "owner",
          title: "Babysit",
          status: "idle",
          createdAt: NOW,
          updatedAt: NOW,
          checkouts: [],
          pullRequests: [registryEntry(7), registryEntry(8)],
        })
        return Either.right(undefined)
      })
      return yield* body(core)
    }).pipe(Effect.provide(CoreLive.pipe(Layer.provide(deps), Layer.provideMerge(deps)))) as Effect.Effect<A, unknown, never>,
  )
}

describe("pull request view", () => {
  test("the list carries GitHub's live view of each owned pull request, and the failure of one that cannot be read", async () => {
    const listed = await withCore(
      {
        getPullRequestStatus: (_token, _slug, number) =>
          number === 8
            ? Effect.fail(new GitHubError({ message: "GitHub API 502: Bad Gateway" }))
            : Effect.succeed(statusOf({ number })),
      },
      (core) => core.threadPullRequests("owner", "t1"),
    )
    expect(listed.pullRequests).toHaveLength(2)
    const [first, second] = listed.pullRequests
    expect(first).toMatchObject({ number: 7, repo: REPO, watching: false, source: "opened" })
    expect(first?.snapshot).toMatchObject({
      title: "Topic",
      state: "open",
      author: "alice",
      additions: 12,
      deletions: 3,
      changedFiles: 2,
      labels: ["bug"],
      reviewers: ["bob"],
      reviewDecision: "none",
      checks: { total: 1, passed: 1, failing: [], pending: [] },
    })
    expect(second).toMatchObject({ number: 8, error: "GitHub API 502: Bad Gateway" })
    expect(second?.snapshot).toBeUndefined()
  })

  test("the list falls back to registry data when the owner has no GitHub connection", async () => {
    const listed = await withCore({}, (core) => core.threadPullRequests("owner", "t1"), {})
    expect(listed.pullRequests).toHaveLength(2)
    expect(listed.pullRequests[0]).toMatchObject({
      repo: REPO,
      number: 7,
      url: `https://github.com/${REPO}/pull/7`,
      source: "opened",
      watching: false,
      error: "no GitHub connection for this account: connect GitHub under Connections, then retry",
    })
    expect(listed.pullRequests[0]?.snapshot).toBeUndefined()
    expect(listed.pullRequests[1]).toMatchObject({ number: 8 })
  })

  test("the detail merges the summary with the body, reviews, comments, commits and files", async () => {
    const detail = await withCore(
      {
        getPullRequestStatus: () => Effect.succeed(statusOf({})),
        readReference: () =>
          Effect.succeed({
            kind: "pr",
            number: 7,
            title: "Topic",
            body: "The pull request body",
            state: "open",
            draft: false,
            author: "alice",
            url: `https://github.com/${REPO}/pull/7`,
            createdAt: "2025-12-30T00:00:00Z",
            updatedAt: "2025-12-31T00:00:00Z",
            labels: ["bug"],
            baseRef: "main",
            headRef: "topic",
            headSha: "abc123",
            mergeable: true,
            mergeableState: "clean",
            reviewDecision: "none",
            checks: { total: 0, passed: 0, failing: [], pending: [] },
            reviews: [
              { author: "bob", state: "APPROVED", body: "Looks good", url: "https://github.com/review/1", submittedAt: "2025-12-31T01:00:00Z" },
            ],
            reviewComments: [
              { author: "bob", body: "nit", url: "https://github.com/comment/1", createdAt: "2025-12-31T02:00:00Z", path: "src/a.ts", line: 12 },
            ],
            conversation: [
              { author: "alice", body: "Thanks", url: "https://github.com/comment/2", createdAt: "2025-12-31T03:00:00Z" },
            ],
            files: [{ path: "src/a.ts", status: "modified", additions: 12, deletions: 3 }],
          }),
        pullRequestCommits: () =>
          Effect.succeed([{ oid: "abc123", headline: "Topic", committedAt: "2025-12-30T00:00:00Z", author: "alice" }]),
      },
      (core) => core.threadPullRequest("owner", "t1", REPO, 7),
    )
    expect(detail.summary).toMatchObject({ number: 7, snapshot: { title: "Topic" } })
    expect(detail.body).toBe("The pull request body")
    expect(detail.reviews).toEqual([
      { author: "bob", state: "APPROVED", body: "Looks good", url: "https://github.com/review/1", submittedAt: "2025-12-31T01:00:00Z" },
    ])
    expect(detail.comments).toEqual([
      { author: "alice", body: "Thanks", url: "https://github.com/comment/2", createdAt: "2025-12-31T03:00:00Z", kind: "conversation", path: null, line: null },
      { author: "bob", body: "nit", url: "https://github.com/comment/1", createdAt: "2025-12-31T02:00:00Z", kind: "review_comment", path: "src/a.ts", line: 12 },
    ])
    expect(detail.commits).toEqual([{ oid: "abc123", headline: "Topic", committedAt: "2025-12-30T00:00:00Z", author: "alice" }])
    expect(detail.files).toEqual([{ path: "src/a.ts", status: "modified", additions: 12, deletions: 3 }])
  })

  test("the diff is the pull request's unified diff", async () => {
    const diff = await withCore(
      {
        pullRequestDiff: (_token, _slug, number, format) =>
          Effect.succeed(`diff --git a/${number} b/${number}\n${format}`),
      },
      (core) => core.threadPullRequestDiff("owner", "t1", REPO, 7),
    )
    expect(diff).toEqual({ patch: "diff --git a/7 b/7\ndiff", truncated: false })
  })

  test("a diff over 2 MiB is cut and marked truncated", async () => {
    const diff = await withCore(
      { pullRequestDiff: () => Effect.succeed("x".repeat(2 * 1024 * 1024 + 1)) },
      (core) => core.threadPullRequestDiff("owner", "t1", REPO, 7),
    )
    expect(diff.truncated).toBe(true)
    expect(diff.patch).toHaveLength(2 * 1024 * 1024)
  })

  test("merge, close and an approving review reach the right GitHub calls", async () => {
    const calls: string[] = []
    await withCore(
      {
        mergePullRequest: (_token, slug, number, method) => {
          calls.push(`merge ${slug.owner}/${slug.name}#${number} ${method}`)
          return Effect.void
        },
        updatePullRequest: (_token, slug, number, changes) => {
          calls.push(`update ${slug.owner}/${slug.name}#${number} ${changes.state ?? ""}`)
          return Effect.succeed(statusOf({ number, state: changes.state ?? "open" }))
        },
        createReview: (_token, slug, number, review) => {
          calls.push(`review ${slug.owner}/${slug.name}#${number} ${review.event} ${review.body}`)
          return Effect.succeed({ url: "https://github.com/review/1", state: review.event })
        },
        createComment: (_token, slug, number, body) => {
          calls.push(`comment ${slug.owner}/${slug.name}#${number} ${body}`)
          return Effect.succeed({ id: 1, url: "https://github.com/comment/1" })
        },
      },
      (core) =>
        Effect.gen(function* () {
          yield* core.actOnPullRequest("owner", "t1", { action: "comment", repo: REPO, number: 7, body: "looks good" })
          yield* core.actOnPullRequest("owner", "t1", { action: "review", repo: REPO, number: 7, body: "ship it", verdict: "approve" })
          yield* core.actOnPullRequest("owner", "t1", { action: "merge", repo: REPO, number: 7, method: "squash" })
          yield* core.actOnPullRequest("owner", "t1", { action: "close", repo: REPO, number: 7 })
        }),
    )
    expect(calls).toEqual([
      "comment acme/widget#7 looks good",
      "review acme/widget#7 APPROVE ship it",
      "merge acme/widget#7 squash",
      "update acme/widget#7 closed",
    ])
  })

  test("a pull request the thread does not own is NotFound", async () => {
    const result = await withCore({}, (core) =>
      Effect.either(core.threadPullRequest("owner", "t1", REPO, 99)),
    )
    expect(Either.isLeft(result)).toBe(true)
    if (Either.isLeft(result)) {
      expect(result.left._tag).toBe("NotFound")
      expect(result.left.message).toContain("acme/widget#99")
    }
  })

  test("acting on a pull request the thread does not own is NotFound before GitHub is called", async () => {
    const calls: string[] = []
    const result = await withCore(
      {
        mergePullRequest: () => {
          calls.push("merge")
          return Effect.void
        },
      },
      (core) => Effect.either(core.actOnPullRequest("owner", "t1", { action: "merge", repo: REPO, number: 99, method: "merge" })),
    )
    expect(Either.isLeft(result)).toBe(true)
    expect(calls).toEqual([])
  })

  test("requireOwnedPullRequest accepts a registry entry and answers its watch state", async () => {
    const before = await withCore({}, (core) => core.requireOwnedPullRequest("owner", "t1", REPO, 7))
    expect(before).toEqual({ watching: false })
    const watched = await withCore({}, (core) =>
      Effect.gen(function* () {
        yield* core.setPullRequestWatching("t1", REPO, 7, true)
        return yield* core.requireOwnedPullRequest("owner", "t1", REPO, 7)
      }),
    )
    expect(watched).toEqual({ watching: true })
    const unowned = await withCore({}, (core) =>
      Effect.either(core.requireOwnedPullRequest("owner", "t1", REPO, 99)),
    )
    expect(Either.isLeft(unowned) && unowned.left._tag).toBe("NotFound")
    const otherThread = await withCore({}, (core) =>
      Effect.either(core.requireOwnedPullRequest("someone-else", "t1", REPO, 7)),
    )
    expect(Either.isLeft(otherThread) && otherThread.left._tag).toBe("NotFound")
  })
})
