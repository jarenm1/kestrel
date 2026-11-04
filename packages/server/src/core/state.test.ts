import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { Cause, Effect, Exit, Layer, Option } from "effect"
import type { InternalError } from "@cloudagents/protocol"
import { existsSync } from "node:fs"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
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
  agentCommands: { anthropic: "", openai: "", openrouter: "", zai: "", deepseek: "", minimax: "", moonshot: "", deepinfra: "", opencode: "", "opencode-go": "", google: "", omp: "", pi: "", hermes: "" }, fakeAgent: false, fakeAgentRoBinds: [], sandbox: "off", sandboxPath: null,
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

/** Runs and sessions on the standalone ACP harnesses, alongside supported ones. */
const mixedState = (): RawState => ({
  tasks: [task("supported-thread"), task("standalone-thread")],
  messages: [
    message("m1", "supported-thread", "r1", "user", "supported request"),
    message("m2", "standalone-thread", "r2", "user", "standalone request"),
    message("m3", "standalone-thread", "r3", "agent", "standalone answer"),
  ],
  runs: [
    run("r1", "supported-thread", { provider: "anthropic", model: "claude-opus-5", harness: "claude" }),
    run("r2", "standalone-thread", { provider: "omp", model: "omp-deepseek-pro", harness: "omp" }),
    run("r3", "standalone-thread", { provider: "hermes", model: "hermes-deepseek-flash", harness: "hermes" }),
    run("r4", "standalone-thread", { provider: "pi" }),
  ],
  pendingAsks: [],
  uploads: [],
  runSessions: [
    { runId: "r1", sessionId: "claude-session-r1", provider: "anthropic" },
    { runId: "r2", sessionId: "omp-session-r2", provider: "omp" },
    { runId: "r4", sessionId: "pi-session-r4", provider: "pi" },
  ],
})

describe("standalone ACP harness state", () => {
  let root: string
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "kestrel-state-"))
  })
  afterEach(async () => {
    await rm(root, { recursive: true, force: true })
  })

  test("loads runs and resume targets on every provider, including OMP, Pi and Hermes", async () => {
    const file = join(root, "state.json")
    await writeFile(file, JSON.stringify(mixedState()))

    const state = await loadState(root)

    expect(state.tasks.map((t) => t.id)).toEqual(["supported-thread", "standalone-thread"])
    expect(state.messages.map((m) => m.id)).toEqual(["m1", "m2", "m3"])
    expect(state.messages.map((m) => m.text)).toEqual(["supported request", "standalone request", "standalone answer"])
    expect(state.runs.map((r) => r.id)).toEqual(["r1", "r2", "r3", "r4"])
    expect(state.runs[0]!.provider).toBe("anthropic")
    expect(state.runs[0]!.model).toBe("claude-opus-5")
    expect(state.runs[1]!).toMatchObject({ provider: "omp", model: "omp-deepseek-pro", prompt: "r2", status: "succeeded" })
    expect(state.runs[2]!).toMatchObject({ provider: "hermes", model: "hermes-deepseek-flash" })
    expect(state.runs[3]!).toMatchObject({ provider: "pi", prompt: "r4", status: "succeeded" })
    // Their resume targets remain: these providers are selectable again, so a session is still addressable.
    expect(state.runSessions.map((s) => s.runId)).toEqual(["r1", "r2", "r4"])
    expect(state.runSessions.map((s) => s.provider)).toEqual(["anthropic", "omp", "pi"])
  })

  test("a decodable state file is not rewritten", async () => {
    const file = join(root, "state.json")
    const original = JSON.stringify(mixedState())
    await writeFile(file, original)

    await loadState(root)
    expect(await readFile(file, "utf8")).toBe(original)

    const reloaded = await loadState(root)
    expect(await readFile(file, "utf8")).toBe(original)
    expect(reloaded.runs.map((r) => r.id)).toEqual(["r1", "r2", "r3", "r4"])
    expect(reloaded.runSessions.map((s) => s.runId)).toEqual(["r1", "r2", "r4"])
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
    expect(await readFile(file, "utf8")).toBe(original)
  })

  test("a missing state file starts empty and legacy records load unchanged", async () => {
    expect(await loadState(root)).toEqual({
      tasks: [], messages: [], runs: [], pendingAsks: [], uploads: [], runSessions: [],
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
    expect(await readFile(file, "utf8")).toBe(JSON.stringify(legacy))
  })
})
