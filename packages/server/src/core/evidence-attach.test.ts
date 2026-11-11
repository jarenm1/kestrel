import { afterAll, describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, truncateSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Effect, Either, Layer } from "effect"
import { threadPullRequestId, type RunClip } from "@cloudagents/protocol"
import { CliAuth } from "../cliauth"
import { CredentialBroker } from "../broker"
import { Config, type ServerConfig } from "../config"
import { CredentialStore } from "../credentials"
import { DesktopManager } from "../desktop"
import { clipsDir } from "../desktop/recorder"
import { GitHub, GitHubError, type GitHubShape, type PullRequestStatus, type UserAttachmentInput } from "../github/api"
import { EventHubLive } from "./events"
import { AgentHarness } from "./harness"
import { CoreLive, CoreService, MAX_EVIDENCE_IMAGE_BYTES, MAX_EVIDENCE_VIDEO_BYTES } from "./service"
import { StateLive, StateStore } from "./state"
import { WorkspaceService } from "./workspace"

const roots: string[] = []
afterAll(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

const REPO = "acme/widget"
const NOW = "2026-01-01T00:00:00Z"

const statusOf = (state: PullRequestStatus["state"]): PullRequestStatus => ({
  number: 7,
  nodeId: "node",
  url: `https://github.com/${REPO}/pull/7`,
  title: "Topic",
  state,
  draft: false,
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
  headRef: "topic",
  headRepo: REPO,
  mergeable: true,
  mergeableState: "clean",
  reviewDecision: "none",
  checks: { total: 0, passed: 0, failing: [], pending: [] },
  reviewComments: [],
  conversation: [],
})

/** A run with one clip and its poster on disk, in the layout the recorder writes. */
const writeClip = (runsDir: string, runId: string, clip: RunClip, bytes = 3): void => {
  const dir = clipsDir(join(runsDir, runId))
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, clip.id), Buffer.alloc(bytes))
  writeFileSync(join(dir, `${clip.id.slice(0, -".mp4".length)}.json`), JSON.stringify(clip))
  if (clip.poster !== null) writeFileSync(join(dir, clip.poster), Buffer.alloc(bytes))
}

/** The real core against a stubbed GitHub and a temporary runs directory. */
const withCore = async <A>(
  github: Partial<GitHubShape>,
  body: (core: CoreService["Type"], runsDir: string) => Effect.Effect<A, unknown, never>,
  options: { readonly secondCheckout?: boolean } = {},
): Promise<A> => {
  const root = mkdtempSync(join(tmpdir(), "box-evidence-attach-"))
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
          title: "Babysit",
          status: "idle",
          createdAt: NOW,
          updatedAt: NOW,
          checkouts: [
            { id: "c1", repo: REPO, dir: "widget", branch: "topic", baseBranch: "main", createdAt: NOW },
            ...(options.secondCheckout === true
              ? [{ id: "c2", repo: "acme/gadget", dir: "gadget", branch: "other", baseBranch: "main", createdAt: NOW }]
              : []),
          ],
          pullRequests: [
            {
              id: threadPullRequestId(REPO, 7),
              repo: REPO,
              number: 7,
              url: `https://github.com/${REPO}/pull/7`,
              checkoutId: "c1",
              branch: "topic",
              source: "opened",
              watching: false,
              addedAt: NOW,
            },
          ],
        })
        s.runs.push({ id: "run", taskId: "t1", prompt: "Build it", status: "succeeded", startedAt: NOW, endedAt: NOW, exitCode: 0 })
        s.runs.push({ id: "older", taskId: "t1", prompt: "Earlier", status: "succeeded", startedAt: "2025-12-31T00:00:00Z", endedAt: "2025-12-31T00:00:01Z", exitCode: 0 })
        return Either.right(undefined)
      })
      return yield* body(core, config.runsDir)
    }).pipe(Effect.provide(CoreLive.pipe(Layer.provide(deps), Layer.provideMerge(deps)))) as Effect.Effect<A, unknown, never>,
  )
}

const hex = (seed: string): string => seed.repeat(32)

/** A clip's `id` and `poster` are file names (the recorder's 32-hex id plus extension). */
const clip = (seed: string, createdAt: string, withPoster = true): RunClip => ({
  id: `${hex(seed)}.mp4`,
  caption: `Clip ${seed}`,
  createdAt,
  durationMs: 1000,
  poster: withPoster ? `${hex(seed)}.png` : null,
})

const VIDEO_URL = "https://github.com/user-attachments/assets/video"
const IMAGE_URL = "https://github.com/user-attachments/assets/image"

describe("attaching run evidence to a pull request", () => {
  test("uploads the newest clip and comments its bare URL with provenance", async () => {
    const uploads: UserAttachmentInput[] = []
    const comments: string[] = []
    const result = await withCore(
      {
        getPullRequestStatus: () => Effect.succeed(statusOf("open")),
        uploadUserAttachment: (_token, _repo, input) => Effect.sync(() => (uploads.push(input), { url: VIDEO_URL })),
        createComment: (_token, _repo, _number, body) =>
          Effect.sync(() => (comments.push(body), { id: 1, url: "https://github.com/acme/widget/pull/7#issuecomment-1" })),
      },
      (core, runsDir) => {
        writeClip(runsDir, "run", clip("a", "2026-01-01T00:00:00Z"))
        writeClip(runsDir, "run", clip("b", "2026-01-01T00:00:01Z"))
        return core.attachRunEvidenceToPullRequest("t1", { caption: "Spawn works", runId: "run" })
      },
    )
    expect(result).toEqual({
      commentUrl: "https://github.com/acme/widget/pull/7#issuecomment-1",
      evidenceUrl: VIDEO_URL,
    })
    expect(uploads).toHaveLength(1)
    expect(uploads[0]).toMatchObject({ contentType: "video/mp4", name: `evidence-${hex("b")}.mp4` })
    expect(comments).toHaveLength(1)
    expect(comments[0]).toContain("Spawn works")
    expect(comments[0]).toContain(VIDEO_URL)
    expect(comments[0]).toContain(`Recorded from run run (clip ${hex("b")}.mp4) in Kestrel thread "Babysit".`)
    expect(comments[0]).not.toContain("![")
  })

  test("poster: true uploads the PNG and comments it as a markdown image", async () => {
    const uploads: UserAttachmentInput[] = []
    const comments: string[] = []
    await withCore(
      {
        getPullRequestStatus: () => Effect.succeed(statusOf("open")),
        uploadUserAttachment: (_token, _repo, input) => Effect.sync(() => (uploads.push(input), { url: IMAGE_URL })),
        createComment: (_token, _repo, _number, body) =>
          Effect.sync(() => (comments.push(body), { id: 2, url: "https://github.com/acme/widget/pull/7#issuecomment-2" })),
      },
      (core, runsDir) => {
        writeClip(runsDir, "run", clip("c", "2026-01-01T00:00:00Z"))
        return core.attachRunEvidenceToPullRequest("t1", { caption: "The frame", runId: "run", poster: true })
      },
    )
    expect(uploads[0]).toMatchObject({ contentType: "image/png", name: `evidence-${hex("c")}.png` })
    expect(comments[0]).toStartWith(`![The frame](${IMAGE_URL})`)
    expect(comments[0]).toContain(`Recorded from run run (clip ${hex("c")}.mp4)`)
  })

  test("refuses a pull request that is not open and a poster a clip does not have", async () => {
    const closed = await withCore(
      { getPullRequestStatus: () => Effect.succeed(statusOf("merged")) },
      (core, runsDir) => {
        writeClip(runsDir, "run", clip("d", "2026-01-01T00:00:00Z"))
        return Effect.either(core.attachRunEvidenceToPullRequest("t1", { caption: "Done", runId: "run" }))
      },
    )
    expect(closed._tag).toBe("Left")
    if (closed._tag === "Left") {
      expect(String(closed.left)).toContain("Conflict:")
      expect(String(closed.left)).toContain("is merged")
    }

    const noPoster = await withCore(
      { getPullRequestStatus: () => Effect.succeed(statusOf("open")) },
      (core, runsDir) => {
        writeClip(runsDir, "run", clip("e", "2026-01-01T00:00:00Z", false))
        return Effect.either(core.attachRunEvidenceToPullRequest("t1", { caption: "Done", runId: "run", poster: true }))
      },
    )
    expect(noPoster._tag).toBe("Left")
    if (noPoster._tag === "Left") {
      expect(String(noPoster.left)).toContain(`BadRequest: clip ${hex("e")}.mp4 has no poster; attach the video instead`)
    }
  })

  test("rejects an unknown run and an unknown clip", async () => {
    const unknownRun = await withCore(
      { getPullRequestStatus: () => Effect.succeed(statusOf("open")) },
      (core) => Effect.either(core.attachRunEvidenceToPullRequest("t1", { caption: "Done", runId: "missing" })),
    )
    expect(unknownRun._tag).toBe("Left")
    if (unknownRun._tag === "Left") expect(String(unknownRun.left)).toContain("NotFound: run missing not found")

    const unknownClip = await withCore(
      { getPullRequestStatus: () => Effect.succeed(statusOf("open")) },
      (core, runsDir) => {
        writeClip(runsDir, "run", clip("f", "2026-01-01T00:00:00Z"))
        return Effect.either(core.attachRunEvidenceToPullRequest("t1", { caption: "Done", runId: "run", clipId: "nope" }))
      },
    )
    expect(unknownClip._tag).toBe("Left")
    if (unknownClip._tag === "Left") expect(String(unknownClip.left)).toContain("NotFound: run run has no clip nope")
  })

  test("enforces the video and image size caps before uploading", async () => {
    const uploads: UserAttachmentInput[] = []
    const github = {
      getPullRequestStatus: () => Effect.succeed(statusOf("open")),
      uploadUserAttachment: (_token: string, _repo: unknown, input: UserAttachmentInput) =>
        Effect.sync(() => (uploads.push(input), { url: VIDEO_URL })),
    }
    const oversizedVideo = await withCore(github, (core, runsDir) => {
      writeClip(runsDir, "run", clip("a", "2026-01-01T00:00:00Z", false))
      truncateSync(join(clipsDir(join(runsDir, "run")), `${hex("a")}.mp4`), MAX_EVIDENCE_VIDEO_BYTES + 1)
      return Effect.either(core.attachRunEvidenceToPullRequest("t1", { caption: "Done", runId: "run" }))
    })
    expect(oversizedVideo._tag).toBe("Left")
    if (oversizedVideo._tag === "Left") {
      expect(String(oversizedVideo.left)).toContain("BadRequest:")
      expect(String(oversizedVideo.left)).toContain("50 MB")
    }

    const oversizedPoster = await withCore(github, (core, runsDir) => {
      writeClip(runsDir, "run", clip("b", "2026-01-01T00:00:00Z"))
      truncateSync(join(clipsDir(join(runsDir, "run")), `${hex("b")}.png`), MAX_EVIDENCE_IMAGE_BYTES + 1)
      return Effect.either(core.attachRunEvidenceToPullRequest("t1", { caption: "Done", runId: "run", poster: true }))
    })
    expect(oversizedPoster._tag).toBe("Left")
    if (oversizedPoster._tag === "Left") {
      expect(String(oversizedPoster.left)).toContain("BadRequest:")
      expect(String(oversizedPoster.left)).toContain("10 MB")
    }
    expect(uploads).toHaveLength(0)
  })

  test("retries a failed comment once, then reports the second failure", async () => {
    let attempts = 0
    const transient = await withCore(
      {
        getPullRequestStatus: () => Effect.succeed(statusOf("open")),
        uploadUserAttachment: () => Effect.succeed({ url: VIDEO_URL }),
        createComment: () =>
          Effect.suspend(() => {
            attempts += 1
            return attempts === 1
              ? Effect.fail(new GitHubError({ message: "HTTP 502" }))
              : Effect.succeed({ id: 3, url: "https://github.com/acme/widget/pull/7#issuecomment-3" })
          }),
      },
      (core, runsDir) => {
        writeClip(runsDir, "run", clip("a", "2026-01-01T00:00:00Z"))
        return core.attachRunEvidenceToPullRequest("t1", { caption: "Done", runId: "run" })
      },
    )
    expect(transient.commentUrl).toBe("https://github.com/acme/widget/pull/7#issuecomment-3")
    expect(attempts).toBe(2)

    let failures = 0
    const persistent = await withCore(
      {
        getPullRequestStatus: () => Effect.succeed(statusOf("open")),
        uploadUserAttachment: () => Effect.succeed({ url: VIDEO_URL }),
        createComment: () =>
          Effect.suspend(() => {
            failures += 1
            return Effect.fail(new GitHubError({ message: "HTTP 502" }))
          }),
      },
      (core, runsDir) => {
        writeClip(runsDir, "run", clip("a", "2026-01-01T00:00:00Z"))
        return Effect.either(core.attachRunEvidenceToPullRequest("t1", { caption: "Done", runId: "run" }))
      },
    )
    expect(persistent._tag).toBe("Left")
    expect(failures).toBe(2)
  })
})

describe("evidence attachment defaults", () => {
  test("without runId it uses the thread's newest run", async () => {
    const result = await withCore(
      {
        getPullRequestStatus: () => Effect.succeed(statusOf("open")),
        uploadUserAttachment: () => Effect.succeed({ url: VIDEO_URL }),
        createComment: () => Effect.succeed({ id: 4, url: "https://github.com/acme/widget/pull/7#issuecomment-4" }),
      },
      (core, runsDir) => {
        writeClip(runsDir, "older", clip("a", "2026-01-01T00:00:00Z"))
        writeClip(runsDir, "run", clip("b", "2026-01-01T00:00:00Z"))
        return core.attachRunEvidenceToPullRequest("t1", { caption: "Newest" })
      },
    )
    expect(result.evidenceUrl).toBe(VIDEO_URL)
  })
})

describe("evidence attachment edge cases", () => {
  test("a thread with several checkouts needs checkoutId and uses the named one", async () => {
    const { ambiguous, resolved } = await withCore(
      {
        getPullRequestStatus: () => Effect.succeed(statusOf("open")),
        uploadUserAttachment: () => Effect.succeed({ url: VIDEO_URL }),
        createComment: () => Effect.succeed({ id: 5, url: "https://github.com/acme/widget/pull/7#issuecomment-5" }),
      },
      (core, runsDir) => {
        writeClip(runsDir, "run", clip("a", "2026-01-01T00:00:00Z"))
        const attach = (checkoutId?: string) =>
          Effect.either(
            core.attachRunEvidenceToPullRequest("t1", { caption: "Spawn works", checkoutId, runId: "run" }),
          )
        return Effect.flatMap(attach(), (first) => Effect.map(attach("c1"), (second) => ({ ambiguous: first, resolved: second })))
      },
      { secondCheckout: true },
    )
    expect(ambiguous._tag).toBe("Left")
    if (ambiguous._tag === "Left") expect(String(ambiguous.left)).toContain("this thread has several checkouts")
    expect(resolved).toMatchObject({
      _tag: "Right",
      right: { commentUrl: "https://github.com/acme/widget/pull/7#issuecomment-5", evidenceUrl: VIDEO_URL },
    })
  })

  test("a poster escapes markdown brackets and flattens the caption; a video keeps it as plain text", async () => {
    const caption = "Spawn works](https://example.com/x)\nnext"
    const makeCore = (comments: string[]) =>
      withCore(
        {
          getPullRequestStatus: () => Effect.succeed(statusOf("open")),
          uploadUserAttachment: () => Effect.succeed({ url: IMAGE_URL }),
          createComment: (_token, _repo, _number, body) =>
            Effect.sync(() => (comments.push(body), { id: 6, url: "https://github.com/acme/widget/pull/7#issuecomment-6" })),
        },
        (core, runsDir) => {
          writeClip(runsDir, "run", clip("b", "2026-01-01T00:00:00Z"))
          return core.attachRunEvidenceToPullRequest("t1", { caption, runId: "run", poster: true })
        },
      )

    const posterComments: string[] = []
    await makeCore(posterComments)
    expect(posterComments[0]).toStartWith(`![Spawn works\\](https://example.com/x) next](${IMAGE_URL})`)

    const videoComments: string[] = []
    await withCore(
      {
        getPullRequestStatus: () => Effect.succeed(statusOf("open")),
        uploadUserAttachment: () => Effect.succeed({ url: VIDEO_URL }),
        createComment: (_token, _repo, _number, body) =>
          Effect.sync(() => (videoComments.push(body), { id: 7, url: "https://github.com/acme/widget/pull/7#issuecomment-7" })),
      },
      (core, runsDir) => {
        writeClip(runsDir, "run", clip("b", "2026-01-01T00:00:00Z"))
        return core.attachRunEvidenceToPullRequest("t1", { caption, runId: "run" })
      },
    )
    expect(videoComments[0]).toStartWith(`${caption}\n\n${VIDEO_URL}`)
  })
})
