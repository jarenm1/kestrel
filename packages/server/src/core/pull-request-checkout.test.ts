import { afterAll, describe, expect, test } from "bun:test"
import { execFileSync } from "node:child_process"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Effect, Either, Layer } from "effect"
import { CliAuth } from "../cliauth"
import { CredentialBroker } from "../broker"
import { Config, type ServerConfig } from "../config"
import { CredentialStore } from "../credentials"
import { DesktopManager } from "../desktop"
import { GitHub, type PullRequestStatus } from "../github/api"
import { EventHubLive } from "./events"
import { AgentHarness } from "./harness"
import { CoreLive, CoreService } from "./service"
import { StateLive, StateStore, type StoreShape } from "./state"
import { WorkspaceLive, WorkspaceService, type WorkspaceShape } from "./workspace"

const roots: string[] = []
afterAll(async () => {
  await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })))
})

const gitEnv = {
  ...process.env,
  GIT_AUTHOR_NAME: "test",
  GIT_AUTHOR_EMAIL: "test@example.com",
  GIT_COMMITTER_NAME: "test",
  GIT_COMMITTER_EMAIL: "test@example.com",
}
const git = (cwd: string, args: string[]): string => execFileSync("git", args, { cwd, env: gitEnv, encoding: "utf8" }).trim()

const REPO = "acme/widget"

const prStatus = (overrides: Partial<PullRequestStatus>): PullRequestStatus => ({
  number: 7,
  nodeId: "node",
  url: `https://github.com/${REPO}/pull/7`,
  title: "Topic",
  state: "open",
  draft: false,
  headSha: "unused",
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
} as PullRequestStatus)

/** A bare origin with `main` and pull request 7 on `branch`, plus a clone to move them from outside the box. */
const makeOrigin = async (root: string, branch: string) => {
  const origin = join(root, "origin.git")
  const seed = join(root, "seed")
  git(root, ["init", "--bare", "-b", "main", origin])
  git(root, ["init", "-b", "main", seed])
  await writeFile(join(seed, "README.md"), "hello\n")
  await writeFile(join(seed, "AGENTS.md"), "Repository instructions\n")
  git(seed, ["add", "."])
  git(seed, ["commit", "-m", "init"])
  git(seed, ["push", origin, "main"])
  git(seed, ["checkout", "-b", branch])
  await writeFile(join(seed, "topic.txt"), "topic\n")
  git(seed, ["add", "."])
  git(seed, ["commit", "-m", "topic"])
  const pushPullRequest = () => git(seed, ["push", origin, `HEAD:refs/heads/${branch}`, "HEAD:refs/pull/7/head"])
  pushPullRequest()
  return { origin, seed, pushPullRequest }
}

/** The real core and workspace against a local origin: only the GitHub API and the remote's URL are stand-ins. */
const withCore = async <A>(
  status: PullRequestStatus,
  origin: string,
  root: string,
  body: (core: CoreService["Type"], threadDir: string, store: StoreShape) => Effect.Effect<A, unknown, never>,
  statusCalls: Array<{ readonly slug: string; readonly number: number }> = [],
  writeCalls: number[] = [],
  openPullRequest: { readonly number: number; readonly url: string } | null = null,
): Promise<A> => {
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
  const real = Effect.runSync(Effect.provide(WorkspaceService, WorkspaceLive))
  const local: WorkspaceShape = {
    ...real,
    syncMirror: (target) => real.syncMirror({ ...target, url: origin }),
    fetchPullRequest: (target) => real.fetchPullRequest({ ...target, url: origin }),
    pushBranch: (spec) => real.pushBranch({ ...spec, url: origin }),
  }
  const configLayer = Layer.succeed(Config, config)
  const workspaceLayer = Layer.succeed(WorkspaceService, local)
  const deps = Layer.mergeAll(
    configLayer, StateLive.pipe(Layer.provide(Layer.merge(configLayer, workspaceLayer))), EventHubLive,
    Layer.succeed(DesktopManager, { watchStatus: () => Effect.void, status: () => Effect.succeed({ state: "stopped", display: null }), stopAll: () => Effect.void } as never),
    workspaceLayer,
    Layer.succeed(CredentialStore, { get: () => Effect.succeed({ github: "token" }) } as never),
    Layer.succeed(GitHub, {
      getPullRequestStatus: (_token: string, repo: { owner: string; name: string }, number: number) => {
        statusCalls.push({ slug: `${repo.owner}/${repo.name}`, number })
        return Effect.succeed(status)
      },
      updatePullRequest: (_token: string, _repo: { owner: string; name: string }, number: number) => {
        writeCalls.push(number)
        return Effect.succeed({ number } as never)
      },
      // The branch lookup: null unless a test supplies an open pull request for the checkout's branch.
      findOpenPullRequest: () => Effect.succeed(openPullRequest as never),
    } as never),
    Layer.succeed(CliAuth, {} as never),
    Layer.succeed(CredentialBroker, {} as never),
    Layer.succeed(AgentHarness, { stopAll: () => Effect.void, items: () => Effect.succeed([]) } as never),
  )
  return Effect.runPromise(
    Effect.gen(function* () {
      const store = yield* StateStore
      const core = yield* CoreService
      const now = new Date().toISOString()
      yield* store.update((s) => {
        s.tasks.push({ id: "t1", owner: "owner", title: "Babysit", status: "idle", createdAt: now, updatedAt: now, checkouts: [] })
        return Either.right(undefined)
      })
      return yield* body(core, join(config.threadsDir, "t1"), store)
    }).pipe(Effect.provide(CoreLive.pipe(Layer.provide(deps), Layer.provideMerge(deps)))) as Effect.Effect<A, unknown, never>,
  )
}

const newRoot = async (): Promise<string> => {
  const root = await mkdtemp(join(tmpdir(), "box-pr-checkout-"))
  roots.push(root)
  return root
}

describe("repo_checkout with a pull request", () => {
  test("pushes an explicit worktree branch and refuses the default branch", async () => {
    const root = await newRoot()
    const { origin } = await makeOrigin(root, "topic")
    await withCore(prStatus({}), origin, root, (core, threadDir) =>
      Effect.gen(function* () {
        const { checkout } = yield* core.checkout("t1", { repo: REPO, pullRequest: 7 } as never)
        const dir = join(threadDir, checkout.dir)
        const worktree = join(threadDir, "worktree")
        git(dir, ["worktree", "add", "-b", "agent/change", worktree])
        yield* Effect.promise(() => writeFile(join(worktree, "work.txt"), "work\n"))
        git(worktree, ["add", "work.txt"])
        git(worktree, ["commit", "-m", "work"])
        expect(yield* core.gitPush("t1", undefined, "agent/change")).toBe("agent/change")
        expect(git(origin, ["rev-parse", "refs/heads/agent/change"])).toBe(git(worktree, ["rev-parse", "HEAD"]))
        const rejected = yield* Effect.either(core.gitPush("t1", undefined, "main"))
        expect(Either.isLeft(rejected)).toBe(true)
        if (Either.isLeft(rejected)) expect(rejected.left.message).toContain("base or default")
      }),
    )
  })
  test("takes the pull request over: its own branch at its head, linked, and pushes update it", async () => {
    const root = await newRoot()
    const { origin } = await makeOrigin(root, "topic")
    const prHead = git(origin, ["rev-parse", "refs/pull/7/head"])
    await withCore(prStatus({}), origin, root, (core, threadDir) =>
      Effect.gen(function* () {
        const { checkout, pullRequest, note, path, instructionFiles } = yield* core.checkout("t1", { repo: REPO, pullRequest: 7 } as never)
        expect(checkout.branch).toBe("topic")
        expect(checkout.baseBranch).toBe("main")
        expect(pullRequest?.number).toBe(7)
        expect(pullRequest?.source).toBe("takeover")
        expect(note).toBeNull()
        const dir = join(threadDir, checkout.dir)
        expect(path).toBe(dir)
        expect(instructionFiles).toEqual([join(dir, "AGENTS.md")])
        expect(git(dir, ["rev-parse", "HEAD"])).toBe(prHead)

        const status = yield* core.pullRequestStatus("t1")
        expect(status.number).toBe(7)

        yield* Effect.promise(() => writeFile(join(dir, "fix.txt"), "fix\n"))
        git(dir, ["add", "."])
        git(dir, ["commit", "-m", "fix"])
        expect(yield* core.gitPush("t1")).toBe("topic")
        expect(git(origin, ["rev-parse", "refs/heads/topic"])).toBe(git(dir, ["rev-parse", "HEAD"]))
      }),
    )
  })

  test("asking again fetches the new head, which the checkout can merge and push", async () => {
    const root = await newRoot()
    const { origin, seed, pushPullRequest } = await makeOrigin(root, "topic")
    await withCore(prStatus({}), origin, root, (core, threadDir) =>
      Effect.gen(function* () {
        const { checkout } = yield* core.checkout("t1", { repo: REPO, pullRequest: 7 } as never)
        const dir = join(threadDir, checkout.dir)

        yield* Effect.promise(() => writeFile(join(seed, "human.txt"), "from someone else\n"))
        git(seed, ["add", "."])
        git(seed, ["commit", "-m", "human push"])
        pushPullRequest()
        const moved = git(seed, ["rev-parse", "HEAD"])

        const again = yield* core.checkout("t1", { repo: REPO, pullRequest: 7 } as never)
        expect(again.checkout.id).toBe(checkout.id)
        expect(again.note).toContain(moved)
        expect(again.instructionFiles).toEqual([])

        git(dir, ["merge", "--ff-only", moved])
        yield* Effect.promise(() => writeFile(join(dir, "fix.txt"), "fix\n"))
        git(dir, ["add", "."])
        git(dir, ["commit", "-m", "fix"])
        yield* core.gitPush("t1")
        expect(git(origin, ["rev-parse", "refs/heads/topic"])).toBe(git(dir, ["rev-parse", "HEAD"]))
      }),
    )
  })

  test("refuses to recreate a taken-over branch after its pull request closes", async () => {
    const root = await newRoot()
    const { origin } = await makeOrigin(root, "topic")
    const status = prStatus({})
    await withCore(status, origin, root, (core) =>
      Effect.gen(function* () {
        yield* core.checkout("t1", { repo: REPO, pullRequest: 7 } as never)
        Object.assign(status, { state: "closed" })
        git(origin, ["update-ref", "-d", "refs/heads/topic"])
        const pushed = yield* Effect.either(core.gitPush("t1"))
        expect(Either.isLeft(pushed)).toBe(true)
        if (Either.isLeft(pushed)) expect(String(pushed.left.message)).toContain("no longer open")
        expect(git(origin, ["branch", "--list", "topic"])).toBe("")
        const opened = yield* Effect.either(core.openPullRequest("t1", { title: "New PR", body: "", draft: false }))
        expect(Either.isLeft(opened)).toBe(true)
        expect(git(origin, ["branch", "--list", "topic"])).toBe("")
      }),
    )
  })

  test("a thread with the repository on another branch refuses instead of ignoring the pull request", async () => {
    const root = await newRoot()
    const { origin } = await makeOrigin(root, "topic")
    await withCore(prStatus({}), origin, root, (core) =>
      Effect.gen(function* () {
        const first = yield* core.checkout("t1", { repo: REPO } as never)
        expect(first.pullRequest).toBeUndefined()
        const refused = yield* Effect.either(core.checkout("t1", { repo: REPO, pullRequest: 7 } as never))
        expect(Either.isLeft(refused)).toBe(true)
        if (Either.isLeft(refused)) expect(String((refused.left as { message: string }).message)).toContain("start a new thread")
      }),
    )
  })

  const threadBranchCases: ReadonlyArray<readonly [string, Partial<PullRequestStatus>, string]> = [
    ["a fork's pull request", { headRepo: "someone/widget" }, "another repository"],
    ["a pull request whose fork is gone", { headRepo: null }, "head repository is no longer available"],
    ["a closed pull request", { state: "closed" }, "closed"],
    ["a merged pull request", { state: "merged" }, "merged"],
    ["a pull request from the default branch", { headRef: "main", baseRef: "release" }, "default branch"],
  ]
  for (const [name, overrides, reason] of threadBranchCases) {
    test(`${name} stays linked on a thread branch and says pushes will not update it`, async () => {
      const root = await newRoot()
      const { origin } = await makeOrigin(root, "topic")
      await withCore(prStatus(overrides), origin, root, (core) =>
        Effect.gen(function* () {
          const { checkout, pullRequest, note } = yield* core.checkout("t1", { repo: REPO, pullRequest: 7 } as never)
          expect(checkout.branch).toStartWith("cloudagents/")
          expect(pullRequest?.number).toBe(7)
          // The checkout sits on its own branch, so it is not the checkout whose pushes update the pull request.
          expect(pullRequest?.checkoutId).toBeUndefined()
          expect(pullRequest?.branch).toBeUndefined()
          expect(note).toContain("do not update pull request #7")
          expect(note).toContain(reason)
        }),
      )
    })
  }

  test("a pull request on a thread branch is not the checkout's, so writes do not default to it", async () => {
    const root = await newRoot()
    const { origin } = await makeOrigin(root, "topic")
    const writes: number[] = []
    await withCore(
      prStatus({ headRepo: "someone/widget" }),
      origin,
      root,
      (core) =>
        Effect.gen(function* () {
          const { pullRequest } = yield* core.checkout("t1", { repo: REPO, pullRequest: 7 } as never)
          expect(pullRequest?.checkoutId).toBeUndefined()
          expect(pullRequest?.branch).toBeUndefined()
          const failed = yield* Effect.either(core.updatePullRequest("t1", { state: "closed" }))
          expect(Either.isLeft(failed)).toBe(true)
        }),
      [],
      writes,
    )
    // Without a checkout link the write fails before GitHub is called.
    expect(writes).toEqual([])
  })

  test("a migrated own-branch link re-links through the branch before a write", async () => {
    const root = await newRoot()
    const writes: number[] = []
    await withCore(
      prStatus({}),
      join(root, "origin"),
      root,
      (core, _threadDir, store) =>
        Effect.gen(function* () {
          yield* store.update((s) => {
            const task = s.tasks.find((t) => t.id === "t1")
            if (task === undefined) return Either.right(undefined)
            const now = new Date().toISOString()
            task.checkouts = [...task.checkouts, { id: "c1", repo: REPO, dir: "widget", branch: "topic", baseBranch: "main", createdAt: now }]
            task.pullRequests = [{ id: `${REPO}#9`, repo: REPO, number: 9, url: `https://github.com/${REPO}/pull/9`, checkoutId: "c1", source: "linked", addedAt: now }]
            return Either.right(undefined)
          })
          yield* core.updatePullRequest("t1", { state: "closed" })
          // The branch lookup found the open pull request, so the entry is re-recorded as the checkout's own.
          const entry = (yield* core.getTask("owner", "t1")).pullRequests?.find((pr) => pr.number === 9)
          expect(entry?.branch).toBe("topic")
        }),
      [],
      writes,
      { number: 9, url: `https://github.com/${REPO}/pull/9` },
    )
    expect(writes).toEqual([9])
  })

  test("a migrated blocked link is not used for a write", async () => {
    const root = await newRoot()
    const writes: number[] = []
    await withCore(
      prStatus({}),
      join(root, "origin"),
      root,
      (core, _threadDir, store) =>
        Effect.gen(function* () {
          yield* store.update((s) => {
            const task = s.tasks.find((t) => t.id === "t1")
            if (task === undefined) return Either.right(undefined)
            const now = new Date().toISOString()
            task.checkouts = [...task.checkouts, { id: "c1", repo: REPO, dir: "widget", branch: "topic", baseBranch: "main", createdAt: now }]
            task.pullRequests = [{ id: `${REPO}#9`, repo: REPO, number: 9, url: `https://github.com/${REPO}/pull/9`, checkoutId: "c1", source: "linked", addedAt: now }]
            return Either.right(undefined)
          })
          // No open pull request for the checkout's branch: the migrated link is not the checkout's own.
          const failed = yield* Effect.either(core.updatePullRequest("t1", { state: "closed" }))
          expect(Either.isLeft(failed)).toBe(true)
        }),
      [],
      writes,
    )
    expect(writes).toEqual([])
  })

  test("detached starts a thread branch at the head, unlinked, as automations ask", async () => {
    const root = await newRoot()
    const { origin } = await makeOrigin(root, "topic")
    const prHead = git(origin, ["rev-parse", "refs/pull/7/head"])
    await withCore(prStatus({}), origin, root, (core, threadDir) =>
      Effect.gen(function* () {
        const { checkout, pullRequest, note } = yield* core.checkout("t1", { repo: REPO, pullRequest: 7, detached: true } as never)
        expect(checkout.branch).toStartWith("cloudagents/")
        expect(pullRequest).toBeUndefined()
        expect(note).toBeNull()
        expect(git(join(threadDir, checkout.dir), ["rev-parse", "HEAD"])).toBe(prHead)
      }),
    )
  })

  test("a thread owns as many pull requests as it needs, watched ones included", async () => {
    const root = await newRoot()
    const { origin } = await makeOrigin(root, "topic")
    await withCore(prStatus({}), origin, root, (core) =>
      Effect.gen(function* () {
        yield* core.checkout("t1", { repo: REPO, pullRequest: 7 } as never)
        yield* core.setPullRequestWatching("t1", REPO, 9, true)
        yield* core.setPullRequestWatching("t1", "acme/other", 3, true)
        const owned = yield* core.getTask("owner", "t1")
        expect(owned.pullRequests?.map((pr) => `${pr.repo}#${pr.number}`)).toEqual([`${REPO}#7`, `${REPO}#9`, "acme/other#3"])
        const watched = owned.pullRequests?.find((pr) => pr.number === 9)
        expect(watched?.watching).toBe(true)
        expect(watched?.source).toBe("linked")
        expect(watched?.checkoutId).toBeUndefined()
        // Re-watching refreshes the entry in place instead of adding a duplicate.
        yield* core.setPullRequestWatching("t1", REPO, 9, true)
        expect((yield* core.getTask("owner", "t1")).pullRequests?.filter((pr) => pr.number === 9)).toHaveLength(1)
        // Dropping one watch (the control plane's, e.g. when the pull request closed) clears its mark but keeps the entry.
        yield* core.setPullRequestWatching("t1", REPO, 9, false)
        const partly = yield* core.getTask("owner", "t1")
        expect(partly.pullRequests?.find((pr) => pr.number === 9)?.watching).toBe(false)
        expect(partly.pullRequests).toHaveLength(3)
        yield* core.setPullRequestWatching("t1", REPO, 9, true)
        yield* core.clearPullRequestWatching("t1")
        const cleared = yield* core.getTask("owner", "t1")
        expect(cleared.pullRequests?.filter((pr) => pr.watching === true)).toEqual([])
        expect(cleared.pullRequests?.map((pr) => pr.number)).toEqual([7, 9, 3])
      }),
    )
  })

  test("checking out a watched pull request keeps its watch, source and addedAt", async () => {
    const root = await newRoot()
    const { origin } = await makeOrigin(root, "topic")
    await withCore(prStatus({}), origin, root, (core) =>
      Effect.gen(function* () {
        yield* core.setPullRequestWatching("t1", REPO, 7, true)
        const watched = (yield* core.getTask("owner", "t1")).pullRequests?.find((pr) => pr.number === 7)
        const { checkout } = yield* core.checkout("t1", { repo: REPO, pullRequest: 7 } as never)
        const entry = (yield* core.getTask("owner", "t1")).pullRequests?.find((pr) => pr.number === 7)
        expect(entry?.watching).toBe(true)
        expect(entry?.source).toBe("linked")
        expect(entry?.addedAt).toBe(watched?.addedAt)
        expect(entry?.checkoutId).toBe(checkout.id)
        expect(entry?.branch).toBe("topic")
      }),
    )
  })
})

describe("github_pr_status by number", () => {
  test("checks a watched pull request in a repository the thread never checked out", async () => {
    const root = await newRoot()
    const calls: Array<{ slug: string; number: number }> = []
    await withCore(
      prStatus({ number: 9 }),
      join(root, "origin"),
      root,
      (core) =>
        Effect.gen(function* () {
          yield* core.setPullRequestWatching("t1", "acme/other", 9, true)
          const status = yield* core.pullRequestStatus("t1", undefined, 9)
          expect(status.number).toBe(9)
        }),
      calls,
    )
    expect(calls).toEqual([{ slug: "acme/other", number: 9 }])
  })

  test("a number registered in several repositories is refused by name", async () => {
    const root = await newRoot()
    const calls: Array<{ slug: string; number: number }> = []
    await withCore(
      prStatus({}),
      join(root, "origin"),
      root,
      (core) =>
        Effect.gen(function* () {
          yield* core.setPullRequestWatching("t1", "acme/widget", 9, true)
          yield* core.setPullRequestWatching("t1", "acme/other", 9, true)
          const failed = yield* Effect.either(core.pullRequestStatus("t1", undefined, 9))
          expect(Either.isLeft(failed)).toBe(true)
          if (Either.isLeft(failed) && "message" in failed.left && typeof failed.left.message === "string") {
            expect(failed.left.message).toContain("several repositories")
            expect(failed.left.message).toContain("acme/widget, acme/other")
          }
          expect(calls).toEqual([])
        }),
      calls,
    )
  })

  test("a number registered in several repositories prefers the thread's only checkout", async () => {
    const root = await newRoot()
    const { origin } = await makeOrigin(root, "topic")
    const calls: Array<{ slug: string; number: number }> = []
    await withCore(
      prStatus({ number: 9 }),
      origin,
      root,
      (core) =>
        Effect.gen(function* () {
          yield* core.checkout("t1", { repo: REPO } as never)
          yield* core.setPullRequestWatching("t1", REPO, 9, true)
          yield* core.setPullRequestWatching("t1", "acme/other", 9, true)
          const status = yield* core.pullRequestStatus("t1", undefined, 9)
          expect(status.number).toBe(9)
        }),
      calls,
    )
    expect(calls).toEqual([{ slug: REPO, number: 9 }])
  })

  test("a write does not fall back to a watched pull request, though a read does", async () => {
    const root = await newRoot()
    const { origin } = await makeOrigin(root, "topic")
    const writes: number[] = []
    await withCore(
      prStatus({ number: 9 }),
      origin,
      root,
      (core) =>
        Effect.gen(function* () {
          yield* core.checkout("t1", { repo: REPO } as never)
          yield* core.setPullRequestWatching("t1", REPO, 9, true)
          // A read may report the thread's only pull request in the checkout's repository.
          expect((yield* core.pullRequestStatus("t1")).number).toBe(9)
          const failed = yield* Effect.either(core.updatePullRequest("t1", { state: "closed" }))
          expect(Either.isLeft(failed)).toBe(true)
          if (Either.isLeft(failed) && "message" in failed.left && typeof failed.left.message === "string") {
            expect(failed.left.message).toContain("no open pull request")
          }
        }),
      [],
      writes,
    )
    expect(writes).toEqual([])
  })
})

describe("forgetPullRequestWatch", () => {
  test("clears one mark and is a no-op when the entry is gone", async () => {
    const root = await newRoot()
    await withCore(prStatus({}), join(root, "origin"), root, (core) =>
      Effect.gen(function* () {
        yield* core.setPullRequestWatching("t1", "acme/other", 9, true)
        yield* core.forgetPullRequestWatch("t1", "acme/other", 9)
        const after = yield* core.getTask("owner", "t1")
        expect(after.pullRequests?.find((pr) => pr.number === 9)?.watching).toBe(false)
        // A repeated cleanup, or one for a pull request the thread never had, succeeds without changing the registry.
        yield* core.forgetPullRequestWatch("t1", "acme/other", 9)
        yield* core.forgetPullRequestWatch("t1", "acme/other", 404)
        expect((yield* core.getTask("owner", "t1")).pullRequests).toHaveLength(1)
      }),
    )
  })
})
