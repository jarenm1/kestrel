import { expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Effect, Either, Layer } from "effect"
import { Config, type ServerConfig } from "../config"
import { CliAuth } from "../cliauth"
import { CredentialBroker } from "../broker"
import { CredentialStore } from "../credentials"
import { DesktopManager } from "../desktop"
import { GitHub } from "../github/api"
import { AgentHarness, type AgentChoice, type RunStart } from "./harness"
import { EventHubLive } from "./events"
import { CoreLive, CoreService } from "./service"
import { StateLive, StateStore, type StoreShape } from "./state"
import { WorkspaceService } from "./workspace"

const configOf = (root: string): ServerConfig => ({
  port: 8899, host: "127.0.0.1", sandboxPort: 8899, mcpBaseUrl: "http://127.0.0.1:8899", dataDir: root,
  stateFile: join(root, "state.json"), mirrorsDir: join(root, "mirrors"), threadsDir: join(root, "threads"),
  shadowsDir: join(root, "shadows"), runsDir: join(root, "runs"), attachmentsDir: join(root, "attachments"), homesDir: join(root, "homes"),
  agentCommands: { anthropic: "", openai: "", openrouter: "", zai: "", deepseek: "", minimax: "", moonshot: "", opencode: "", "opencode-go": "", google: "" }, agentRouteCommands: { claude: "", codex: "", opencode: "" }, fakeAgent: false, fakeAgentRoBinds: [], sandbox: "off", sandboxPath: null,
  nest: null,
  sandboxSslCertFile: null, systemd: null, maxConcurrentRuns: 2, relay: null, direct: null, toolkitsFlake: null,
  taskDiskMax: 1024 ** 3, githubApiUrl: "https://api.github.com",
  webrtc: { iceServers: [], turn: null, policy: "all", portRange: null, hostAddresses: [], denyPrivate: false },
})

const layersOf = (config: ServerConfig, testStore: () => StoreShape | undefined, spawned: AgentChoice[]) => {
  const configLayer = Layer.succeed(Config, config)
  const workspaceLayer = Layer.succeed(WorkspaceService, {} as never)
  const deps = Layer.mergeAll(
    configLayer, StateLive.pipe(Layer.provide(Layer.merge(configLayer, workspaceLayer))), EventHubLive,
    Layer.succeed(DesktopManager, { watchStatus: () => Effect.void, status: () => Effect.succeed({ state: "stopped", display: null }), stopAll: () => Effect.void } as never),
    workspaceLayer, Layer.succeed(CredentialStore, {} as never),
    Layer.succeed(GitHub, {} as never), Layer.succeed(CliAuth, {} as never), Layer.succeed(CredentialBroker, {} as never),
    Layer.succeed(AgentHarness, {
      spawn: (_task: unknown, _run: unknown, _start: RunStart, _display: unknown, _user: unknown, choice: AgentChoice) =>
        Effect.sync(() => void spawned.push(choice)),
      steer: () => Effect.succeed({ accepted: true, afterItems: 0 }),
      cancel: (id: string) => testStore()!.update((s) => {
        const run = s.runs.find((r) => r.id === id)
        if (run?.status === "running") {
          run.status = "cancelled"
          run.endedAt = new Date().toISOString()
        }
        return Either.right(undefined)
      }),
      stopAll: () => Effect.void, items: () => Effect.succeed([]), itemCount: () => 0,
    } as never),
  )
  return CoreLive.pipe(Layer.provide(deps), Layer.provideMerge(deps))
}

/** Let the immediate recovery sweep finish, so a test's own arms are not examined by it. Its next tick is 5s away. */
const settleInitialSweep = Effect.sleep("50 millis")

test("a user message clears the pending usage-limit resume and auto-retry in the same update that starts the run", async () => {
  const root = await mkdtemp(join(tmpdir(), "kestrel-lifecycle-"))
  const spawned: AgentChoice[] = []
  let testStore: StoreShape | undefined
  try {
    await Effect.runPromise(
      Effect.gen(function* () {
        const store = yield* StateStore
        testStore = store
        const core = yield* CoreService
        yield* settleInitialSweep
        const at = new Date(Date.now() - 60_000).toISOString()
        yield* store.update((s) => {
          s.tasks.push({ id: "task", owner: "owner", title: "Thread", status: "failed", createdAt: at, updatedAt: at, checkouts: [] })
          s.runs.push({ id: "run", taskId: "task", prompt: "Do the work", status: "failed", startedAt: at, endedAt: at, exitCode: 1, provider: "anthropic", model: "claude-opus-5-5", effort: null })
          s.tasks[0]!.autoRetry = { runId: "run", attempt: 1, nextAt: new Date(Date.now() + 60_000).toISOString() }
          s.tasks[0]!.usageLimitResume = { runId: "run", resetsAt: new Date(Date.now() + 60_000).toISOString(), autoResume: true }
          return Either.right(undefined)
        })

        const sent = yield* core.sendMessage("owner", "task", "Try once more", { model: "claude-opus-5-5" }, [], false)
        const state = yield* store.read
        expect(state.tasks[0]!.status).toBe("running")
        expect(state.tasks[0]!.autoRetry).toBeUndefined()
        expect(state.tasks[0]!.usageLimitResume).toBeUndefined()
        expect(sent.run).toMatchObject({ taskId: "task", status: "running" })
        expect(spawned).toHaveLength(1)
      }).pipe(Effect.provide(layersOf(configOf(root), () => testStore, spawned))),
    )
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("cancelling a run clears the thread's pending usage-limit resume and auto-retry", async () => {
  const root = await mkdtemp(join(tmpdir(), "kestrel-lifecycle-"))
  const spawned: AgentChoice[] = []
  let testStore: StoreShape | undefined
  try {
    await Effect.runPromise(
      Effect.gen(function* () {
        const store = yield* StateStore
        testStore = store
        const core = yield* CoreService
        yield* settleInitialSweep
        const at = new Date().toISOString()
        yield* store.update((s) => {
          s.tasks.push({ id: "task", owner: "owner", title: "Thread", status: "running", createdAt: at, updatedAt: at, checkouts: [] })
          s.runs.push({ id: "run", taskId: "task", prompt: "Do the work", status: "running", startedAt: at, endedAt: null, exitCode: null, provider: "anthropic", model: "claude-opus-5-5", effort: null })
          // Stale arms a stopped run must not leave behind.
          s.tasks[0]!.autoRetry = { runId: "run", attempt: 1, nextAt: new Date(Date.now() + 60_000).toISOString() }
          s.tasks[0]!.usageLimitResume = { runId: "run", resetsAt: new Date(Date.now() + 60_000).toISOString(), autoResume: true }
          return Either.right(undefined)
        })

        const cancelled = yield* core.cancelRun("owner", "run")
        const state = yield* store.read
        expect(cancelled.status).toBe("cancelled")
        expect(state.tasks[0]!.autoRetry).toBeUndefined()
        expect(state.tasks[0]!.usageLimitResume).toBeUndefined()
      }).pipe(Effect.provide(layersOf(configOf(root), () => testStore, spawned))),
    )
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
