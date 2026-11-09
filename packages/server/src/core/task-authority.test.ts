import { expect, test } from "bun:test"
import { mkdir, mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Effect, Either, Fiber, Layer, Option } from "effect"
import { InternalError } from "@cloudagents/protocol"
import { Config, type ServerConfig } from "../config"
import { DesktopManager } from "../desktop"
import { CredentialStore } from "../credentials"
import { CliAuth } from "../cliauth"
import { CredentialBroker } from "../broker"
import { GitHub } from "../github/api"
import { AgentHarness, type AgentChoice } from "./harness"
import { EventHubLive } from "./events"
import { CoreLive, CoreService, type CoreShape } from "./service"
import { StateLive, StateStore, type StoreShape, type StoreState, type UpdateOutcome } from "./state"
import { WorkspaceService } from "./workspace"

const configOf = (root: string): ServerConfig => ({
  port: 8897, host: "127.0.0.1", sandboxPort: 8897, mcpBaseUrl: "http://127.0.0.1:8897", dataDir: root,
  stateFile: join(root, "state.json"), mirrorsDir: join(root, "mirrors"), threadsDir: join(root, "threads"),
  shadowsDir: join(root, "shadows"), runsDir: join(root, "runs"), attachmentsDir: join(root, "attachments"), homesDir: join(root, "homes"),
  agentCommands: { anthropic: "", openai: "", openrouter: "", zai: "", deepseek: "", minimax: "", moonshot: "", opencode: "", "opencode-go": "", google: "", devin: "" }, agentRouteCommands: { claude: "", codex: "", opencode: "" }, fakeAgent: false, fakeAgentRoBinds: [], sandbox: "off", sandboxPath: null,
  nest: null,
  sandboxSslCertFile: null, systemd: null, maxConcurrentRuns: 2, relay: null, direct: null, toolkitsFlake: null,
  taskDiskMax: 1024 ** 3, githubApiUrl: "https://api.github.com",
  webrtc: { iceServers: [], turn: null, policy: "all", portRange: null, hostAddresses: [], denyPrivate: false },
})

/** The core over `store`, with a harness that starts no agent: it only records each run's choice. */
const coreLayer = (config: ServerConfig, choices: AgentChoice[], store: Layer.Layer<StateStore, InternalError>) => {
  const configLayer = Layer.succeed(Config, config)
  const workspaceLayer = Layer.succeed(WorkspaceService, {} as never)
  const deps = Layer.mergeAll(
    configLayer, store, EventHubLive,
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
      cancel: (id: string) => Effect.flatMap(StateStore, (state) => state.update((s) => {
        const run = s.runs.find((r) => r.id === id)
        if (run?.status === "running") { run.status = "cancelled"; run.endedAt = new Date().toISOString() }
        return Either.right(undefined)
      })),
      abort: () => Effect.void, stopAll: () => Effect.void, items: () => Effect.succeed([]), itemCount: () => 0,
    } as never),
  )
  return CoreLive.pipe(Layer.provide(deps), Layer.provideMerge(deps))
}

interface GatedStore {
  readonly store: StoreShape
  readonly holdNext: () => { readonly entered: Promise<void>; readonly release: () => void }
}

/**
 * An in-memory store whose next update can be held after it is queued: the test uses it to pause a question
 * between its call's entry and the commit of its row (the window where the waiter used to be registered).
 */
const makeGatedStore = (): GatedStore => {
  const state: StoreState = { tasks: [], messages: [], runs: [], pendingAsks: [], uploads: [], runSessions: [], settledRuns: [] }
  let hold: { readonly release: Promise<void>; readonly markEntered: () => void } | null = null
  const apply = <A, E>(f: (s: StoreState) => Either.Either<A, E>): Effect.Effect<A, E | InternalError> => {
    const result = f(state)
    return Either.isLeft(result) ? Effect.fail(result.left) : Effect.succeed(result.right)
  }
  const update = <A, E>(f: (s: StoreState) => Either.Either<A, E>): Effect.Effect<A, E | InternalError> =>
    Effect.suspend(() => {
      const gate = hold
      if (gate === null) return apply(f)
      hold = null
      return Effect.promise(async () => {
        gate.markEntered()
        await gate.release
      }).pipe(Effect.zipRight(Effect.suspend(() => apply(f))))
    })
  const store: StoreShape = {
    read: Effect.sync(() => state),
    update,
    updateOutcome: <A, E>(f: (s: StoreState) => Either.Either<A, E>): Effect.Effect<UpdateOutcome<A>, E | InternalError> =>
      Effect.map(update(f), (value): UpdateOutcome<A> => ({ _tag: "applied", value })),
    flush: Effect.void,
  }
  const holdNext = () => {
    const entered = Promise.withResolvers<void>()
    const release = Promise.withResolvers<void>()
    hold = { markEntered: entered.resolve, release: release.promise }
    return { entered: entered.promise, release: release.resolve }
  }
  return { store, holdNext }
}

const withCore = async (body: (h: { readonly store: StoreShape; readonly core: CoreShape; readonly config: ServerConfig }) => Effect.Effect<void, unknown>): Promise<void> => {
  const root = await mkdtemp(join(tmpdir(), "kestrel-task-authority-"))
  const config = configOf(root)
  const configLayer = Layer.succeed(Config, config)
  const workspaceLayer = Layer.succeed(WorkspaceService, {} as never)
  const store = StateLive.pipe(Layer.provide(Layer.merge(configLayer, workspaceLayer)))
  try {
    await Effect.runPromise(Effect.gen(function* () {
      const state = yield* StateStore
      const core = yield* CoreService
      yield* body({ store: state, core, config })
    }).pipe(Effect.provide(coreLayer(config, [], store))))
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}

const withGatedCore = async (
  body: (h: { readonly store: StoreShape; readonly core: CoreShape; readonly config: ServerConfig; readonly gated: GatedStore }) => Effect.Effect<void, unknown>,
): Promise<void> => {
  const root = await mkdtemp(join(tmpdir(), "kestrel-task-authority-gated-"))
  const config = configOf(root)
  const gated = makeGatedStore()
  try {
    await Effect.runPromise(Effect.gen(function* () {
      const core = yield* CoreService
      yield* body({ store: gated.store, core, config, gated })
    }).pipe(Effect.provide(coreLayer(config, [], Layer.succeed(StateStore, gated.store)))))
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

/** Waits until the store shows a pending ask (the ask call posts it just before it starts waiting). */
const waitForAsk = (store: StoreShape) =>
  Effect.gen(function* () {
    for (let i = 0; i < 100; i++) {
      const state = yield* store.read
      if (state.pendingAsks.length > 0) return
      yield* Effect.sleep("10 millis")
    }
    throw new Error("the ask did not post its question")
  })

/** Waits until the store holds a question with `text`; returns its pending ask row. */
const waitForQuestion = (store: StoreShape, text: string) =>
  Effect.gen(function* () {
    for (let i = 0; i < 100; i++) {
      const state = yield* store.read
      const message = state.messages.find((m) => m.text === text)
      const ask = message === undefined ? undefined : state.pendingAsks.find((a) => a.messageId === message.id)
      if (ask !== undefined) return ask
      yield* Effect.sleep("10 millis")
    }
    throw new Error(`the ask never posted "${text}"`)
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

test("an answer to an abandoned question cannot resolve the question waiting behind it", () => withGatedCore(({ store, core, gated }) =>
  Effect.gen(function* () {
    yield* seedTask(store)
    const { run } = yield* core.sendMessage("owner", "task", "hello", {}, [], false)
    const now = new Date().toISOString()
    // Question A's call is gone (abandoned) while its pending row is still visible.
    yield* store.update((s) => {
      s.messages.push({ id: "question-a", taskId: "task", runId: run.id, role: "agent", text: "Question A", options: ["A"], createdAt: now })
      s.pendingAsks.push({ taskId: "task", runId: run.id, messageId: "question-a" })
      return Either.right(undefined)
    })

    // Hold the next update after the ask call entered: this is the window between entry and B's committed question
    // (in production, attachment persistence yields here).
    const gate = gated.holdNext()
    const asking = yield* Effect.fork(core.ask("task", run.id, { question: "Question B", options: ["B"] }))
    yield* Effect.promise(() => gate.entered)

    // The user answers A while B's question is still uncommitted. B is not waiting for that question.
    yield* core.sendMessage("owner", "task", "Answer A", {}, [], false)
    gate.release()

    const pending = yield* waitForQuestion(store, "Question B")
    expect(pending.messageId).not.toBe("question-a")
    // B's call is still waiting: A's answer did not resolve it.
    expect(Option.isNone(yield* Fiber.poll(asking))).toBe(true)

    // Only B's own answer resolves it, and it returns that answer rather than A's.
    yield* core.sendMessage("owner", "task", "Answer B", {}, [], false)
    expect(yield* Fiber.join(asking)).toBe("Answer B")
    expect((yield* store.read).pendingAsks).toEqual([])
  })), 20_000)
