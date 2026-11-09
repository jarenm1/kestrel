import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { Cause, Effect, Either, Exit, Layer, Option } from "effect"
import type { InternalError } from "@cloudagents/protocol"
import { existsSync } from "node:fs"
import { chmod, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises"
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

describe("failed durable writes", () => {
  let root: string
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "kestrel-state-"))
  })
  afterEach(async () => {
    await rm(root, { recursive: true, force: true })
  })

  // A directory where the state file belongs makes the atomic rename fail, so the write is refused as a real I/O fault.
  const breakWrites = (file: string) => Effect.promise(() => rm(file, { force: true }).then(() => mkdir(file)))
  const mendWrites = (file: string) => Effect.promise(() => rm(file, { recursive: true, force: true }))

  test("a mutation whose write failed never reaches disk, even after a later successful update", async () => {
    const file = join(root, "state.json")
    await writeFile(file, JSON.stringify(mixedState()))

    const program = Effect.gen(function* () {
      const store = yield* StateStore
      const before = (yield* store.read).tasks[0]!
      const titleBefore = before.title
      yield* breakWrites(file)

      const failed = yield* Effect.either(
        store.update((s) => {
          s.tasks[0]!.title = "never saved"
          s.tasks.push({ ...s.tasks[0]!, id: "ghost" })
          return Either.right(undefined)
        }),
      )
      expect(Either.isLeft(failed)).toBe(true)
      // Memory matches what is durable: the failed mutation is rolled back, and the object identity callers hold survives.
      const after = yield* store.read
      expect(after.tasks.map((t) => t.id)).toEqual(["supported-thread", "retired-thread"])
      expect(after.tasks[0]).toBe(before)
      expect(before.title).toBe(titleBefore)

      yield* mendWrites(file)
      yield* store.update((s) => {
        s.tasks.push({ ...s.tasks[0]!, id: "kept" })
        return Either.right(undefined)
      })
      yield* store.flush
    })
    await Effect.runPromise(program.pipe(Effect.provide(storeLayer(root))))

    const reloaded = await loadState(root)
    expect(reloaded.tasks.map((t) => t.id)).toEqual(["supported-thread", "retired-thread", "kept"])
    expect(reloaded.tasks[0]!.title).toBe("thread supported-thread")
    expect(JSON.stringify(reloaded)).not.toContain("never saved")
    expect(JSON.stringify(reloaded)).not.toContain("ghost")
  })

  test("a rejected update rolls back the mutations it made before returning Left", async () => {
    const file = join(root, "state.json")
    await writeFile(file, JSON.stringify(mixedState()))

    const program = Effect.gen(function* () {
      const store = yield* StateStore
      const rejected = yield* Effect.either(
        store.update((s) => {
          s.tasks[0]!.title = "rejected"
          return Either.left("nope" as const)
        }),
      )
      expect(Either.isLeft(rejected)).toBe(true)
      expect((yield* store.read).tasks[0]!.title).toBe("thread supported-thread")
      yield* store.update((s) => {
        s.tasks.push({ ...s.tasks[0]!, id: "kept" })
        return Either.right(undefined)
      })
      yield* store.flush
    })
    await Effect.runPromise(program.pipe(Effect.provide(storeLayer(root))))

    const reloaded = await loadState(root)
    expect(reloaded.tasks[0]!.title).toBe("thread supported-thread")
    expect(reloaded.tasks.map((t) => t.id)).toEqual(["supported-thread", "retired-thread", "kept"])
  })

  // `f` runs synchronously, so reading from inside it is the exact window an update's mutation is in flight before the
  // write settles. Overlapping readers must see the last committed state there, not the mutation.
  test("readers during an in-flight update see only committed state, on success and on failure", async () => {
    const file = join(root, "state.json")
    await writeFile(file, JSON.stringify(mixedState()))

    const program = Effect.gen(function* () {
      const store = yield* StateStore
      const seenDuring: string[] = []
      yield* store.update((s) => {
        s.tasks[0]!.title = "in flight"
        seenDuring.push(Effect.runSync(store.read).tasks[0]!.title)
        return Either.right(undefined)
      })
      expect(seenDuring).toEqual(["thread supported-thread"])
      expect((yield* store.read).tasks[0]!.title).toBe("in flight")

      yield* breakWrites(file)
      const failedSeen: string[] = []
      const failed = yield* Effect.either(
        store.update((s) => {
          s.tasks[0]!.title = "doomed"
          failedSeen.push(Effect.runSync(store.read).tasks[0]!.title)
          return Either.right(undefined)
        }),
      )
      expect(Either.isLeft(failed)).toBe(true)
      expect(failedSeen).toEqual(["in flight"])
      expect((yield* store.read).tasks[0]!.title).toBe("in flight")
      yield* mendWrites(file)
      yield* store.update((s) => {
        s.tasks.push({ ...s.tasks[0]!, id: "kept" })
        return Either.right(undefined)
      })
      yield* store.flush
    })
    await Effect.runPromise(program.pipe(Effect.provide(storeLayer(root))))

    const reloaded = await loadState(root)
    expect(reloaded.tasks[0]!.title).toBe("in flight")
    expect(reloaded.tasks.map((t) => t.id)).toEqual(["supported-thread", "retired-thread", "kept"])
  })

  test("a rejected update is reported as not applied, and a failed write names its outcome", async () => {
    const file = join(root, "state.json")
    await writeFile(file, JSON.stringify(mixedState()))

    const program = Effect.gen(function* () {
      const store = yield* StateStore
      yield* breakWrites(file)
      const failed = yield* Effect.either(
        store.update((s) => {
          s.tasks[0]!.title = "never saved"
          return Either.right(undefined)
        }),
      )
      expect(Either.isLeft(failed)).toBe(true)
      if (Either.isLeft(failed)) expect(failed.left.message).toContain("update not applied")
      yield* mendWrites(file)
    })
    await Effect.runPromise(program.pipe(Effect.provide(storeLayer(root))))
  })

  test("a failed write leaves no temporary file behind", async () => {
    const file = join(root, "state.json")
    await writeFile(file, JSON.stringify(mixedState()))

    const program = Effect.gen(function* () {
      const store = yield* StateStore
      yield* breakWrites(file)
      yield* Effect.either(
        store.update((s) => {
          s.tasks.push({ ...s.tasks[0]!, id: "ghost" })
          return Either.right(undefined)
        }),
      )
      yield* mendWrites(file)
    })
    await Effect.runPromise(program.pipe(Effect.provide(storeLayer(root))))

    expect((await readdir(root)).filter((name) => name.endsWith(".tmp"))).toEqual([])
  })

  test("a rejected update restores nested values in place, so references held across it stay valid", async () => {
    const file = join(root, "state.json")
    await writeFile(file, JSON.stringify(mixedState()))
    // The protocol types are not needed here: the test only needs an object nested inside a task.
    const nestedOf = (s: Readonly<StoreState>) => (s.tasks[0] as unknown as { checkouts: Array<Record<string, unknown>> }).checkouts

    const program = Effect.gen(function* () {
      const store = yield* StateStore
      yield* store.update((s) => {
        (s.tasks[0] as unknown as { checkouts: Array<Record<string, unknown>> }).checkouts.push({ id: "c1", branch: "original" })
        return Either.right(undefined)
      })
      const list = nestedOf(yield* store.read)
      const checkout = list[0]!

      const rejected = yield* Effect.either(
        store.update((s) => {
          const nested = (s.tasks[0] as unknown as { checkouts: Array<Record<string, unknown>> }).checkouts
          nested[0]!.branch = "rejected"
          nested.push({ id: "c2", branch: "rejected" })
          return Either.left("nope" as const)
        }),
      )
      expect(Either.isLeft(rejected)).toBe(true)
      expect(nestedOf(yield* store.read)).toBe(list)
      expect(list[0]).toBe(checkout)
      expect(checkout.branch).toBe("original")
      expect(list.map((c) => c.id)).toEqual(["c1"])
    })
    await Effect.runPromise(program.pipe(Effect.provide(storeLayer(root))))
  })

  test("a failed write restores nested values in place too", async () => {
    const file = join(root, "state.json")
    await writeFile(file, JSON.stringify(mixedState()))
    const nestedOf = (s: Readonly<StoreState>) => (s.tasks[0] as unknown as { checkouts: Array<Record<string, unknown>> }).checkouts

    const program = Effect.gen(function* () {
      const store = yield* StateStore
      yield* store.update((s) => {
        (s.tasks[0] as unknown as { checkouts: Array<Record<string, unknown>> }).checkouts.push({ id: "c1", branch: "original" })
        return Either.right(undefined)
      })
      yield* store.flush
      const list = nestedOf(yield* store.read)
      const checkout = list[0]!
      yield* breakWrites(file)

      const failed = yield* Effect.either(
        store.update((s) => {
          const nested = (s.tasks[0] as unknown as { checkouts: Array<Record<string, unknown>> }).checkouts
          nested[0]!.branch = "never saved"
          nested.splice(0, 1)
          return Either.right(undefined)
        }),
      )
      expect(Either.isLeft(failed)).toBe(true)
      expect(nestedOf(yield* store.read)).toBe(list)
      expect(list[0]).toBe(checkout)
      expect(checkout.branch).toBe("original")
      yield* mendWrites(file)
    })
    await Effect.runPromise(program.pipe(Effect.provide(storeLayer(root))))
  })

  test("concurrent updates run in order, and a rejected one never rides along in a later write", async () => {
    const file = join(root, "state.json")
    await writeFile(file, JSON.stringify(mixedState()))

    const program = Effect.gen(function* () {
      const store = yield* StateStore
      yield* Effect.all(
        [
          Effect.either(
            store.update((s) => {
              s.tasks[0]!.title = "rejected"
              return Either.left("nope" as const)
            }),
          ),
          Effect.either(
            store.update((s) => {
              s.tasks.push({ ...s.tasks[0]!, id: "kept" })
              return Either.right(undefined)
            }),
          ),
        ],
        { concurrency: "unbounded" },
      )
      yield* store.flush
      expect((yield* store.read).tasks[0]!.title).toBe("thread supported-thread")
    })
    await Effect.runPromise(program.pipe(Effect.provide(storeLayer(root))))

    const reloaded = await loadState(root)
    expect(reloaded.tasks[0]!.title).toBe("thread supported-thread")
    expect(reloaded.tasks.map((t) => t.id)).toEqual(["supported-thread", "retired-thread", "kept"])
  })
})

// Removing read permission from the state directory keeps rename and temp-file creation working (both need write and
// search) while opening the directory for its sync fails: the real fault a directory fsync error produces after the
// rename has already landed. Root ignores directory permissions, so the case is skipped there and on Windows.
describe("directory sync failure after the rename", () => {
  let root: string
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "kestrel-state-"))
  })
  afterEach(async () => {
    await chmod(root, 0o755).catch(() => undefined)
    await rm(root, { recursive: true, force: true })
  })

  const canSimulate = process.platform !== "win32" && process.getuid?.() !== 0

  test.skipIf(!canSimulate)("reports the outcome as unconfirmed, keeps the new state in memory and on disk", async () => {
    const file = join(root, "state.json")
    await writeFile(file, JSON.stringify(mixedState()))

    const program = Effect.gen(function* () {
      const store = yield* StateStore
      yield* Effect.promise(() => chmod(root, 0o300))

      const outcome = yield* Effect.either(
        store.update((s) => {
          s.tasks.push({ ...s.tasks[0]!, id: "landed" })
          return Either.right(undefined)
        }),
      )
      expect(Either.isLeft(outcome)).toBe(true)
      if (Either.isLeft(outcome)) {
        expect(outcome.left._tag).toBe("InternalError")
        expect(outcome.left.message).toContain("applied and visible")
        expect(outcome.left.message).toContain("durability unconfirmed")
      }
      // The rename landed, so memory matches the file rather than rolling back to the old state.
      expect((yield* store.read).tasks.map((t) => t.id)).toEqual(["supported-thread", "retired-thread", "landed"])

      yield* Effect.promise(() => chmod(root, 0o755))
      const names = yield* Effect.promise(() => readdir(root))
      expect(names.filter((name) => name.endsWith(".tmp"))).toEqual([])
      // A later update still succeeds once the directory can be synced again.
      yield* store.update((s) => {
        s.tasks.push({ ...s.tasks[0]!, id: "after" })
        return Either.right(undefined)
      })
      yield* store.flush
    })
    await Effect.runPromise(program.pipe(Effect.provide(storeLayer(root))))

    const reloaded = await loadState(root)
    expect(reloaded.tasks.map((t) => t.id)).toEqual(["supported-thread", "retired-thread", "landed", "after"])
  })
})

describe("restart reconciliation", () => {
  let root: string
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "kestrel-state-reconcile-"))
  })
  afterEach(async () => {
    await rm(root, { recursive: true, force: true })
  })

  const runningRun = (id: string, taskId: string): Record<string, unknown> => ({
    ...run(id, taskId, {}),
    status: "running",
    endedAt: null,
    exitCode: null,
  })

  test("a run that was live is a restart interruption and its thread failed", async () => {
    const file = join(root, "state.json")
    await writeFile(file, JSON.stringify({
      tasks: [{ ...task("live"), status: "running" }],
      messages: [], pendingAsks: [], uploads: [], runSessions: [],
      runs: [runningRun("r1", "live")],
    }))

    const state = await loadState(root)

    expect(state.tasks[0]?.status).toBe("failed")
    expect(state.runs[0]).toMatchObject({ status: "failed", interruptedByRestart: true })
    expect(state.runs[0]?.endedAt).not.toBeNull()
  })

  test("a thread still marked running with no run behind it is failed", async () => {
    const file = join(root, "state.json")
    await writeFile(file, JSON.stringify({
      tasks: [{ ...task("orphan"), status: "running" }],
      messages: [], runs: [], pendingAsks: [], uploads: [], runSessions: [],
    }))

    const state = await loadState(root)

    expect(state.tasks[0]?.status).toBe("failed")
  })

  test("a question that survived the restart keeps its thread in needs_input", async () => {
    const file = join(root, "state.json")
    await writeFile(file, JSON.stringify({
      tasks: [{ ...task("asking"), status: "needs_input" }],
      messages: [message("q", "asking", "r1", "agent", "Which option?")],
      pendingAsks: [{ taskId: "asking", runId: "r1", messageId: "q" }],
      uploads: [], runSessions: [],
      runs: [runningRun("r1", "asking")],
    }))

    const state = await loadState(root)

    expect(state.tasks[0]?.status).toBe("needs_input")
    expect(state.pendingAsks).toEqual([{ taskId: "asking", runId: "r1", messageId: "q" }])
    expect(state.runs[0]).toMatchObject({ status: "failed", interruptedByRestart: true })
  })

  test("needs_input without a question and without a run is normalized to idle", async () => {
    const file = join(root, "state.json")
    await writeFile(file, JSON.stringify({
      tasks: [{ ...task("stale"), status: "needs_input" }],
      messages: [], runs: [], pendingAsks: [], uploads: [], runSessions: [],
    }))

    const state = await loadState(root)

    expect(state.tasks[0]?.status).toBe("idle")
    expect(state.pendingAsks).toEqual([])
  })

  test("needs_input without a question but with a live run is failed with that run", async () => {
    const file = join(root, "state.json")
    await writeFile(file, JSON.stringify({
      tasks: [{ ...task("stale-live"), status: "needs_input" }],
      messages: [], pendingAsks: [], uploads: [], runSessions: [],
      runs: [runningRun("r1", "stale-live")],
    }))

    const state = await loadState(root)

    expect(state.tasks[0]?.status).toBe("failed")
    expect(state.runs[0]).toMatchObject({ status: "failed", interruptedByRestart: true })
  })
})
