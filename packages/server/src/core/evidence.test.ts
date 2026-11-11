import { afterAll, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Effect, Either, Layer } from "effect"
import { MAX_ATTACHMENT_BYTES } from "@cloudagents/protocol"
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
import { evidenceBranch, evidenceCommentBody, evidencePath } from "./evidence"

test("evidence uses one shared branch and no code branch", () => {
  expect(evidenceBranch()).toBe("kestrel-evidence")
  expect(evidenceBranch()).not.toBe("main")
})

test("evidence paths carry a sanitized task id and a unique capture timestamp", () => {
  expect(evidencePath("task-1", 7, 1_700_000_000_000)).toBe(".kestrel/evidence/task-1/7-1700000000000.png")
  const sanitized = evidencePath("team/../My Task!", 7, 1_700_000_000_000)
  expect(sanitized).toBe(".kestrel/evidence/team-..-My-Task/7-1700000000000.png")
  expect(sanitized.startsWith(".kestrel/evidence/")).toBe(true)
  expect(sanitized.split("/")).not.toContain("..")
  expect(evidencePath("", 7, 1)).toBe(".kestrel/evidence/task/7-1.png")
  expect(evidencePath("task-1", 7.9, -1)).toBe(".kestrel/evidence/task-1/7-0.png")
})

test("the evidence comment shows the blob raw with the caption and provenance", () => {
  const body = evidenceCommentBody({
    caption: "Settings dialog\nopen",
    htmlUrl: "https://github.com/jarenm1/kestrel/blob/kestrel-evidence/.kestrel/evidence/task-1/7-1.png",
    taskId: "task-1",
    capturedAt: "2026-11-09T00:00:00.000Z",
  })
  expect(body).toContain(
    "![Settings dialog open](https://github.com/jarenm1/kestrel/blob/kestrel-evidence/.kestrel/evidence/task-1/7-1.png?raw=true)",
  )
  expect(body).toContain("task `task-1`")
  expect(body).toContain("captured 2026-11-09T00:00:00.000Z")
  expect(body).not.toContain("\nopen")
})

test("a blank or bracket-bearing caption cannot break the markdown image", () => {
  const blank = evidenceCommentBody({ caption: "  ", htmlUrl: "https://github.com/a/b/blob/x/y.png", taskId: "t", capturedAt: "now" })
  expect(blank.startsWith("![Desktop screenshot](https://github.com/a/b/blob/x/y.png?raw=true)")).toBe(true)

  const bracketed = evidenceCommentBody({ caption: "[draft] fix", htmlUrl: "https://github.com/a/b/blob/x/y.png", taskId: "t", capturedAt: "now" })
  expect(bracketed.startsWith("![\\[draft\\] fix](")).toBe(true)
})

const roots: string[] = []
afterAll(async () => {
  await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })))
})

const REPO = "acme/widget"
const NOW = "2026-01-01T00:00:00Z"

const statusOf = (overrides: Partial<PullRequestStatus>): PullRequestStatus =>
  ({
    number: 7,
    nodeId: "node",
    url: `https://github.com/${REPO}/pull/7`,
    title: "Topic",
    state: "open",
    draft: false,
    headSha: "abc123",
    baseRef: "main",
    headRef: "topic",
    headRepo: REPO,
    mergeable: true,
    mergeableState: "clean",
    reviewDecision: "none",
    checks: { total: 0, passed: 0, failing: [], pending: [] },
    reviewComments: [],
    conversation: [],
    ...overrides,
  }) as PullRequestStatus

/** The real core against a stubbed GitHub, with one GitHub checkout on the thread. */
const withCore = async <A>(
  github: Partial<GitHubShape>,
  body: (core: CoreService["Type"]) => Effect.Effect<A, unknown, never>,
): Promise<A> => {
  const root = await mkdtemp(join(tmpdir(), "box-evidence-"))
  roots.push(root)
  const config = {
    port: 8899, host: "127.0.0.1", sandboxPort: 8899, mcpBaseUrl: "http://127.0.0.1:8899", dataDir: root,
    stateFile: join(root, "state.json"), mirrorsDir: join(root, "mirrors"), threadsDir: join(root, "threads"),
    shadowsDir: join(root, "shadows"), runsDir: join(root, "runs"), attachmentsDir: join(root, "attachments"), homesDir: join(root, "homes"),
    agentCommands: { anthropic: "", openai: "", openrouter: "", zai: "", deepseek: "", minimax: "", moonshot: "", opencode: "", "opencode-go": "", google: "", devin: "" }, agentRouteCommands: { claude: "", codex: "", opencode: "" }, fakeAgent: false, fakeAgentRoBinds: [], sandbox: "off", sandboxPath: null,
    nest: null,
    sandboxSslCertFile: null, systemd: null, maxConcurrentRuns: 2, relay: null, direct: null, toolkitsFlake: null,
    taskDiskMax: 1024 ** 3, githubApiUrl: "https://api.github.com",
    webrtc: { iceServers: [], turn: null, policy: "all", portRange: null, hostAddresses: [], denyPrivate: false },
  } as ServerConfig
  const configLayer = Layer.succeed(Config, config)
  const deps = Layer.mergeAll(
    configLayer,
    StateLive.pipe(Layer.provide(configLayer)),
    EventHubLive,
    Layer.succeed(DesktopManager, { watchStatus: () => Effect.void } as never),
    Layer.succeed(WorkspaceService, {} as never),
    Layer.succeed(CredentialStore, { get: () => Effect.succeed({ github: "token" }) } as never),
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
          title: "Evidence",
          status: "idle",
          createdAt: NOW,
          updatedAt: NOW,
          checkouts: [{ id: "c1", repo: REPO, dir: "widget", branch: "topic", baseBranch: "main", createdAt: NOW }],
          pullRequests: [],
        })
        return Either.right(undefined)
      })
      return yield* body(core)
    }).pipe(Effect.provide(CoreLive.pipe(Layer.provide(deps), Layer.provideMerge(deps)))) as Effect.Effect<A, unknown, never>,
  )
}

test("the service refuses a capture over the 10 MiB cap before it contacts GitHub", async () => {
  let statusCalls = 0
  const oversized = await withCore(
    {
      getPullRequestStatus: () => {
        statusCalls += 1
        return Effect.succeed(statusOf({}))
      },
    },
    (core) =>
      Effect.either(
        core.attachEvidenceToPullRequest("t1", {
          caption: "too big",
          bytes: new Uint8Array(MAX_ATTACHMENT_BYTES + 1),
          mimeType: "image/png",
          number: 7,
        }),
      ),
  )
  expect(Either.isLeft(oversized)).toBe(true)
  if (Either.isLeft(oversized)) {
    expect((oversized.left as { message: string }).message).toContain(`the limit is ${MAX_ATTACHMENT_BYTES}`)
  }
  expect(statusCalls).toBe(0)
})

test("the service refuses a closed pull request and writes neither the evidence branch nor a comment", async () => {
  const writes: string[] = []
  const closed = await withCore(
    {
      getPullRequestStatus: () => Effect.succeed(statusOf({ state: "closed" })),
      putFile: () => Effect.sync(() => (writes.push("putFile"), { path: "p", branch: "b", htmlUrl: "https://github.com/x", sha: "blob-sha" })),
      createComment: () => Effect.sync(() => (writes.push("createComment"), { id: 1, url: "https://github.com/c/1" })),
    },
    (core) =>
      Effect.either(
        core.attachEvidenceToPullRequest("t1", { caption: "closed", bytes: new Uint8Array([1]), mimeType: "image/png", number: 7 }),
      ),
  )
  expect(Either.isLeft(closed)).toBe(true)
  if (Either.isLeft(closed)) {
    expect((closed.left as { message: string }).message).toContain("pull request #7 is closed; evidence can only be attached to an open pull request")
  }
  expect(writes).toEqual([])
})

test("the service commits the capture to the evidence branch and comments it on the open pull request", async () => {
  const putFiles: unknown[] = []
  const comments: string[] = []
  const bytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47])
  const attached = await withCore(
    {
      getPullRequestStatus: () => Effect.succeed(statusOf({ state: "open", baseRef: "main" })),
      putFile: (_token, _repo, input) => {
        putFiles.push(input)
        return Effect.succeed({ path: input.path, branch: input.branch, htmlUrl: `https://github.com/${REPO}/blob/${input.branch}/${input.path}`, sha: "blob-sha" })
      },
      createComment: (_token, _repo, number, body) => {
        comments.push(body)
        return Effect.succeed({ id: 1, url: `https://github.com/${REPO}/pull/${number}#issuecomment-1` })
      },
    },
    (core) => core.attachEvidenceToPullRequest("t1", { caption: "Settings dialog", bytes, mimeType: "image/png", number: 7 }),
  )
  expect(putFiles).toHaveLength(1)
  const input = putFiles[0] as { path: string; branch: string; bytes: Uint8Array; message: string; createFrom?: string }
  expect(input.branch).toBe(evidenceBranch())
  expect(input.branch).not.toBe("topic")
  expect(input.createFrom).toBe("main")
  expect(input.path.startsWith(`.kestrel/evidence/t1/7-`)).toBe(true)
  expect(input.path.endsWith(".png")).toBe(true)
  expect(input.bytes).toBe(bytes)
  expect(comments).toHaveLength(1)
  expect(comments[0]).toContain("![Settings dialog](https://github.com/acme/widget/blob/kestrel-evidence/")
  expect(comments[0]).toContain("?raw=true)")
  expect(comments[0]).toContain("task `t1`")
  expect(attached).toEqual({ commentUrl: "https://github.com/acme/widget/pull/7#issuecomment-1", imageUrl: expect.stringContaining(".kestrel/evidence/t1/7-") })
})

test("a failed comment deletes the uploaded evidence and returns the original error", async () => {
  const deleted: Array<{ path: string; branch: string; sha: string; message: string }> = []
  const failed = await withCore(
    {
      getPullRequestStatus: () => Effect.succeed(statusOf({ state: "open", baseRef: "main" })),
      putFile: (_token, _repo, input) =>
        Effect.succeed({ path: input.path, branch: input.branch, htmlUrl: "https://github.com/x", sha: "blob-sha" }),
      createComment: () => Effect.fail(new GitHubError({ message: "comment failed" })),
      deleteFile: (_token, _repo, input) => Effect.sync(() => void deleted.push(input)),
    },
    (core) =>
      Effect.either(
        core.attachEvidenceToPullRequest("t1", {
          caption: "Settings",
          bytes: new Uint8Array([1]),
          mimeType: "image/png",
          number: 7,
        }),
      ),
  )
  expect(Either.isLeft(failed)).toBe(true)
  expect(deleted).toHaveLength(1)
  expect(deleted[0]).toMatchObject({
    branch: "kestrel-evidence",
    sha: "blob-sha",
    message: expect.stringContaining("Remove unlinked evidence"),
  })
})
