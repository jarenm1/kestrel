import { expect, test } from "bun:test"
import { Effect, Either, Layer } from "effect"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { Config, type ServerConfig } from "../config"
import { CredentialBroker } from "../broker"
import { CredentialStore } from "../credentials"
import { CliAuth } from "../cliauth"
import { DesktopManager } from "../desktop"
import { GitHub } from "../github/api"
import { AgentHarness, AgentHarnessLive } from "./harness"
import { EventHubLive } from "./events"
import { CoreLive, CoreService } from "./service"
import { StateLive, StateStore } from "./state"
import { WorkspaceLive } from "./workspace"

test("a waiting parent releases the only run slot so a real child can finish", async () => {
  const root = await mkdtemp(join(tmpdir(), "kestrel-delegate-harness-"))
  const cli = join(root, "agent.ts")
  await writeFile(cli, `
import { createInterface } from "node:readline"
let hold
createInterface({ input: process.stdin }).on("line", (line) => {
  const message = JSON.parse(line)
  if (message.type === "control_request") {
    console.log(JSON.stringify({ type: "result", subtype: "error_during_execution", is_error: true }))
    return
  }
  if (message.type !== "user") return
  hold ??= message.message.content.includes("hold parent")
  if (!hold) console.log(JSON.stringify({ type: "result", subtype: "success", is_error: false, result: "Child finished successfully" }))
})
`)
  const config: ServerConfig = {
    port: 8899, host: "127.0.0.1", sandboxPort: 8899, mcpBaseUrl: "http://127.0.0.1:8899", dataDir: root,
    stateFile: join(root, "state.json"), mirrorsDir: join(root, "mirrors"), threadsDir: join(root, "threads"),
    shadowsDir: join(root, "shadows"), runsDir: join(root, "runs"), attachmentsDir: join(root, "attachments"), homesDir: join(root, "homes"),
    agentCommands: { anthropic: [process.execPath, cli].map((s) => `'${s.replaceAll("'", "'\\''")}'`).join(" "), openai: "", opencode: "", google: "", omp: "", pi: "", hermes: "" },
    fakeAgent: false, fakeAgentRoBinds: [], sandbox: "off", sandboxPath: null, sandboxSslCertFile: null, systemd: null,
    maxConcurrentRuns: 1, relay: null, direct: null, toolkitsFlake: null, taskDiskMax: 1024 ** 3,
    githubApiUrl: "https://api.github.com",
    webrtc: { iceServers: [], turn: null, policy: "all", portRange: null, hostAddresses: [], denyPrivate: false },
  }
  const configLayer = Layer.succeed(Config, config)
  const deps = Layer.mergeAll(
    configLayer, WorkspaceLive, StateLive.pipe(Layer.provide(Layer.merge(configLayer, WorkspaceLive))), EventHubLive,
    Layer.succeed(CredentialBroker, {
      issue: () => Effect.succeed({ token: "test-only", env: {} }), revoke: () => Effect.void,
      grantForToken: () => Effect.succeed(null), onRevoke: () => () => undefined, upstreamKey: () => Effect.succeed(null),
    }),
    Layer.succeed(CliAuth, { loggedInDirs: () => Effect.succeed([]), status: () => Effect.succeed([]), startLogin: () => Effect.die("unused"), submitCode: () => Effect.die("unused"), logout: () => Effect.void, discoverCommands: () => Effect.succeed([]), providerUsage: () => Effect.succeed([]), useBankedReset: () => Effect.die("unused"), shutdown: () => Effect.void }),
    Layer.succeed(DesktopManager, { watchStatus: () => Effect.void, status: () => Effect.succeed({ state: "stopped", display: null }), stopAll: () => Effect.void } as never),
    Layer.succeed(CredentialStore, {
      get: () => Effect.succeed({ user: "test", dev: true, anthropic: "test-anthropic", openai: "test-openai" }),
    } as never),
    Layer.succeed(GitHub, {} as never),
  )
  const harness = AgentHarnessLive.pipe(Layer.provide(deps), Layer.provideMerge(deps))
  try {
    await Effect.runPromise(Effect.gen(function* () {
      const store = yield* StateStore
      const core = yield* CoreService
      const agent = yield* AgentHarness
      const now = new Date().toISOString()
      yield* store.update((s) => {
        s.tasks.push({ id: "parent", owner: "owner", title: "Parent", status: "running", createdAt: now, updatedAt: now, checkouts: [] })
        s.runs.push({ id: "parent-run", taskId: "parent", prompt: "hold parent", status: "running", startedAt: now, endedAt: null, exitCode: null, provider: "anthropic" })
        return Either.right(undefined)
      })
      try {
        yield* Effect.promise(() => mkdir(join(config.threadsDir, "parent"), { recursive: true }))
        const initial = yield* store.read
        yield* agent.spawn(initial.tasks.find((t) => t.id === "parent")!, initial.runs.find((r) => r.id === "parent-run")!, { fresh: "hold parent", resume: null }, null, "owner", {})
        const child = yield* core.delegate("parent", "parent-run", { title: "Child", message: "Do the task", requestId: "once" })
        const sibling = yield* core.delegate("parent", "parent-run", { title: "Sibling", message: "Do the other task", requestId: "twice" })
        let queued = false
        for (let i = 0; i < 20; i++) {
          if ((yield* agent.items(child.delegation!.runId!)).some((item) => item._tag === "tool" && item.output?.includes("Waiting for a free run slot"))) { queued = true; break }
          yield* Effect.sleep("50 millis")
        }
        expect(queued).toBe(true)
        const waitFor = (id: string) => agent.withSlotReleased("parent", "parent-run", Effect.gen(function* () {
          for (let i = 0; i < 60; i++) {
            if ((yield* core.delegatedStatus("parent", id)).run?.status === "succeeded") return true
            yield* Effect.sleep("100 millis")
          }
          return false
        }))
        expect(yield* Effect.all([waitFor(child.id), waitFor(sibling.id)], { concurrency: "unbounded" })).toEqual([true, true])
        let delivered = false
        for (let i = 0; i < 30; i++) {
          if ((yield* store.read).messages.some((m) => m.id === `delegation-result:${child.id}` && m.text.includes("Child finished successfully"))) { delivered = true; break }
          yield* Effect.sleep("100 millis")
        }
        expect(delivered).toBe(true)
        expect((yield* core.delegatedStatus("parent", child.id)).run?.status).toBe("succeeded")
        const third = yield* core.delegate("parent", "parent-run", { title: "Third", message: "Do more work", requestId: "third" })
        let thirdQueued = false
        for (let i = 0; i < 20; i++) {
          if ((yield* agent.items(third.delegation!.runId!)).some((item) => item._tag === "tool" && item.output?.includes("Waiting for a free run slot"))) { thirdQueued = true; break }
          yield* Effect.sleep("50 millis")
        }
        expect(thirdQueued).toBe(true)
      } finally {
        yield* agent.stopAll()
        // Stop records cancellation before the CLI has exited. Wait for it before deleting its cwd on Windows.
        for (let i = 0; i < 100 && (yield* agent.activeRunCount()) > 0; i++) yield* Effect.sleep("50 millis")
        expect(yield* agent.activeRunCount()).toBe(0)
      }
    }).pipe(Effect.provide(CoreLive.pipe(Layer.provide(harness), Layer.provideMerge(harness)))))
  } finally { await rm(root, { recursive: true, force: true }) }
}, 12_000)
