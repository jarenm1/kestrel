import { expect, test } from "bun:test"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Effect, Either, Layer } from "effect"
import type { AgentItem, Message, Run, ServerEvent, Task } from "@cloudagents/protocol"
import { Config, type ServerConfig } from "../config"
import { DesktopManager } from "../desktop"
import { CredentialStore } from "../credentials"
import { CliAuth } from "../cliauth"
import { CredentialBroker } from "../broker"
import { GitHub } from "../github/api"
import { AgentHarness, type RunStart, type SteerResult } from "./harness"
import { EventHub, EventHubLive } from "./events"
import { CoreLive, CoreService, type CoreShape } from "./service"
import { StateLive, StateStore, type StoreShape } from "./state"
import { WorkspaceService } from "./workspace"

/** What the fake harness answers for a steer and which items a run has shown. */
interface HarnessState {
  items: number
  steer: SteerResult
  readonly spawned: RunStart[]
}

const withCore = async (
  body: (ctx: {
    store: StoreShape
    core: CoreShape
    config: ServerConfig
    harness: HarnessState
    events: ServerEvent[]
  }) => Effect.Effect<void, unknown>,
): Promise<void> => {
  const root = await mkdtemp(join(tmpdir(), "kestrel-pending-"))
  const config: ServerConfig = {
    port: 8896, host: "127.0.0.1", sandboxPort: 8896, mcpBaseUrl: "http://127.0.0.1:8896", dataDir: root,
    stateFile: join(root, "state.json"), mirrorsDir: join(root, "mirrors"), threadsDir: join(root, "threads"),
    shadowsDir: join(root, "shadows"), runsDir: join(root, "runs"), attachmentsDir: join(root, "attachments"), homesDir: join(root, "homes"),
    agentCommands: { anthropic: "", openai: "", openrouter: "", zai: "", deepseek: "", minimax: "", moonshot: "", opencode: "", "opencode-go": "", google: "", devin: "" }, agentRouteCommands: { claude: "", codex: "", opencode: "" }, fakeAgent: false, fakeAgentRoBinds: [], sandbox: "off", sandboxPath: null,
    nest: null,
    sandboxSslCertFile: null, systemd: null, maxConcurrentRuns: 0, relay: null, direct: null, toolkitsFlake: null,
    taskDiskMax: 1024 ** 3, desktopIdleStopAfterMs: 0, streamIdleCloseAfterMs: 0, githubApiUrl: "https://api.github.com",
    webrtc: { iceServers: [], turn: null, policy: "all", portRange: null, hostAddresses: [], denyPrivate: false },
  }
  const harness: HarnessState = { items: 3, steer: { accepted: false }, spawned: [] }
  const events: ServerEvent[] = []
  const configLayer = Layer.succeed(Config, config)
  const workspaceLayer = Layer.succeed(WorkspaceService, {} as never)
  const stateLayer = StateLive.pipe(Layer.provide(Layer.merge(configLayer, workspaceLayer)))
  const deps = Layer.mergeAll(
    configLayer, stateLayer, EventHubLive, workspaceLayer,
    Layer.succeed(DesktopManager, { watchStatus: () => Effect.void, status: () => Effect.succeed({ state: "stopped", display: null }), stop: () => Effect.void, stopAll: () => Effect.void } as never),
    Layer.succeed(CredentialStore, {} as never), Layer.succeed(GitHub, {} as never), Layer.succeed(CliAuth, {} as never),
    Layer.succeed(CredentialBroker, {} as never),
    Layer.succeed(AgentHarness, {
      spawn: (_task: Task, _run: Run, start: RunStart) => Effect.sync(() => void harness.spawned.push(start)),
      steer: () => Effect.succeed(harness.steer),
      itemCount: () => harness.items,
      items: () => Effect.succeed([] as ReadonlyArray<AgentItem>),
      cancel: () => Effect.void,
      abort: () => Effect.void,
      stopAll: () => Effect.void,
    } as never),
  )
  try {
    await Effect.runPromise(Effect.gen(function* () {
      const store = yield* StateStore
      const core = yield* CoreService
      const hub = yield* EventHub
      yield* Effect.sync(() => {
        hub.subscribeAll((event) => {
          events.push(event)
        })
      })
      yield* body({ store, core, config, harness, events })
    }).pipe(Effect.provide(CoreLive.pipe(Layer.provide(deps), Layer.provideMerge(deps)))))
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}

const task = (id: string, status: Task["status"] = "idle"): Task => {
  const now = new Date().toISOString()
  return { id, owner: "owner", title: id, status, createdAt: now, updatedAt: now, checkouts: [] }
}

const run = (id: string, taskId: string, status: Run["status"] = "succeeded", index = 0): Run => ({
  id,
  taskId,
  prompt: "work",
  status,
  startedAt: new Date(Date.UTC(2026, 0, 1, 0, 0, index)).toISOString(),
  endedAt: status === "running" ? null : new Date(Date.UTC(2026, 0, 1, 1, 0, index)).toISOString(),
  exitCode: status === "running" ? null : 0,
  provider: "anthropic",
})

const userMessage = (id: string, taskId: string, runId: string, text: string, extra: Partial<Message> = {}): Message => ({
  id,
  taskId,
  role: "user",
  text,
  runId,
  createdAt: new Date().toISOString(),
  ...extra,
})

const created = (events: ReadonlyArray<ServerEvent>) =>
  events.flatMap((e) => (e._tag === "message.created" ? [e.message] : []))
const removedIds = (events: ReadonlyArray<ServerEvent>) =>
  events.flatMap((e) => (e._tag === "message.removed" ? [e.messageId] : []))

test("task_inbox takes the run's inbox messages once and positions them after its items", () =>
  withCore(({ store, core, events }) =>
    Effect.gen(function* () {
      yield* store.update((s) => {
        s.tasks.push(task("task", "running"))
        s.runs.push(run("run", "task", "running"))
        s.messages.push(
          userMessage("m1", "task", "run", "first", { pending: "inbox", createdAt: new Date(Date.UTC(2026, 0, 1, 0, 1, 1)).toISOString() }),
          userMessage("m2", "task", "run", "second", { pending: "inbox", createdAt: new Date(Date.UTC(2026, 0, 1, 0, 1, 2)).toISOString() }),
          userMessage("m3", "task", "run", "handed", { pending: "agent", createdAt: new Date(Date.UTC(2026, 0, 1, 0, 1, 3)).toISOString() }),
        )
        return Either.right(undefined)
      })
      expect(yield* core.inbox("task", "run")).toEqual(["first", "second"])
      expect(yield* core.inbox("task", "run")).toEqual([])
      const state = yield* store.read
      expect(state.messages.find((m) => m.id === "m1")).toMatchObject({ afterItems: 3 })
      expect(state.messages.find((m) => m.id === "m1")?.pending).toBeUndefined()
      expect(state.messages.find((m) => m.id === "m2")?.pending).toBeUndefined()
      // A message the CLI holds is never handed to the agent by task_inbox.
      expect(state.messages.find((m) => m.id === "m3")).toMatchObject({ pending: "agent" })
      expect(created(events).map((m) => [m.id, m.pending])).toEqual([["m1", undefined], ["m2", undefined]])
    }),
  ))

test("removing a pending message deletes it and its unreferenced attachment; anything the agent has is a Conflict", () =>
  withCore(({ store, core, config, events }) =>
    Effect.gen(function* () {
      yield* Effect.promise(() => mkdir(config.attachmentsDir, { recursive: true }))
      yield* Effect.promise(() => writeFile(join(config.attachmentsDir, "att1"), "bytes"))
      yield* store.update((s) => {
        s.tasks.push(task("task", "running"))
        s.runs.push(run("run", "task", "running"))
        s.messages.push(
          userMessage("inbox", "task", "run", "held by kestrel", { pending: "inbox", attachments: [{ id: "att1", mimeType: "text/plain" }] }),
          userMessage("held", "task", "run", "held after the run", { pending: "held" }),
          userMessage("agent", "task", "run", "handed to the cli", { pending: "agent" }),
          userMessage("taken", "task", "run", "already taken"),
        )
        return Either.right(undefined)
      })
      yield* core.deleteMessage("owner", "task", "inbox")
      expect(removedIds(events)).toEqual(["inbox"])
      expect((yield* store.read).messages.some((m) => m.id === "inbox")).toBe(false)
      expect(yield* Effect.promise(() => Bun.file(join(config.attachmentsDir, "att1")).exists())).toBe(false)

      expect(Either.isLeft(yield* Effect.either(core.deleteMessage("owner", "task", "agent")))).toBe(true)
      expect(Either.isLeft(yield* Effect.either(core.deleteMessage("owner", "task", "taken")))).toBe(true)
      expect(Either.isLeft(yield* Effect.either(core.deleteMessage("other", "task", "held")))).toBe(true)
      expect(Either.isLeft(yield* Effect.either(core.deleteMessage("owner", "task", "missing")))).toBe(true)
      yield* core.deleteMessage("owner", "task", "held")
      expect(removedIds(events)).toEqual(["inbox", "held"])
    }),
  ))

test("sending the held messages delivers one message with their texts and attachments, and removes them", () =>
  withCore(({ store, core, config, harness, events }) =>
    Effect.gen(function* () {
      const attachment = { id: "att1", mimeType: "image/png", name: "shot.png" }
      yield* store.update((s) => {
        s.tasks.push(task("task"))
        s.messages.push(
          userMessage("h1", "task", "old", "first part", { pending: "held", createdAt: new Date(Date.UTC(2026, 0, 1, 0, 1, 1)).toISOString(), attachments: [attachment] }),
          userMessage("h2", "task", "old", "second part", { pending: "held", createdAt: new Date(Date.UTC(2026, 0, 1, 0, 1, 2)).toISOString() }),
        )
        return Either.right(undefined)
      })
      const response = yield* core.sendHeldMessages("owner", "task", {})
      expect(response.message.text).toBe("first part\n\nsecond part")
      expect(response.message.attachments).toEqual([attachment])
      expect(response.message.pending).toBeUndefined()
      expect(response.run.status).toBe("running")
      const state = yield* store.read
      expect(state.messages.map((m) => m.id)).toEqual([response.message.id])
      expect(removedIds(events)).toEqual(["h1", "h2"])
      expect(created(events).at(-1)?.id).toBe(response.message.id)
      // The one message carries both texts and the file through the normal new-run path.
      expect(harness.spawned).toHaveLength(1)
      expect(harness.spawned[0]!.fresh).toContain("first part\n\nsecond part")
      expect(harness.spawned[0]!.fresh).toContain(join(config.homesDir, "task", "uploads", "att1", "shot.png"))
      expect(Either.isLeft(yield* Effect.either(core.sendHeldMessages("owner", "task", {})))).toBe(true)
    }),
  ))

test("a Claude steer accepted at once by the CLI is pending agent; a refused steer stays in the inbox", () =>
  withCore(({ store, core, harness }) =>
    Effect.gen(function* () {
      yield* store.update((s) => {
        s.tasks.push(task("task", "running"))
        s.runs.push(run("run", "task", "running"))
        s.messages.push(userMessage("prompt", "task", "run", "work"))
        return Either.right(undefined)
      })
      harness.steer = { accepted: true, afterItems: 7, taken: false }
      const queued = yield* core.sendMessage("owner", "task", "take this next", {}, [], false)
      expect(queued.message).toMatchObject({ pending: "agent" })
      expect((yield* store.read).messages.find((m) => m.id === queued.message.id)).toMatchObject({ pending: "agent" })

      harness.steer = { accepted: false }
      const refused = yield* core.sendMessage("owner", "task", "keep this", {}, [], false)
      expect(refused.message).toMatchObject({ pending: "inbox" })
      expect((yield* store.read).messages.find((m) => m.id === refused.message.id)).toMatchObject({ pending: "inbox" })

      harness.steer = { accepted: true, afterItems: 8, taken: true }
      const taken = yield* core.sendMessage("owner", "task", "codex has it", {}, [], false)
      expect(taken.message.pending).toBeUndefined()
      expect((yield* store.read).messages.find((m) => m.id === taken.message.id)).toMatchObject({ afterItems: 8 })
    }),
  ))

test("a new fresh prompt leaves held and inbox messages out of the conversation", () =>
  withCore(({ store, core, harness }) =>
    Effect.gen(function* () {
      yield* store.update((s) => {
        s.tasks.push(task("task", "failed"))
        s.runs.push(run("old", "task", "failed"))
        s.messages.push(
          { id: "seen", taskId: "task", role: "user", text: "work", runId: "old", createdAt: new Date(Date.UTC(2026, 0, 1, 0, 1, 1)).toISOString() },
          userMessage("held", "task", "old", "never sent to the agent", { pending: "held" }),
        )
        return Either.right(undefined)
      })
      yield* core.sendMessage("owner", "task", "continue", {}, [], false)
      expect(harness.spawned).toHaveLength(1)
      expect(harness.spawned[0]!.fresh).toContain("work")
      expect(harness.spawned[0]!.fresh).toContain("continue")
      expect(harness.spawned[0]!.fresh).not.toContain("never sent to the agent")
      expect(harness.spawned[0]!.resume).toBeNull()
    }),
  ))

test("a resumed run's delta prompt leaves held messages out too", () =>
  withCore(({ store, core, harness }) =>
    Effect.gen(function* () {
      yield* store.update((s) => {
        s.tasks.push(task("task", "idle"))
        // The second run named no session, so the newest session is the first's; the held message came after it.
        s.runs.push(run("first", "task", "succeeded", 0), run("second", "task", "succeeded", 1))
        s.runSessions.push({ runId: "first", sessionId: "session-1", provider: "anthropic", harness: "claude", continuation: "task-home" })
        s.messages.push(
          { id: "seen", taskId: "task", role: "user", text: "work", runId: "first", createdAt: new Date(Date.UTC(2026, 0, 1, 0, 1, 1)).toISOString() },
          userMessage("held", "task", "second", "never sent to the agent", { pending: "held" }),
        )
        return Either.right(undefined)
      })
      yield* core.sendMessage("owner", "task", "continue", {}, [], false)
      expect(harness.spawned).toHaveLength(1)
      const resume = harness.spawned[0]!.resume
      expect(resume?.sessionId).toBe("session-1")
      expect(resume?.prompt).toContain("continue")
      expect(resume?.prompt).not.toContain("never sent to the agent")
    }),
  ))
