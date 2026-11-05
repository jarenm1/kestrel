import { expect, test } from "bun:test"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Effect, Layer } from "effect"
import { Config, type ServerConfig } from "../config"
import { CliAuth } from "../cliauth"
import { CredentialBroker } from "../broker"
import { CredentialStore } from "../credentials"
import { DesktopManager } from "../desktop"
import { GitHub } from "../github/api"
import { AgentHarness, type AgentChoice, type RunStart } from "./harness"
import { EventHubLive } from "./events"
import { CoreLive, CoreService } from "./service"
import { StateLive, StateStore } from "./state"
import { WorkspaceService } from "./workspace"

const configOf = (root: string): ServerConfig => ({
  port: 8899, host: "127.0.0.1", sandboxPort: 8899, mcpBaseUrl: "http://127.0.0.1:8899", dataDir: root,
  stateFile: join(root, "state.json"), mirrorsDir: join(root, "mirrors"), threadsDir: join(root, "threads"),
  shadowsDir: join(root, "shadows"), runsDir: join(root, "runs"), attachmentsDir: join(root, "attachments"), homesDir: join(root, "homes"),
  agentCommands: { anthropic: "", openai: "", openrouter: "", zai: "", deepseek: "", minimax: "", moonshot: "", opencode: "", "opencode-go": "", google: "" }, fakeAgent: false, fakeAgentRoBinds: [], sandbox: "off", sandboxPath: null,
  nest: null,
  sandboxSslCertFile: null, systemd: null, maxConcurrentRuns: 2, relay: null, direct: null, toolkitsFlake: null,
  taskDiskMax: 1024 ** 3, githubApiUrl: "https://api.github.com",
  webrtc: { iceServers: [], turn: null, policy: "all", portRange: null, hostAddresses: [], denyPrivate: false },
})

test("a due retry starts the thread's next run and clears the arm", async () => {
  const root = await mkdtemp(join(tmpdir(), "kestrel-retry-"))
  const config = configOf(root)
  const now = Date.now()
  const at = new Date(now - 60_000).toISOString()
  const spawned: { readonly prompt: string; readonly choice: AgentChoice }[] = []
  await writeFile(
    config.stateFile,
    JSON.stringify({
      tasks: [
        {
          id: "task",
          owner: "owner",
          title: "Thread",
          status: "failed",
          createdAt: at,
          updatedAt: at,
          checkouts: [],
          autoRetry: { runId: "run", attempt: 1, nextAt: new Date(now - 1).toISOString() },
        },
      ],
      messages: [{ id: "prompt", taskId: "task", role: "user", text: "Do the work", runId: "run", createdAt: at }],
      runs: [
        {
          id: "run",
          taskId: "task",
          prompt: "Do the work",
          status: "failed",
          startedAt: at,
          endedAt: at,
          exitCode: 1,
          provider: "anthropic",
          model: "claude-opus-5-5",
          effort: null,
        },
      ],
    }),
  )

  const configLayer = Layer.succeed(Config, config)
  const workspaceLayer = Layer.succeed(WorkspaceService, {} as never)
  const deps = Layer.mergeAll(
    configLayer, StateLive.pipe(Layer.provide(Layer.merge(configLayer, workspaceLayer))), EventHubLive,
    Layer.succeed(DesktopManager, { watchStatus: () => Effect.void, status: () => Effect.succeed({ state: "stopped", display: null }), stopAll: () => Effect.void } as never),
    workspaceLayer, Layer.succeed(CredentialStore, {} as never),
    Layer.succeed(GitHub, {} as never), Layer.succeed(CliAuth, {} as never), Layer.succeed(CredentialBroker, {} as never),
    Layer.succeed(AgentHarness, {
      spawn: (_task: unknown, _run: unknown, start: RunStart, _display: unknown, _user: unknown, choice: AgentChoice) =>
        Effect.sync(() => void spawned.push({ prompt: start.resume?.prompt ?? start.fresh, choice })),
      steer: () => Effect.succeed({ accepted: true, afterItems: 0 }),
      cancel: () => Effect.void,
      stopAll: () => Effect.void, items: () => Effect.succeed([]), itemCount: () => 0,
    } as never),
  )

  try {
    await Effect.runPromise(
      Effect.gen(function* () {
        const store = yield* StateStore
        yield* CoreService
        for (let i = 0; i < 100 && spawned.length === 0; i++) yield* Effect.sleep("20 millis")
        const state = yield* store.read
        const retry = state.runs.at(-1)!
        expect(state.runs).toHaveLength(2)
        expect(retry).toMatchObject({ status: "running", autoRetryAttempt: 1, provider: "anthropic", model: "claude-opus-5-5" })
        expect(state.tasks[0]!.autoRetry).toBeUndefined()
        expect(state.messages.some((message) => message.id === "auto-retry:task:run:1")).toBe(true)
        expect(spawned).toHaveLength(1)
      }).pipe(Effect.provide(CoreLive.pipe(Layer.provide(deps), Layer.provideMerge(deps)))),
    )
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
