import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { Cause, Effect, Exit, Layer, Option } from "effect"
import type { InternalError } from "@cloudagents/protocol"
import { existsSync } from "node:fs"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Config, type ServerConfig } from "../config"
import { StateLive, StateStore, type StoreState } from "./state"
import { WorkspaceService } from "./workspace"

const NOW = "2026-11-01T00:00:00.000Z"

const configOf = (root: string): ServerConfig => ({
  port: 8899, host: "127.0.0.1", sandboxPort: 8899, mcpBaseUrl: "http://127.0.0.1:8899", dataDir: root,
  stateFile: join(root, "state.json"), mirrorsDir: join(root, "mirrors"), threadsDir: join(root, "threads"),
  shadowsDir: join(root, "shadows"), runsDir: join(root, "runs"), attachmentsDir: join(root, "attachments"), homesDir: join(root, "homes"),
  agentCommands: { anthropic: "", openai: "", openrouter: "", zai: "", deepseek: "", minimax: "", moonshot: "", opencode: "", "opencode-go": "", google: "", devin: "" }, agentRouteCommands: { claude: "", codex: "", opencode: "" }, fakeAgent: false, fakeAgentRoBinds: [], sandbox: "off", sandboxPath: null,
  nest: null,
  sandboxSslCertFile: null, systemd: null, maxConcurrentRuns: 2, relay: null, direct: null, toolkitsFlake: null,
  taskDiskMax: 1024 ** 3, githubApiUrl: "https://api.github.com",
  webrtc: { iceServers: [], turn: null, policy: "all", portRange: null, hostAddresses: [], denyPrivate: false },
})

const storeLayer = (root: string) =>
  StateLive.pipe(
    Layer.provide(Layer.merge(Layer.succeed(Config, configOf(root)), Layer.succeed(WorkspaceService, {} as never))),
  )

const loadState = (root: string): Promise<Readonly<StoreState>> =>
  Effect.runPromise(Effect.flatMap(StateStore, (store) => store.read).pipe(Effect.provide(storeLayer(root))))

const loadExit = (root: string) =>
  Effect.runPromiseExit(Effect.flatMap(StateStore, (store) => store.read).pipe(Effect.provide(storeLayer(root))))

interface RawState {
  tasks: Array<Record<string, unknown>>
  messages: Array<Record<string, unknown>>
  runs: Array<Record<string, unknown>>
  pendingAsks: Array<Record<string, unknown>>
  uploads: Array<Record<string, unknown>>
  runSessions: Array<Record<string, unknown>>
}

const task = (id: string): Record<string, unknown> => ({
  id, owner: "owner", title: `thread ${id}`, status: "idle", createdAt: NOW, updatedAt: NOW, checkouts: [],
})
const message = (id: string, taskId: string, runId: string, role: string, text: string): Record<string, unknown> => ({
  id, taskId, runId, role, text, createdAt: NOW,
})
const run = (id: string, taskId: string, extra: Record<string, unknown>): Record<string, unknown> => ({
  id, taskId, prompt: id, status: "succeeded", startedAt: NOW, endedAt: NOW, exitCode: 0, ...extra,
})

/** State written while OMP, Pi and Hermes were selectable, alongside supported runs and sessions. */
const mixedState = (): RawState => ({
  tasks: [task("supported-thread"), task("retired-thread")],
  messages: [
    message("m1", "supported-thread", "r1", "user", "supported request"),
    message("m2", "retired-thread", "r2", "user", "retired request"),
    message("m3", "retired-thread", "r3", "agent", "retired answer"),
  ],
  runs: [
    run("r1", "supported-thread", { provider: "anthropic", model: "claude-opus-5", harness: "claude" }),
    run("r2", "retired-thread", { provider: "omp", model: "omp-deepseek-pro", harness: "omp" }),
    run("r3", "retired-thread", { provider: "hermes", model: "hermes-deepseek-flash", harness: "hermes" }),
    run("r4", "retired-thread", { provider: "pi" }),
  ],
  pendingAsks: [],
  uploads: [],
  runSessions: [
    { runId: "r1", sessionId: "claude-session-r1", provider: "anthropic" },
    { runId: "r2", sessionId: "omp-session-r2", provider: "omp" },
    { runId: "r4", sessionId: "pi-session-r4", provider: "pi" },
  ],
})

const readRaw = async (file: string): Promise<RawState> => JSON.parse(await readFile(file, "utf8")) as RawState

describe("retired harness state", () => {
  let root: string
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "kestrel-state-"))
  })
  afterEach(async () => {
    await rm(root, { recursive: true, force: true })
  })

  test("starts from mixed supported and retired runs, keeping history and supported sessions", async () => {
    const file = join(root, "state.json")
    await writeFile(file, JSON.stringify(mixedState()))

    const state = await loadState(root)

    expect(state.tasks.map((t) => t.id)).toEqual(["supported-thread", "retired-thread"])
    expect(state.messages.map((m) => m.id)).toEqual(["m1", "m2", "m3"])
    expect(state.messages.map((m) => m.text)).toEqual(["supported request", "retired request", "retired answer"])
    expect(state.runs.map((r) => r.id)).toEqual(["r1", "r2", "r3", "r4"])
    expect(state.runs[0]!.provider).toBe("anthropic")
    expect(state.runs[0]!.model).toBe("claude-opus-5")
    for (const retired of state.runs.slice(1)) {
      expect(retired.provider).toBeUndefined()
      expect(retired.model).toBeUndefined()
      expect(retired.prompt).toBe(retired.id)
      expect(retired.status).toBe("succeeded")
    }
    // Only the supported resume target survives; a retired one cannot continue on any supported harness.
    expect(state.runSessions.map((s) => s.runId)).toEqual(["r1"])
    expect(state.runSessions[0]!.provider).toBe("anthropic")

    const raw = await readRaw(file)
    expect(raw.tasks.map((t) => t.id)).toEqual(["supported-thread", "retired-thread"])
    expect(raw.messages.map((m) => m.id)).toEqual(["m1", "m2", "m3"])
    expect(raw.runs.map((r) => r.id)).toEqual(["r1", "r2", "r3", "r4"])
    // A supported run keeps its routing metadata, including the harness field the current schema does not read.
    expect(raw.runs[0]).toMatchObject({ provider: "anthropic", model: "claude-opus-5", harness: "claude" })
    for (const retired of raw.runs.slice(1)) {
      expect(retired).not.toHaveProperty("provider")
      expect(retired).not.toHaveProperty("model")
      expect(retired).not.toHaveProperty("harness")
    }
    expect(raw.runSessions.map((s) => s.runId)).toEqual(["r1"])
  })

  test("the rewritten state reloads unchanged and is not rewritten again", async () => {
    const file = join(root, "state.json")
    await writeFile(file, JSON.stringify(mixedState()))
    await loadState(root)
    const rewritten = await readFile(file, "utf8")
    expect(rewritten).not.toContain("omp-deepseek-pro")
    expect(rewritten).not.toContain("hermes-deepseek-flash")
    expect(rewritten).not.toContain('"sessionId":"omp-session-r2"')

    const reloaded = await loadState(root)
    expect(await readFile(file, "utf8")).toBe(rewritten)
    expect(reloaded.runs.map((r) => r.id)).toEqual(["r1", "r2", "r3", "r4"])
    expect(reloaded.runSessions.map((s) => s.runId)).toEqual(["r1"])
    expect(reloaded.runs.slice(1).every((r) => r.provider === undefined && r.model === undefined)).toBe(true)
  })

  test("unrelated corruption still fails startup and leaves the file untouched", async () => {
    const file = join(root, "state.json")
    const state = mixedState()
    state.runs.push(run("r5", "supported-thread", { provider: "anthropic", model: "claude-three-million" }))
    const original = JSON.stringify(state)
    await writeFile(file, original)

    const exit = await loadExit(root)

    expect(Exit.isFailure(exit)).toBe(true)
    const failure = Exit.isFailure(exit) ? Cause.failureOption(exit.cause) : Option.none<InternalError>()
    expect(Option.isSome(failure) ? failure.value.message : "").toContain(`corrupt state file ${file}`)
    // The retired fields were only dropped in memory, never written over a file that did not validate.
    expect(await readFile(file, "utf8")).toBe(original)
  })

  test("a missing state file starts empty and legacy records load unchanged", async () => {
    expect(await loadState(root)).toEqual({
      tasks: [], messages: [], runs: [], pendingAsks: [], uploads: [], runSessions: [], settledRuns: [],
    })
    expect(existsSync(join(root, "state.json"))).toBe(false)

    const legacy = {
      tasks: [task("t1")],
      messages: [],
      runs: [run("r1", "t1", {})],
      runSessions: [{ runId: "r1", sessionId: "s1" }],
    }
    const file = join(root, "state.json")
    await writeFile(file, JSON.stringify(legacy))

    const state = await loadState(root)
    expect(state.runs[0]!.provider).toBeUndefined()
    expect(state.runSessions[0]!.provider).toBe("anthropic")
    expect(state.settledRuns).toEqual([])
    expect(await readFile(file, "utf8")).toBe(JSON.stringify(legacy))
  })
})

describe("legacy checkout pull requests", () => {
  let root: string
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "kestrel-state-"))
  })
  afterEach(async () => {
    await rm(root, { recursive: true, force: true })
  })

  test("migrated links keep the checkout and record no branch", async () => {
    const file = join(root, "state.json")
    await writeFile(file, JSON.stringify({
      tasks: [{
        ...task("legacy"),
        checkouts: [
          {
            id: "c1", repo: "acme/widget", dir: "widget", branch: "topic", baseBranch: "main", createdAt: NOW,
            pullRequestTakeover: true,
            pullRequest: { number: 7, url: "https://github.com/acme/widget/pull/7" },
          },
          {
            id: "c2", repo: "acme/other", dir: "other", branch: "cloudagents/fix-abc", baseBranch: "main", createdAt: NOW,
            pullRequest: { number: 9, url: "https://github.com/acme/other/pull/9" },
          },
          {
            id: "c3", repo: "acme/third", dir: "third", branch: "cloudagents/read-abc", baseBranch: "main", createdAt: NOW,
            pullRequest: { number: 11, url: "https://github.com/acme/third/pull/11" },
          },
        ],
      }],
      messages: [], runs: [], pendingAsks: [], uploads: [], runSessions: [],
    }))

    const state = await loadState(root)
    const entries = state.tasks[0]?.pullRequests ?? []
    expect(entries.map((pr) => `${pr.repo}#${pr.number}`)).toEqual(["acme/widget#7", "acme/other#9", "acme/third#11"])
    // Every link keeps its checkout association (the app and `gh` show it), takeover or not, and no branch: the old
    // state has no head ref, so a write verifies it through the checkout's branch. A blocked link looks the same here
    // and simply finds no open pull request for its branch.
    expect(entries[0]).toMatchObject({ checkoutId: "c1", source: "takeover" })
    expect(entries[1]).toMatchObject({ checkoutId: "c2", source: "linked" })
    expect(entries[2]).toMatchObject({ checkoutId: "c3", source: "linked" })
    for (const entry of entries) expect(entry.branch).toBeUndefined()
  })
})
