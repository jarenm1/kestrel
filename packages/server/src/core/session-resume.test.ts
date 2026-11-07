import { expect, test } from "bun:test"
import { modelHarness, modelInfo } from "@cloudagents/protocol"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Effect, Either, Layer } from "effect"
import { Config, type ServerConfig } from "../config"
import { DesktopManager } from "../desktop"
import { CredentialStore } from "../credentials"
import { CliAuth } from "../cliauth"
import { CredentialBroker } from "../broker"
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
  readonly resumeHarness: string | undefined
  readonly resumeContinuation: string | undefined
  readonly fresh: string
  readonly choice: AgentChoice
}

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
    Layer.succeed(GitHub, {} as never), Layer.succeed(CliAuth, {} as never), Layer.succeed(CredentialBroker, {} as never),
    Layer.succeed(AgentHarness, {
      spawn: (_task: unknown, _run: unknown, start: RunStart, _display: unknown, _user: unknown, choice: AgentChoice) =>
        Effect.sync(() => {
          spawned.push({
            prompt: start.resume?.prompt ?? start.fresh,
            resumeSession: start.resume?.sessionId ?? null,
            resumeHarness: start.resume?.harness,
            resumeContinuation: start.resume?.continuation,
            fresh: start.fresh,
            choice,
          })
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

test("resume is partitioned by provider and harness, not only by provider", async () => {
  await withCore((core, store, spawned) => Effect.gen(function* () {
    const now = new Date().toISOString()
    yield* store.update((s) => {
      s.tasks.push({ id: "route", owner: "owner", title: "Route", status: "idle", createdAt: now, updatedAt: now, checkouts: [] })
      s.runs.push(
        { id: "claude-run", taskId: "route", prompt: "claude work", status: "succeeded", startedAt: now, endedAt: now, exitCode: 0, provider: "anthropic", model: "claude-opus-5-5", harness: "claude" },
        { id: "opencode-run", taskId: "route", prompt: "route work", status: "succeeded", startedAt: now, endedAt: now, exitCode: 0, provider: "anthropic", model: "claude-opus-5-5@opencode", harness: "opencode" },
      )
      s.runSessions.push(
        { runId: "claude-run", sessionId: "claude-session", provider: "anthropic", harness: "claude" },
        { runId: "opencode-run", sessionId: "opencode-session", provider: "anthropic", harness: "opencode" },
      )
      s.messages.push(
        { id: "claude-message", taskId: "route", runId: "claude-run", role: "user", text: "Claude context", createdAt: now },
        { id: "opencode-message", taskId: "route", runId: "opencode-run", role: "user", text: "OpenCode context", createdAt: now },
      )
      return Either.right(undefined)
    })

    yield* core.sendMessage("owner", "route", "Next via OpenCode", { model: "claude-opus-5-5@opencode" }, [], false)
    expect(spawned.at(-1)!.resumeSession).toBe("opencode-session")

    // Finish the synthetic run so the next message starts a new one, as a real run would.
    yield* store.update((s) => {
      for (const run of s.runs) if (run.taskId === "route" && run.status === "running") run.status = "succeeded"
      const task = s.tasks.find((t) => t.id === "route")
      if (task) task.status = "idle"
      return Either.right(undefined)
    })

    yield* core.sendMessage("owner", "route", "Back on Claude", { model: "claude-opus-5-5" }, [], false)
    // The newer OpenCode session has the same provider but a different native session store; reusing it would
    // hand an OpenCode session id to Claude Code.
    expect(spawned.at(-1)!.resumeSession).toBe("claude-session")
  }))
}, 20_000)


test("a failed run invalidates only its own harness, and a restart interruption does not invalidate", async () => {
  await withCore((core, store, spawned) => Effect.gen(function* () {
    const now = new Date().toISOString()
    yield* store.update((s) => {
      const task = (id: string) => ({ id, owner: "owner", title: id, status: "idle" as const, createdAt: now, updatedAt: now, checkouts: [] })
      s.tasks.push(task("other-harness-failure"), task("failed-harness"), task("return-to-failed"), task("restart-interrupted"), task("failed-with-session"))
      type Status = "succeeded" | "failed" | "running"
      const run = (id: string, taskId: string, harness: "claude" | "opencode", status: Status, extra: { interruptedByRestart?: boolean } = {}) => ({
        id, taskId, prompt: id, status, startedAt: now, endedAt: status === "running" ? null : now,
        exitCode: status === "failed" ? 1 : 0, provider: "anthropic" as const,
        model: harness === "opencode" ? "claude-opus-5-5@opencode" as const : "claude-opus-5-5" as const,
        harness, ...extra,
      })
      s.runs.push(
        // A Claude session survives a later OpenCode failure; the failure still invalidates OpenCode's own resume.
        run("C1", "other-harness-failure", "claude", "succeeded"),
        run("O1", "other-harness-failure", "opencode", "succeeded"),
        run("O2", "other-harness-failure", "opencode", "failed"),
        // A Claude failure cannot have broken the OpenCode session.
        run("O3", "failed-harness", "opencode", "succeeded"),
        run("C2", "failed-harness", "claude", "failed"),
        // Switching harnesses after a failed resume does not make that harness resumable again.
        run("C3", "return-to-failed", "claude", "succeeded"),
        run("C4", "return-to-failed", "claude", "failed"),
        run("O4", "return-to-failed", "opencode", "succeeded"),
        // A run stopped by a box restart never got to prove the session broken.
        run("C5", "restart-interrupted", "claude", "succeeded"),
        run("C6", "restart-interrupted", "claude", "failed", { interruptedByRestart: true }),
        // A failure that happened after the CLI named its session can still be continued (usage-limit retries rely on it).
        run("C7", "failed-with-session", "claude", "succeeded"),
        run("C8", "failed-with-session", "claude", "failed"),
      )
      s.runSessions.push(
        { runId: "C1", sessionId: "claude-C1", provider: "anthropic", harness: "claude", continuation: "cli-login:generation-1" },
        { runId: "O1", sessionId: "opencode-O1", provider: "anthropic", harness: "opencode" },
        { runId: "O3", sessionId: "opencode-O3", provider: "anthropic", harness: "opencode" },
        { runId: "C3", sessionId: "claude-C3", provider: "anthropic", harness: "claude" },
        { runId: "O4", sessionId: "opencode-O4", provider: "anthropic", harness: "opencode" },
        { runId: "C5", sessionId: "claude-C5", provider: "anthropic", harness: "claude", continuation: "cli-login:generation-1" },
        { runId: "C7", sessionId: "claude-C7", provider: "anthropic", harness: "claude" },
        { runId: "C8", sessionId: "claude-C8", provider: "anthropic", harness: "claude" },
      )
      const message = (id: string, taskId: string, runId: string, text: string) =>
        ({ id, taskId, runId, role: "user" as const, text, createdAt: now })
      s.messages.push(
        message("c1-user", "other-harness-failure", "C1", "Claude opening"),
        message("o1-user", "other-harness-failure", "O1", "OpenCode work"),
        message("o2-user", "other-harness-failure", "O2", "OpenCode failed resume"),
        message("o3-user", "failed-harness", "O3", "OpenCode opening"),
        message("c2-user", "failed-harness", "C2", "Claude failed resume"),
        message("c3-user", "return-to-failed", "C3", "Claude opening"),
        message("c4-user", "return-to-failed", "C4", "Claude failed resume"),
        message("o4-user", "return-to-failed", "O4", "OpenCode work since"),
        message("c5-user", "restart-interrupted", "C5", "Claude opening"),
        message("c6-user", "restart-interrupted", "C6", "Interrupted by restart"),
        message("c7-user", "failed-with-session", "C7", "Claude opening"),
        message("c8-user", "failed-with-session", "C8", "Failed after naming a session"),
      )
      return Either.right(undefined)
    })

    const claude = { model: "claude-opus-5-5" as const }
    const opencode = { model: "claude-opus-5-5@opencode" as const }
    const finish = (taskId: string) => store.update((s) => {
      for (const run of s.runs) if (run.taskId === taskId && run.status === "running") { run.status = "succeeded"; run.endedAt = now }
      const task = s.tasks.find((t) => t.id === taskId)
      if (task) task.status = "idle"
      return Either.right(undefined)
    })

    // OpenCode failing to resume its own session invalidates only OpenCode: Claude's session still resumes.
    yield* core.sendMessage("owner", "other-harness-failure", "Back on Claude", claude, [], false)
    const survived = spawned.at(-1)!
    expect(survived.resumeSession).toBe("claude-C1")
    expect(survived.resumeHarness).toBe("claude")
    expect(survived.resumeContinuation).toBe("cli-login:generation-1")
    expect(survived.prompt).toContain("OpenCode work")
    expect(survived.prompt).toContain("OpenCode failed resume")
    expect(survived.prompt).not.toContain("Claude opening")

    // A Claude failure does not poison the provider's OpenCode session.
    yield* core.sendMessage("owner", "failed-harness", "Continue on OpenCode", opencode, [], false)
    const isolated = spawned.at(-1)!
    expect(isolated.resumeSession).toBe("opencode-O3")
    expect(isolated.resumeHarness).toBe("opencode")
    expect(isolated.prompt).toContain("Claude failed resume")
    expect(isolated.prompt).not.toContain("OpenCode opening")

    // Returning to the harness whose resume failed starts fresh with the whole conversation...
    yield* core.sendMessage("owner", "return-to-failed", "Back on Claude", claude, [], false)
    const fresh = spawned.at(-1)!
    expect(fresh.resumeSession).toBeNull()
    expect(fresh.prompt).toContain("Claude opening")
    expect(fresh.prompt).toContain("Claude failed resume")
    expect(fresh.prompt).toContain("OpenCode work since")
    yield* finish("return-to-failed")
    // ...while the other harness still resumes its own later session, unpoisoned.
    yield* core.sendMessage("owner", "return-to-failed", "Continue on OpenCode", opencode, [], false)
    const other = spawned.at(-1)!
    expect(other.resumeSession).toBe("opencode-O4")
    expect(other.resumeHarness).toBe("opencode")
    expect(other.prompt).not.toContain("Claude failed resume")

    // A restart interruption is not evidence that the session is broken.
    yield* core.sendMessage("owner", "restart-interrupted", "After the restart", claude, [], false)
    const restarted = spawned.at(-1)!
    expect(restarted.resumeSession).toBe("claude-C5")
    expect(restarted.resumeContinuation).toBe("cli-login:generation-1")
    expect(restarted.prompt).toContain("Interrupted by restart")
    expect(restarted.prompt).not.toContain("Claude opening")

    // A failed run that had already named a session resumes it: that is how automatic retries continue.
    yield* core.sendMessage("owner", "failed-with-session", "Retry the failed turn", claude, [], false)
    const retried = spawned.at(-1)!
    expect(retried.resumeSession).toBe("claude-C8")
    expect(retried.resumeHarness).toBe("claude")
    // That session already holds the failed turn, so only the new message is handed over.
    expect(retried.prompt).not.toContain("Failed after naming a session")
    expect(retried.prompt).toContain("Retry the failed turn")
  }))
}, 20_000)

test("an automatic delivery keeps the thread's harness, and starts fresh when that harness's resume failed", async () => {
  await withCore((core, store, spawned) => Effect.gen(function* () {
    const now = new Date().toISOString()
    yield* store.update((s) => {
      const task = (id: string, status: "running" | "idle") => ({ id, owner: "owner", title: id, status, createdAt: now, updatedAt: now, checkouts: [] })
      s.tasks.push(task("sender", "running"), task("switched", "idle"), task("failed-resume", "idle"))
      s.runs.push(
        { id: "sender-run", taskId: "sender", prompt: "work", status: "running", startedAt: now, endedAt: null, exitCode: null, provider: "openai" },
        { id: "claude-run", taskId: "switched", prompt: "claude", status: "succeeded", startedAt: now, endedAt: now, exitCode: 0, provider: "anthropic", model: "claude-opus-5-5", harness: "claude" },
        { id: "opencode-run", taskId: "switched", prompt: "opencode", status: "succeeded", startedAt: now, endedAt: now, exitCode: 0, provider: "anthropic", model: "claude-opus-5-5@opencode", harness: "opencode" },
        { id: "opencode-old", taskId: "failed-resume", prompt: "opencode", status: "succeeded", startedAt: now, endedAt: now, exitCode: 0, provider: "anthropic", model: "claude-opus-5-5@opencode", harness: "opencode" },
        { id: "opencode-broken", taskId: "failed-resume", prompt: "broken", status: "failed", startedAt: now, endedAt: now, exitCode: 1, provider: "anthropic", model: "claude-opus-5-5@opencode", harness: "opencode" },
      )
      s.runSessions.push(
        { runId: "claude-run", sessionId: "claude-session", provider: "anthropic", harness: "claude" },
        { runId: "opencode-run", sessionId: "opencode-session", provider: "anthropic", harness: "opencode" },
        { runId: "opencode-old", sessionId: "opencode-old-session", provider: "anthropic", harness: "opencode" },
      )
      s.messages.push(
        { id: "claude-message", taskId: "switched", runId: "claude-run", role: "user", text: "Claude context", createdAt: now },
        { id: "opencode-message", taskId: "switched", runId: "opencode-run", role: "user", text: "OpenCode context", createdAt: now },
        { id: "old-message", taskId: "failed-resume", runId: "opencode-old", role: "user", text: "OpenCode earlier", createdAt: now },
        { id: "broken-message", taskId: "failed-resume", runId: "opencode-broken", role: "user", text: "OpenCode broken resume", createdAt: now },
      )
      return Either.right(undefined)
    })

    yield* core.sendToThread("sender", "switched", "Peer follow-up")
    const switched = spawned.at(-1)!
    // Dropping the route would silently hand the thread back to Claude Code's session store.
    expect(modelHarness(switched.choice.model!)).toBe("opencode")
    expect(switched.resumeSession).toBe("opencode-session")
    expect(switched.resumeHarness).toBe("opencode")
    expect(switched.prompt).not.toContain("OpenCode context")

    yield* core.sendToThread("sender", "failed-resume", "Peer follow-up")
    const failed = spawned.at(-1)!
    // The harness stays OpenCode (the conversation ran there), but the failed resume is not retried.
    expect(modelHarness(failed.choice.model!)).toBe("opencode")
    expect(failed.resumeSession).toBeNull()
    expect(failed.prompt).toContain("OpenCode earlier")
    expect(failed.prompt).toContain("OpenCode broken resume")
  }))
}, 20_000)
