import { expect, test } from "bun:test"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
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
import { CoreLive, CoreService, type CoreShape } from "./service"
import { StateLive, StateStore, type StoreShape } from "./state"
import { WorkspaceService } from "./workspace"

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

/** A thread whose last run failed and armed both a usage-limit resume and an automatic retry. */
const seed = async (config: ServerConfig) => {
  const now = Date.now()
  const at = new Date(now - 60_000).toISOString()
  await writeFile(
    config.stateFile,
    JSON.stringify({
      tasks: [
        {
          id: "retry", owner: "owner", title: "Retry", status: "failed", createdAt: at, updatedAt: at, checkouts: [],
          usageLimitResume: { runId: "failed", resetsAt: new Date(now + 60_000).toISOString(), autoResume: true },
          autoRetry: { runId: "failed", attempt: 1, nextAt: new Date(now + 60_000).toISOString() },
        },
        {
          id: "cancel", owner: "owner", title: "Cancel", status: "idle", createdAt: at, updatedAt: at, checkouts: [],
        },
      ],
      runs: [
        { id: "failed", taskId: "retry", prompt: "do it", status: "failed", startedAt: at, endedAt: at, exitCode: 1, provider: "anthropic", model: "claude-opus-5-5", effort: null },
        { id: "old", taskId: "cancel", prompt: "earlier", status: "failed", startedAt: at, endedAt: at, exitCode: 1, provider: "anthropic", model: "claude-opus-5-5", effort: null },
      ],
      messages: [
        { id: "retry-prompt", taskId: "retry", role: "user", text: "do it", runId: "failed", createdAt: at },
        { id: "cancel-prompt", taskId: "cancel", role: "user", text: "earlier", runId: "old", createdAt: at },
      ],
    }),
  )
}

const withCore = async (body: (core: CoreShape, store: StoreShape) => Effect.Effect<void, unknown>) => {
  const root = await mkdtemp(join(tmpdir(), "kestrel-arms-"))
  const config = configOf(root)
  await seed(config)
  const configLayer = Layer.succeed(Config, config)
  const workspaceLayer = Layer.succeed(WorkspaceService, {} as never)
  const deps = Layer.mergeAll(
    configLayer, StateLive.pipe(Layer.provide(Layer.merge(configLayer, workspaceLayer))), EventHubLive,
    Layer.succeed(DesktopManager, { watchStatus: () => Effect.void, status: () => Effect.succeed({ state: "stopped", display: null }), stopAll: () => Effect.void } as never),
    workspaceLayer, Layer.succeed(CredentialStore, {} as never),
    Layer.succeed(GitHub, {} as never), Layer.succeed(CliAuth, {} as never), Layer.succeed(CredentialBroker, {} as never),
    Layer.succeed(AgentHarness, {
      spawn: (_task: unknown, _run: unknown, _start: RunStart, _display: unknown, _user: unknown, _choice: AgentChoice) => Effect.void,
      steer: () => Effect.succeed({ accepted: true, afterItems: 0 }),
      cancel: () => Effect.void,
      stopAll: () => Effect.void, items: () => Effect.succeed([]), itemCount: () => 0,
    } as never),
  )
  try {
    await Effect.runPromise(
      Effect.gen(function* () {
        const store = yield* StateStore
        const core = yield* CoreService
        yield* body(core, store)
      }).pipe(Effect.provide(CoreLive.pipe(Layer.provide(deps), Layer.provideMerge(deps)))),
    )
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}

test("a user message that starts a new run clears the previous failure's recovery arms immediately", async () => {
  await withCore((core, store) => Effect.gen(function* () {
    const { run } = yield* core.sendMessage("owner", "retry", "Try again", { model: "claude-opus-5-5" }, [], false)
    expect(run.status).toBe("running")
    const state = yield* store.read
    const stored = state.tasks.find((t) => t.id === "retry")!
    expect(stored.status).toBe("running")
    expect(stored.usageLimitResume).toBeUndefined()
    expect(stored.autoRetry).toBeUndefined()
  }))
})

test("cancelling a run clears recovery arms left by an earlier failure", async () => {
  await withCore((core, store) => Effect.gen(function* () {
    const { run } = yield* core.sendMessage("owner", "cancel", "Keep going", { model: "claude-opus-5-5" }, [], false)
    // Arms for the previous failure survive until something settles them; cancelling the live run must drop them.
    yield* store.update((s) => {
      const task = s.tasks.find((t) => t.id === "cancel")!
      task.usageLimitResume = { runId: "old", resetsAt: new Date(Date.now() + 60_000).toISOString(), autoResume: true }
      task.autoRetry = { runId: "old", attempt: 1, nextAt: new Date(Date.now() + 60_000).toISOString() }
      return Either.right(undefined)
    })
    yield* core.cancelRun("owner", run.id)
    const state = yield* store.read
    const stored = state.tasks.find((t) => t.id === "cancel")!
    expect(stored.usageLimitResume).toBeUndefined()
    expect(stored.autoRetry).toBeUndefined()
  }))
})
