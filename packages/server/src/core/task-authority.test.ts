import { expect, test } from "bun:test"
import { mkdir, mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Effect, Either, Fiber, Layer } from "effect"
import { Config, type ServerConfig } from "../config"
import { DesktopManager } from "../desktop"
import { CredentialStore } from "../credentials"
import { CliAuth } from "../cliauth"
import { CredentialBroker } from "../broker"
import { GitHub } from "../github/api"
import { AgentHarness, type AgentChoice } from "./harness"
import { EventHubLive } from "./events"
import { CoreLive, CoreService, type CoreShape } from "./service"
import { StateLive, StateStore, type StoreShape } from "./state"
import { WorkspaceService } from "./workspace"

interface Harnessed {
  readonly store: StoreShape
  readonly core: CoreShape
  readonly config: ServerConfig
  readonly choices: AgentChoice[]
}

/** Runs `body` against the real core over a fresh store. The harness starts no agent: it only records each run's choice. */
const withCore = async (body: (h: Harnessed) => Effect.Effect<void, unknown>): Promise<void> => {
  const root = await mkdtemp(join(tmpdir(), "kestrel-task-authority-"))
  const config: ServerConfig = {
    port: 8897, host: "127.0.0.1", sandboxPort: 8897, mcpBaseUrl: "http://127.0.0.1:8897", dataDir: root,
    stateFile: join(root, "state.json"), mirrorsDir: join(root, "mirrors"), threadsDir: join(root, "threads"),
    shadowsDir: join(root, "shadows"), runsDir: join(root, "runs"), attachmentsDir: join(root, "attachments"), homesDir: join(root, "homes"),
    agentCommands: { anthropic: "", openai: "", openrouter: "", zai: "", deepseek: "", minimax: "", moonshot: "", opencode: "", "opencode-go": "", google: "", devin: "" }, agentRouteCommands: { claude: "", codex: "", opencode: "" }, fakeAgent: false, fakeAgentRoBinds: [], sandbox: "off", sandboxPath: null,
    nest: null,
    sandboxSslCertFile: null, systemd: null, maxConcurrentRuns: 2, relay: null, direct: null, toolkitsFlake: null,
    taskDiskMax: 1024 ** 3, githubApiUrl: "https://api.github.com",
    webrtc: { iceServers: [], turn: null, policy: "all", portRange: null, hostAddresses: [], denyPrivate: false },
  }
  const choices: AgentChoice[] = []
  let testStore: StoreShape | undefined
  const configLayer = Layer.succeed(Config, config)
  const workspaceLayer = Layer.succeed(WorkspaceService, {} as never)
  const deps = Layer.mergeAll(
    configLayer, StateLive.pipe(Layer.provide(Layer.merge(configLayer, workspaceLayer))), EventHubLive,
    Layer.succeed(DesktopManager, {
      watchStatus: () => Effect.void,
      status: () => Effect.succeed({ state: "stopped", display: null }),
      stop: () => Effect.void,
      stopAll: () => Effect.void,
    } as never),
    workspaceLayer, Layer.succeed(CredentialStore, {} as never),
    Layer.succeed(GitHub, {} as never), Layer.succeed(CliAuth, {} as never),
    Layer.succeed(CredentialBroker, {} as never),
    Layer.succeed(AgentHarness, {
      spawn: (_task: unknown, _run: unknown, _start: unknown, _display: unknown, _user: unknown, choice: AgentChoice) => Effect.sync(() => { choices.push(choice) }),
      steer: () => Effect.succeed({ accepted: true, afterItems: 0 }),
      cancel: (id: string) => testStore!.update((s) => {
        const run = s.runs.find((r) => r.id === id)
        if (run?.status === "running") { run.status = "cancelled"; run.endedAt = new Date().toISOString() }
        return Either.right(undefined)
      }),
      abort: () => Effect.void, stopAll: () => Effect.void, items: () => Effect.succeed([]), itemCount: () => 0,
    } as never),
  )
  try {
    await Effect.runPromise(Effect.gen(function* () {
      const store = yield* StateStore
      testStore = store
      const core = yield* CoreService
      yield* body({ store, core, config, choices })
    }).pipe(Effect.provide(CoreLive.pipe(Layer.provide(deps), Layer.provideMerge(deps)))))
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}

const seedTask = (store: StoreShape) =>
  store.update((s) => {
    const now = new Date().toISOString()
    s.tasks.push({ id: "task", owner: "owner", title: "Task", status: "idle", createdAt: now, updatedAt: now, checkouts: [] })
    return Either.right(undefined)
  })

/** Waits until the store shows a pending ask (the ask call posts it before it starts waiting). */
const waitForAsk = (store: StoreShape) =>
  Effect.gen(function* () {
    for (let i = 0; i < 100; i++) {
      const state = yield* store.read
      if (state.pendingAsks.length > 0) return
      yield* Effect.sleep("10 millis")
    }
    throw new Error("the ask did not post its question")
  })

test("a live run's terminal report is advisory, and needs_input needs a question", () => withCore(({ store, core }) =>
  Effect.gen(function* () {
    yield* seedTask(store)
    const { run } = yield* core.sendMessage("owner", "task", "hello", {}, [], false)
    const status = () => Effect.map(store.read, (s) => s.tasks.find((t) => t.id === "task")?.status)

    // A terminal report mid-run does not move the status; its message still reaches the thread.
    yield* core.report("task", run.id, { status: "done", message: "All done" })
    expect(yield* status()).toBe("running")
    yield* core.report("task", run.id, { status: "failed", message: "It broke" })
    expect(yield* status()).toBe("running")
    expect((yield* store.read).messages.map((m) => m.text)).toContain("All done")

    // `needs_input` without a pending ask is only a message, never a phase.
    yield* core.report("task", run.id, { status: "needs_input", message: "I need something" })
    expect(yield* status()).toBe("running")
    expect((yield* store.read).pendingAsks).toEqual([])

    // A question enters needs_input, and no terminal report or second question can move it.
    const asking = yield* Effect.fork(core.ask("task", run.id, { question: "Which option?", options: ["A", "B"] }))
    yield* waitForAsk(store)
    expect(yield* status()).toBe("needs_input")
    yield* core.report("task", run.id, { status: "done", message: "Still working" })
    expect(yield* status()).toBe("needs_input")
    expect(Either.isLeft(yield* Effect.either(core.ask("task", run.id, { question: "Again?", options: [] })))).toBe(true)

    // The user's reply is the answer: the ask call returns it and the thread is running again.
    yield* core.sendMessage("owner", "task", "A", {}, [], false)
    expect(yield* Fiber.join(asking)).toBe("A")
    expect(yield* status()).toBe("running")
    expect((yield* store.read).pendingAsks).toEqual([])
    yield* core.report("task", run.id, { status: "needs_input", message: "Nothing is pending now" })
    expect(yield* status()).toBe("running")
  })), 20_000)

test("an ask whose state write fails leaves no phantom waiting call", () => withCore(({ store, core, config }) =>
  Effect.gen(function* () {
    yield* seedTask(store)
    const { run } = yield* core.sendMessage("owner", "task", "hello", {}, [], false)
    yield* store.flush
    // A directory where the state file belongs makes the rename fail: the ask's write is not applied.
    yield* Effect.promise(async () => {
      await rm(config.stateFile, { force: true })
      await mkdir(config.stateFile)
    })
    const failed = yield* Effect.either(core.ask("task", run.id, { question: "First?", options: [] }))
    expect(Either.isLeft(failed)).toBe(true)
    expect((yield* store.read).pendingAsks).toEqual([])
    yield* Effect.promise(() => rm(config.stateFile, { recursive: true, force: true }))

    // The rolled-back call left no waiter behind: the next question posts, waits and is answered normally.
    const asking = yield* Effect.fork(core.ask("task", run.id, { question: "Second?", options: ["B"] }))
    yield* waitForAsk(store)
    yield* core.sendMessage("owner", "task", "B", {}, [], false)
    expect(yield* Fiber.join(asking)).toBe("B")
    expect((yield* store.read).pendingAsks).toEqual([])
  })), 20_000)
