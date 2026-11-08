import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { chmod, mkdir, mkdtemp, readFile, readdir, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Effect, Either, Layer } from "effect"
import type { InternalError, Message } from "@cloudagents/protocol"
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

// Real StateLive and CoreService over a temp state file. Faults are real filesystem faults on the state directory, so
// they exercise the same write path a disk error would: the store's rename and directory sync.
// Removing read permission makes the directory sync fail after the rename has landed; a directory where the file
// belongs makes the rename itself fail. Root ignores directory permissions, so the sync-failure cases are skipped there.
const canSimulateSyncFault = process.platform !== "win32" && process.getuid?.() !== 0

describe("deliverMessage under state write faults", () => {
  let root: string
  let spawned: string[]
  let published: Message[]

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "kestrel-deliver-"))
    spawned = []
    published = []
  })
  afterEach(async () => {
    await chmod(root, 0o755).catch(() => undefined)
    await rm(root, { recursive: true, force: true })
  })

  const configOf = (): ServerConfig => ({
    port: 8897, host: "127.0.0.1", sandboxPort: 8897, mcpBaseUrl: "http://127.0.0.1:8897", dataDir: root,
    stateFile: join(root, "state.json"), mirrorsDir: join(root, "mirrors"), threadsDir: join(root, "threads"),
    shadowsDir: join(root, "shadows"), runsDir: join(root, "runs"), attachmentsDir: join(root, "attachments"), homesDir: join(root, "homes"),
    agentCommands: { anthropic: "", openai: "", openrouter: "", zai: "", deepseek: "", minimax: "", moonshot: "", opencode: "", "opencode-go": "", google: "", devin: "" }, agentRouteCommands: { claude: "", codex: "", opencode: "" }, fakeAgent: false, fakeAgentRoBinds: [], sandbox: "off", sandboxPath: null,
    nest: null,
    sandboxSslCertFile: null, systemd: null, maxConcurrentRuns: 2, relay: null, direct: null, toolkitsFlake: null,
    taskDiskMax: 1024 ** 3, githubApiUrl: "https://api.github.com",
    webrtc: { iceServers: [], turn: null, policy: "all", portRange: null, hostAddresses: [], denyPrivate: false },
  })

  // A fresh layer per program: the state file is re-read at start, so each step sees what disk holds.
  const layerFor = () => {
    const config = configOf()
    const configLayer = Layer.succeed(Config, config)
    const workspaceLayer = Layer.succeed(WorkspaceService, {} as never)
    const stateLayer = StateLive.pipe(Layer.provide(Layer.merge(configLayer, workspaceLayer)))
    return Layer.mergeAll(
      configLayer, stateLayer, EventHubLive, workspaceLayer,
      Layer.succeed(DesktopManager, { watchStatus: () => Effect.void, status: () => Effect.succeed({ state: "stopped", display: null }), stopAll: () => Effect.void } as never),
      Layer.succeed(CredentialStore, {} as never), Layer.succeed(GitHub, {} as never), Layer.succeed(CliAuth, {} as never),
      Layer.succeed(CredentialBroker, {} as never),
      Layer.succeed(AgentHarness, {
        itemCount: () => 0,
        steer: () => Effect.succeed({ accepted: true, afterItems: 0 }),
        spawn: (_task: unknown, run: { id: string }) => Effect.sync(() => { spawned.push(run.id) }),
        stopAll: () => Effect.void,
      } as never),
    )
  }

  // The core service over the same state store the test seeds and reads, so every step shares one store.
  const coreLayer = () => {
    const deps = layerFor()
    return CoreLive.pipe(Layer.provide(deps), Layer.provideMerge(deps))
  }

  const seedIdleTask = (file: string) => {
    const now = "2026-11-01T00:00:00.000Z"
    return Effect.gen(function* () {
      const store = yield* StateStore
      yield* store.update((s) => {
        s.tasks.push({ id: "task", owner: "owner", title: "Task", status: "idle", createdAt: now, updatedAt: now, checkouts: [] })
        return Either.right(undefined)
      })
      yield* store.flush
      expect(yield* Effect.promise(() => readFile(file, "utf8"))).toContain('"task"')
    })
  }

  const deliver = Effect.gen(function* () {
    const core = yield* CoreService
    const hub = yield* EventHub
    hub.subscribe("task", (event) => {
      if (event._tag === "message.created") published.push(event.message)
    })
    return yield* Effect.either(core.sendMessage("owner", "task", "hello", {}, [], false))
  })

  test("a write that renames but then fails its directory sync still starts the run, and the run is not stranded", async () => {
    if (!canSimulateSyncFault) return
    const file = join(root, "state.json")
    const program = Effect.gen(function* () {
      yield* seedIdleTask(file)
      yield* Effect.promise(() => chmod(root, 0o300))
      const outcome = yield* deliver
      // The reservation landed in memory and on disk, so the message is delivered and the run spawned, not an error.
      expect(Either.isRight(outcome)).toBe(true)
      yield* Effect.promise(() => chmod(root, 0o755))
      const store = yield* StateStore
      const runs = (yield* store.read).runs
      expect(runs.map((r) => r.status)).toEqual(["running"])
      expect(spawned).toEqual([runs[0]!.id])
      expect(published.map((m) => m.text)).toEqual(["hello"])
    })
    await Effect.runPromise(program.pipe(Effect.provide(coreLayer())))

    // The file holds the reservation too: the unconfirmed write was applied, not rolled back.
    const raw = JSON.parse(await readFile(file, "utf8")) as { runs: Array<{ status: string }>; messages: Array<{ text: string }> }
    expect(raw.runs.map((r) => r.status)).toEqual(["running"])
    expect(raw.messages.map((m) => m.text)).toEqual(["hello"])
  })

  test("a write that fails before the rename delivers nothing and starts no run", async () => {
    const file = join(root, "state.json")
    const program = Effect.gen(function* () {
      yield* seedIdleTask(file)
      // A directory where the state file belongs makes the rename fail: the update is not applied.
      yield* Effect.promise(async () => {
        await rm(file, { force: true })
        await mkdir(file)
      })
      const outcome = yield* deliver
      expect(Either.isLeft(outcome)).toBe(true)
      if (Either.isLeft(outcome)) {
        expect(outcome.left._tag).toBe("InternalError")
        expect((outcome.left as InternalError).message).toContain("update not applied")
      }
      const store = yield* StateStore
      expect((yield* store.read).runs).toEqual([])
      expect((yield* store.read).messages).toEqual([])
      expect(spawned).toEqual([])
      expect(published).toEqual([])
      yield* Effect.promise(() => rm(file, { recursive: true, force: true }))
    })
    await Effect.runPromise(program.pipe(Effect.provide(coreLayer())))
    expect((await readdir(root)).filter((name) => name.endsWith(".tmp"))).toEqual([])
  })

  test("with a healthy disk the message is delivered, the run is spawned and published once", async () => {
    const file = join(root, "state.json")
    const program = Effect.gen(function* () {
      yield* seedIdleTask(file)
      const outcome = yield* deliver
      expect(Either.isRight(outcome)).toBe(true)
      const store = yield* StateStore
      yield* store.flush
      expect((yield* store.read).runs.map((r) => r.status)).toEqual(["running"])
    })
    await Effect.runPromise(program.pipe(Effect.provide(coreLayer())))
    expect(spawned).toHaveLength(1)
    expect(published).toHaveLength(1)
  })
})
