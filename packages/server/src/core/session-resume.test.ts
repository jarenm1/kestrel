import { expect, test } from "bun:test"
import { modelInfo } from "@cloudagents/protocol"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Effect, Either, Layer } from "effect"
import { Config, type ServerConfig } from "../config"
import { DesktopManager } from "../desktop"
import { CredentialStore } from "../credentials"
import { CliAuth } from "../cliauth"
import { GitHub } from "../github/api"
import { AgentHarness, type AgentChoice, type RunStart } from "./harness"
import { EventHubLive } from "./events"
import { CoreLive, CoreService, type CoreShape } from "./service"
import { StateLive, StateStore, type StoreShape } from "./state"
import { WorkspaceService } from "./workspace"

/** A spawned run as it starts when its CLI still keeps sessions where the offered one is, and its fresh prompt. */
interface Spawned {
  readonly prompt: string
  readonly resumeSession: string | null
  readonly fresh: string
  readonly choice: AgentChoice
}

const configOf = (root: string): ServerConfig => ({
  port: 8899, host: "127.0.0.1", sandboxPort: 8899, mcpBaseUrl: "http://127.0.0.1:8899", dataDir: root,
  stateFile: join(root, "state.json"), mirrorsDir: join(root, "mirrors"), threadsDir: join(root, "threads"),
  shadowsDir: join(root, "shadows"), runsDir: join(root, "runs"), attachmentsDir: join(root, "attachments"), homesDir: join(root, "homes"),
  agentCommands: { anthropic: "", openai: "", openrouter: "", zai: "", deepseek: "", minimax: "", moonshot: "", deepinfra: "", opencode: "", "opencode-go": "", google: "", omp: "", pi: "", hermes: "" }, fakeAgent: false, fakeAgentRoBinds: [], sandbox: "off", sandboxPath: null,
  sandboxSslCertFile: null, systemd: null, maxConcurrentRuns: 2, relay: null, direct: null, toolkitsFlake: null,
  taskDiskMax: 1024 ** 3, githubApiUrl: "https://api.github.com",
  webrtc: { iceServers: [], turn: null, policy: "all", portRange: null, hostAddresses: [], denyPrivate: false },
})

const withCore = async (
  body: (core: CoreShape, store: StoreShape, spawned: Spawned[]) => Effect.Effect<void, unknown>,
) => {
  const root = await mkdtemp(join(tmpdir(), "kestrel-session-"))
  const config = configOf(root)
  const spawned: Spawned[] = []
  let testStore: StoreShape | undefined
  const configLayer = Layer.succeed(Config, config)
  const workspaceLayer = Layer.succeed(WorkspaceService, {} as never)
  const deps = Layer.mergeAll(
    configLayer, StateLive.pipe(Layer.provide(Layer.merge(configLayer, workspaceLayer))), EventHubLive,
    Layer.succeed(DesktopManager, { watchStatus: () => Effect.void, status: () => Effect.succeed({ state: "stopped", display: null }), stopAll: () => Effect.void } as never),
    workspaceLayer, Layer.succeed(CredentialStore, {} as never),
    Layer.succeed(GitHub, {} as never), Layer.succeed(CliAuth, {} as never),
    Layer.succeed(AgentHarness, {
      spawn: (_task: unknown, _run: unknown, start: RunStart, _display: unknown, _user: unknown, choice: AgentChoice) =>
        Effect.sync(() => {
          spawned.push({ prompt: start.resume?.prompt ?? start.fresh, resumeSession: start.resume?.sessionId ?? null, fresh: start.fresh, choice })
        }),
      steer: () => Effect.succeed({ accepted: true, afterItems: 0 }),
      cancel: (id: string) => testStore!.update((s) => {
        const run = s.runs.find((r) => r.id === id)
        if (run?.status === "running") { run.status = "cancelled"; run.endedAt = new Date().toISOString() }
        return Either.right(undefined)
      }),
      stopAll: () => Effect.void, items: () => Effect.succeed([]), itemCount: () => 0,
    } as never),
  )
  try {
    await Effect.runPromise(
      Effect.gen(function* () {
        const store = yield* StateStore
        testStore = store
        const core = yield* CoreService
        yield* body(core, store, spawned)
      }).pipe(Effect.provide(CoreLive.pipe(Layer.provide(deps), Layer.provideMerge(deps)))),
    )
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}

test("a run resumes the newest native session of its provider and carries only the off-provider delta", async () => {
  await withCore((core, store, spawned) => Effect.gen(function* () {
    const now = new Date().toISOString()
    yield* store.update((s) => {
      const task = (id: string) => ({ id, owner: "owner", title: id, status: "idle" as const, createdAt: now, updatedAt: now, checkouts: [] })
      s.tasks.push(task("switch-back"), task("first-switch"), task("broken-session"), task("same-provider"), task("big-delta"), task("cross-provider-broken"), task("broken-before-switch"))
      const run = (id: string, taskId: string, provider: "anthropic" | "openai", status: "succeeded" | "failed") =>
        ({ id, taskId, prompt: id, status, startedAt: now, endedAt: now, exitCode: 0, provider })
      s.runs.push(
        run("A1", "switch-back", "anthropic", "succeeded"),
        run("B1", "switch-back", "openai", "succeeded"),
        run("B2", "first-switch", "openai", "succeeded"),
        run("A2", "broken-session", "anthropic", "succeeded"),
        run("A3", "broken-session", "anthropic", "failed"),
        run("A4", "same-provider", "anthropic", "succeeded"),
        run("A5", "big-delta", "anthropic", "succeeded"),
        run("B5", "big-delta", "openai", "succeeded"),
        run("A6", "cross-provider-broken", "anthropic", "succeeded"),
        run("B6", "cross-provider-broken", "openai", "failed"),
        run("A7", "broken-before-switch", "anthropic", "succeeded"),
        run("A8", "broken-before-switch", "anthropic", "failed"),
        run("B7", "broken-before-switch", "openai", "succeeded"),
      )
      s.runSessions.push(
        { runId: "A1", sessionId: "claude-session-A1", provider: "anthropic" },
        { runId: "B1", sessionId: "codex-thread-B1", provider: "openai" },
        { runId: "B2", sessionId: "codex-thread-B2", provider: "openai" },
        { runId: "A2", sessionId: "claude-session-A2", provider: "anthropic" },
        { runId: "A4", sessionId: "claude-session-A4", provider: "anthropic" },
        { runId: "A5", sessionId: "claude-session-A5", provider: "anthropic" },
        { runId: "B5", sessionId: "codex-thread-B5", provider: "openai" },
        { runId: "A6", sessionId: "claude-session-A6", provider: "anthropic" },
        { runId: "A7", sessionId: "broken-old-session", provider: "anthropic" },
        { runId: "B7", sessionId: "codex-thread-B7", provider: "openai" },
      )
      const message = (id: string, taskId: string, runId: string, role: "user" | "agent", text: string) =>
        ({ id, taskId, runId, role, text, createdAt: now })
      s.messages.push(
        message("a1-user", "switch-back", "A1", "user", "Anthropic opening request"),
        message("a1-agent", "switch-back", "A1", "agent", "Anthropic opening answer"),
        message("b1-user", "switch-back", "B1", "user", "OpenAI follow-up request"),
        message("b1-agent", "switch-back", "B1", "agent", "OpenAI follow-up answer"),
        message("b2-user", "first-switch", "B2", "user", "OpenAI only request"),
        message("b2-agent", "first-switch", "B2", "agent", "OpenAI only answer"),
        message("a2-user", "broken-session", "A2", "user", "Anthropic earlier request"),
        message("a2-agent", "broken-session", "A2", "agent", "Anthropic earlier answer"),
        message("a3-user", "broken-session", "A3", "user", "Failed launch request"),
        message("a4-user", "same-provider", "A4", "user", "Same provider earlier request"),
        message("a4-agent", "same-provider", "A4", "agent", "Same provider earlier answer"),
        message("a5-user", "big-delta", "A5", "user", "Big delta opening"),
        message("b5-agent", "big-delta", "B5", "agent", `Huge off-provider output ${"x".repeat(100_000)}`),
        message("a6-user", "cross-provider-broken", "A6", "user", "Cross-provider earlier"),
        message("b6-user", "cross-provider-broken", "B6", "user", "Cross-provider failed launch"),
        message("a7-user", "broken-before-switch", "A7", "user", "Before broken resume"),
        message("a8-user", "broken-before-switch", "A8", "user", "Broken resume request"),
        message("b7-agent", "broken-before-switch", "B7", "agent", "Off-provider work since broken resume"),
      )
      return Either.right(undefined)
    })
    const claude = { model: "claude-opus-5-5" as const }

    yield* core.sendMessage("owner", "switch-back", "Back on Claude", claude, [], false)
    const back = spawned.at(-1)!
    expect(back.resumeSession).toBe("claude-session-A1")
    expect(back.prompt).toContain("OpenAI follow-up request")
    expect(back.prompt).toContain("OpenAI follow-up answer")
    // The resumed session already holds the Anthropic turns: replaying them duplicates context.
    expect(back.prompt).not.toContain("Anthropic opening request")
    expect(back.prompt).not.toContain("Anthropic opening answer")
    // Should the CLI no longer find that session, the run starts fresh and needs the whole conversation.
    expect(back.fresh).toContain("Anthropic opening request")
    expect(back.fresh).toContain("OpenAI follow-up answer")

    yield* core.sendMessage("owner", "first-switch", "First Claude message", claude, [], false)
    const first = spawned.at(-1)!
    expect(first.resumeSession).toBeNull()
    expect(first.prompt).toContain("OpenAI only request")
    expect(first.prompt).toContain("OpenAI only answer")

    yield* core.sendMessage("owner", "broken-session", "Retry after a failed launch", claude, [], false)
    const broken = spawned.at(-1)!
    // The failed run never named a session, so resuming the older one may repeat that failure.
    expect(broken.resumeSession).toBeNull()
    expect(broken.prompt).toContain("Anthropic earlier request")
    expect(broken.prompt).toContain("Anthropic earlier answer")
    expect(broken.prompt).toContain("Failed launch request")

    yield* core.sendMessage("owner", "same-provider", "Next same-provider message", claude, [], false)
    const same = spawned.at(-1)!
    expect(same.resumeSession).toBe("claude-session-A4")
    expect(same.prompt).not.toContain("Same provider earlier request")
    expect(same.prompt).not.toContain("Same provider earlier answer")

    yield* core.sendMessage("owner", "big-delta", "After a huge delta", claude, [], false)
    const big = spawned.at(-1)!
    expect(big.resumeSession).toBe("claude-session-A5")
    expect(big.prompt).toContain("[Earlier conversation truncated]")
    expect(big.prompt.length).toBeLessThan(70_000)

    // The failed run was the other provider's: it cannot have broken the Anthropic session, so that session resumes.
    yield* core.sendMessage("owner", "cross-provider-broken", "Back to Claude", claude, [], false)
    const crossBroken = spawned.at(-1)!
    expect(crossBroken.resumeSession).toBe("claude-session-A6")
    expect(crossBroken.prompt).toContain("Cross-provider failed launch")
    expect(crossBroken.prompt).not.toContain("Cross-provider earlier")

    yield* core.sendMessage("owner", "broken-before-switch", "Back after failed resume", claude, [], false)
    const invalidated = spawned.at(-1)!
    expect(invalidated.resumeSession).toBeNull()
    expect(invalidated.prompt).toContain("Before broken resume")
    expect(invalidated.prompt).toContain("Broken resume request")
    expect(invalidated.prompt).toContain("Off-provider work since broken resume")
  }))
}, 20_000)

test("an automatic delivery keeps the thread's provider when its latest run never named a session", async () => {
  await withCore((core, store, spawned) => Effect.gen(function* () {
    const now = new Date().toISOString()
    yield* store.update((s) => {
      s.tasks.push(
        { id: "sender", owner: "owner", title: "Sender", status: "running", createdAt: now, updatedAt: now, checkouts: [] },
        { id: "thread", owner: "owner", title: "Thread", status: "idle", createdAt: now, updatedAt: now, checkouts: [] },
      )
      s.runs.push(
        { id: "sender-run", taskId: "sender", prompt: "work", status: "running", startedAt: now, endedAt: null, exitCode: null, provider: "openai" },
        { id: "failed-openai", taskId: "thread", prompt: "work", status: "failed", startedAt: now, endedAt: now, exitCode: 1, provider: "openai" },
      )
      s.messages.push({ id: "old", taskId: "thread", runId: "failed-openai", role: "user", text: "Earlier OpenAI request", createdAt: now })
      return Either.right(undefined)
    })
    yield* core.sendToThread("sender", "thread", "Peer follow-up")
    const spawnedRun = spawned.at(-1)!
    // Without a session record the thread still runs on OpenAI; defaulting to the box's Anthropic harness would
    // switch providers and replay the whole conversation on every automatic delivery.
    expect(modelInfo(spawnedRun.choice.model!).provider).toBe("openai")
    expect(spawnedRun.resumeSession).toBeNull()
    expect(spawnedRun.prompt).toContain("Earlier OpenAI request")
  }))
}, 20_000)

