import { expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Effect, Either, Layer } from "effect"
import type { Message } from "@cloudagents/protocol"
import { Config, type ServerConfig } from "../config"
import { DesktopManager } from "../desktop"
import { CredentialStore } from "../credentials"
import { CliAuth } from "../cliauth"
import { CredentialBroker } from "../broker"
import { GitHub } from "../github/api"
import { AgentHarness } from "./harness"
import { EventHub, EventHubLive } from "./events"
import { CoreLive, CoreService } from "./service"
import { StateLive, StateStore } from "./state"
import { WorkspaceService } from "./workspace"

test.each([4, 0])("a message sent mid-run retains its position (initial items: %i), also after a reload", async (initialItems) => {
  const root = await mkdtemp(join(tmpdir(), "kestrel-steer-"))
  const config: ServerConfig = {
    port: 8898, host: "127.0.0.1", sandboxPort: 8898, mcpBaseUrl: "http://127.0.0.1:8898", dataDir: root,
    stateFile: join(root, "state.json"), mirrorsDir: join(root, "mirrors"), threadsDir: join(root, "threads"),
    shadowsDir: join(root, "shadows"), runsDir: join(root, "runs"), attachmentsDir: join(root, "attachments"), homesDir: join(root, "homes"),
    agentCommands: { anthropic: "", openai: "", openrouter: "", zai: "", deepseek: "", minimax: "", moonshot: "", opencode: "", "opencode-go": "", google: "", devin: "" }, agentRouteCommands: { claude: "", codex: "", opencode: "" }, fakeAgent: false, fakeAgentRoBinds: [], sandbox: "off", sandboxPath: null,
    nest: null,
    sandboxSslCertFile: null, systemd: null, maxConcurrentRuns: 0, relay: null, direct: null, toolkitsFlake: null,
    taskDiskMax: 1024 ** 3, githubApiUrl: "https://api.github.com",
    webrtc: { iceServers: [], turn: null, policy: "all", portRange: null, hostAddresses: [], denyPrivate: false },
  }
  const configLayer = Layer.succeed(Config, config)
  const workspaceLayer = Layer.succeed(WorkspaceService, {} as never)
  const stateLayer = StateLive.pipe(Layer.provide(Layer.merge(configLayer, workspaceLayer)))
  const steered: Array<{ readonly runId: string; readonly text: string }> = []
  // What each steer reports: the run emitted two more items while the first message was stored; it had ended (no
  // items in memory) by the time the second was sent.
  const deliveredAt = [6, 0]
  const deps = Layer.mergeAll(
    configLayer, stateLayer, EventHubLive, workspaceLayer,
    Layer.succeed(DesktopManager, { watchStatus: () => Effect.void, status: () => Effect.succeed({ state: "stopped", display: null }), stopAll: () => Effect.void } as never),
    Layer.succeed(CredentialStore, {} as never), Layer.succeed(GitHub, {} as never), Layer.succeed(CliAuth, {} as never),
    Layer.succeed(CredentialBroker, {} as never),
    Layer.succeed(AgentHarness, {
      // Zero still identifies a message joining an existing run, not a new run's prompt.
      itemCount: (runId: string) => (runId === "run" ? initialItems : 0),
      steer: (runId: string, text: string) =>
        Effect.sync(() => {
          steered.push({ runId, text })
          return { accepted: true, afterItems: deliveredAt[steered.length - 1]! }
        }),
      stopAll: () => Effect.void,
    } as never),
  )
  try {
    const { first, second, published } = await Effect.runPromise(Effect.gen(function* () {
      const store = yield* StateStore
      const core = yield* CoreService
      const hub = yield* EventHub
      const now = new Date().toISOString()
      yield* store.update((s) => {
        s.tasks.push({ id: "task", owner: "owner", title: "Task", status: "running", createdAt: now, updatedAt: now, checkouts: [] })
        s.runs.push({ id: "run", taskId: "task", prompt: "work", status: "running", startedAt: now, endedAt: null, exitCode: null, provider: "anthropic" })
        s.messages.push({ id: "prompt", taskId: "task", role: "user", text: "work", runId: "run", createdAt: now })
        return Either.right(undefined)
      })
      const published: Message[] = []
      const unsubscribe = hub.subscribe("task", (event) => {
        if (event._tag === "message.created") published.push(event.message)
      })
      const first = yield* core.sendMessage("owner", "task", "use the other file", {}, [], false)
      const second = yield* core.sendMessage("owner", "task", "and keep the tests", {}, [], false)
      unsubscribe()
      return { first, second, published }
    }).pipe(Effect.provide(CoreLive.pipe(Layer.provide(deps), Layer.provideMerge(deps)))))

    expect(first.run.id).toBe("run")
    expect(steered).toEqual([
      { runId: "run", text: "use the other file" },
      { runId: "run", text: "and keep the tests" },
    ])
    // The position is the one at delivery; a run that ended meanwhile keeps the one taken when the message was stored.
    expect(first.message).toMatchObject({ runId: "run", afterItems: 6 })
    expect(second.message).toMatchObject({ runId: "run", afterItems: initialItems })
    // Each message is published once, with its final position.
    expect(published.map((m) => [m.id, m.afterItems])).toEqual([[first.message.id, 6], [second.message.id, initialItems]])

    // A fresh store reads the box's state file, as after a restart.
    const reloaded = await Effect.runPromise(
      Effect.flatMap(StateStore, (store) => store.read).pipe(Effect.provide(stateLayer)),
    )
    expect(reloaded.messages.find((m) => m.id === first.message.id)).toMatchObject({ runId: "run", afterItems: 6 })
    expect(reloaded.messages.find((m) => m.id === second.message.id)).toMatchObject({ runId: "run", afterItems: initialItems })
    expect(reloaded.messages.find((m) => m.id === "prompt")?.afterItems).toBeUndefined()
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}, 20_000)
