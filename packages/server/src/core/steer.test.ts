import { expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Effect, Either, Layer } from "effect"
import { Config, type ServerConfig } from "../config"
import { DesktopManager } from "../desktop"
import { CredentialStore } from "../credentials"
import { CliAuth } from "../cliauth"
import { GitHub } from "../github/api"
import { AgentHarness } from "./harness"
import { EventHubLive } from "./events"
import { CoreLive, CoreService } from "./service"
import { StateLive, StateStore } from "./state"
import { WorkspaceService } from "./workspace"

test("a message sent mid-run steers the run and keeps where the run's transcript was, also after a reload", async () => {
  const root = await mkdtemp(join(tmpdir(), "kestrel-steer-"))
  const config: ServerConfig = {
    port: 8898, host: "127.0.0.1", mcpBaseUrl: "http://127.0.0.1:8898", dataDir: root,
    stateFile: join(root, "state.json"), mirrorsDir: join(root, "mirrors"), threadsDir: join(root, "threads"),
    shadowsDir: join(root, "shadows"), runsDir: join(root, "runs"), attachmentsDir: join(root, "attachments"), homesDir: join(root, "homes"),
    agentCommands: { anthropic: "", openai: "" }, fakeAgent: false, fakeAgentRoBinds: [], sandbox: "off", sandboxPath: null,
    sandboxSslCertFile: null, systemd: null, maxConcurrentRuns: 0, relay: null, direct: null, toolkitsFlake: null,
    taskDiskMax: 1024 ** 3, desktopBundleMs: 0, githubApiUrl: "https://api.github.com",
  }
  const configLayer = Layer.succeed(Config, config)
  const workspaceLayer = Layer.succeed(WorkspaceService, {} as never)
  const stateLayer = StateLive.pipe(Layer.provide(Layer.merge(configLayer, workspaceLayer)))
  const steered: Array<{ readonly runId: string; readonly text: string }> = []
  const deps = Layer.mergeAll(
    configLayer, stateLayer, EventHubLive, workspaceLayer,
    Layer.succeed(DesktopManager, { watchStatus: () => Effect.void, status: () => Effect.succeed({ state: "stopped", display: null }), stopAll: () => Effect.void } as never),
    Layer.succeed(CredentialStore, {} as never), Layer.succeed(GitHub, {} as never), Layer.succeed(CliAuth, {} as never),
    Layer.succeed(AgentHarness, {
      // The run has shown four items when the message arrives.
      itemCount: (runId: string) => (runId === "run" ? 4 : 0),
      steer: (runId: string, text: string) => Effect.sync(() => { steered.push({ runId, text }); return true }),
      stopAll: () => Effect.void,
    } as never),
  )
  try {
    const sent = await Effect.runPromise(Effect.gen(function* () {
      const store = yield* StateStore
      const core = yield* CoreService
      const now = new Date().toISOString()
      yield* store.update((s) => {
        s.tasks.push({ id: "task", owner: "owner", title: "Task", status: "running", createdAt: now, updatedAt: now, checkouts: [] })
        s.runs.push({ id: "run", taskId: "task", prompt: "work", status: "running", startedAt: now, endedAt: null, exitCode: null, provider: "anthropic" })
        s.messages.push({ id: "prompt", taskId: "task", role: "user", text: "work", runId: "run", createdAt: now })
        return Either.right(undefined)
      })
      return yield* core.sendMessage("owner", "task", "use the other file", {}, [], false)
    }).pipe(Effect.provide(CoreLive.pipe(Layer.provide(deps), Layer.provideMerge(deps)))))

    expect(sent.run.id).toBe("run")
    expect(sent.message).toMatchObject({ runId: "run", afterItems: 4 })
    expect(steered).toEqual([{ runId: "run", text: "use the other file" }])

    // A fresh store reads the box's state file, as after a restart.
    const reloaded = await Effect.runPromise(
      Effect.flatMap(StateStore, (store) => store.read).pipe(Effect.provide(stateLayer)),
    )
    expect(reloaded.messages.find((m) => m.id === sent.message.id)).toMatchObject({ runId: "run", afterItems: 4 })
    expect(reloaded.messages.find((m) => m.id === "prompt")?.afterItems).toBeUndefined()
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}, 20_000)
