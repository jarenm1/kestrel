import { afterAll, describe, expect, test } from "bun:test"
import { execFileSync } from "node:child_process"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Effect, Either, Layer } from "effect"
import { CliAuth } from "../cliauth"
import { Config, type ServerConfig } from "../config"
import { CredentialStore } from "../credentials"
import { DesktopManager } from "../desktop"
import { GitHub, type PullRequestStatus } from "../github/api"
import { EventHubLive } from "./events"
import { AgentHarness } from "./harness"
import { CoreLive, CoreService } from "./service"
import { StateLive, StateStore } from "./state"
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
  body: (core: CoreService["Type"], threadDir: string) => Effect.Effect<A, unknown, never>,
): Promise<A> => {
  const config = {
    port: 8899, host: "127.0.0.1", sandboxPort: 8899, mcpBaseUrl: "http://127.0.0.1:8899", dataDir: root,
    stateFile: join(root, "state.json"), mirrorsDir: join(root, "mirrors"), threadsDir: join(root, "threads"),
    shadowsDir: join(root, "shadows"), runsDir: join(root, "runs"), attachmentsDir: join(root, "attachments"), homesDir: join(root, "homes"),
    agentCommands: { anthropic: "", openai: "", openrouter: "", zai: "", opencode: "", google: "", omp: "", pi: "", hermes: "" }, fakeAgent: false, fakeAgentRoBinds: [], sandbox: "off", sandboxPath: null,
    sandboxSslCertFile: null, systemd: null, maxConcurrentRuns: 2, relay: null, direct: null, toolkitsFlake: null,
    taskDiskMax: 1024 ** 3, githubApiUrl: "https://api.github.com",
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
      getPullRequestStatus: () => Effect.succeed(status),
      // Linked checkouts must never need the lookup by branch.
      findOpenPullRequest: () => Effect.succeed(null),
    } as never),
    Layer.succeed(CliAuth, {} as never),
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
      return yield* body(core, join(config.threadsDir, "t1"))
    }).pipe(Effect.provide(CoreLive.pipe(Layer.provide(deps), Layer.provideMerge(deps)))) as Effect.Effect<A, unknown, never>,
  )
}

const newRoot = async (): Promise<string> => {
  const root = await mkdtemp(join(tmpdir(), "box-pr-checkout-"))
  roots.push(root)
  return root
}

describe("repo_checkout with a pull request", () => {
  test("takes the pull request over: its own branch at its head, linked, and pushes update it", async () => {
    const root = await newRoot()
    const { origin } = await makeOrigin(root, "topic")
    const prHead = git(origin, ["rev-parse", "refs/pull/7/head"])
    await withCore(prStatus({}), origin, root, (core, threadDir) =>
      Effect.gen(function* () {
        const { checkout, note, path, instructionFiles } = yield* core.checkout("t1", { repo: REPO, pullRequest: 7 } as never)
        expect(checkout.branch).toBe("topic")
        expect(checkout.baseBranch).toBe("main")
        expect(checkout.pullRequest?.number).toBe(7)
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
        expect(first.checkout.pullRequest).toBeUndefined()
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
          const { checkout, note } = yield* core.checkout("t1", { repo: REPO, pullRequest: 7 } as never)
          expect(checkout.branch).toStartWith("cloudagents/")
          expect(checkout.pullRequest?.number).toBe(7)
          expect(note).toContain("do not update pull request #7")
          expect(note).toContain(reason)
        }),
      )
    })
  }

  test("detached starts a thread branch at the head, unlinked, as automations ask", async () => {
    const root = await newRoot()
    const { origin } = await makeOrigin(root, "topic")
    const prHead = git(origin, ["rev-parse", "refs/pull/7/head"])
    await withCore(prStatus({}), origin, root, (core, threadDir) =>
      Effect.gen(function* () {
        const { checkout, note } = yield* core.checkout("t1", { repo: REPO, pullRequest: 7, detached: true } as never)
        expect(checkout.branch).toStartWith("cloudagents/")
        expect(checkout.pullRequest).toBeUndefined()
        expect(note).toBeNull()
        expect(git(join(threadDir, checkout.dir), ["rev-parse", "HEAD"])).toBe(prHead)
      }),
    )
  })
})
