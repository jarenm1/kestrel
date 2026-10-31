import { expect, test } from "bun:test"
import { Effect, Either, Layer } from "effect"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { Run, Task } from "@cloudagents/protocol"
import { CredentialBroker } from "../broker"
import { CliAuth } from "../cliauth"
import { Config, type ServerConfig } from "../config"
import { AgentHarness, AgentHarnessLive } from "./harness"
import { EventHub, EventHubLive } from "./events"
import { StateLive, StateStore } from "./state"
import { WorkspaceLive } from "./workspace"

test("Claude finishes a queued turn after EOF without the process-exit grace killing it", async () => {
  const root = await mkdtemp(join(tmpdir(), "kestrel-queued-turn-"))
  const cli = join(root, "cli.ts")
  // A real subprocess with Claude's two-result lifecycle. The queued turn takes longer than the exit grace,
  // and starts only after EOF, so the test also proves the harness closes the input after the first result.
  // Fake clocks cannot control both the harness and its separate child process; this integration uses real time.
  await writeFile(cli, `
import { createInterface } from "node:readline"
let messages = 0
const send = (message) => console.log(JSON.stringify(message))
createInterface({ input: process.stdin })
  .on("line", (line) => {
    if (JSON.parse(line).type === "user" && ++messages === 2) {
      send({ type: "result", subtype: "success", is_error: false, queued_turn_count: 1 })
    }
  })
  .on("close", () => {
    setTimeout(() => send({ type: "result", subtype: "success", is_error: false,
      queued_turn_count: 0, result: "Queued answer finished." }), 4000)
  })
`)
  const config: ServerConfig = {
    port: 8897,
    host: "127.0.0.1",
    mcpBaseUrl: "http://127.0.0.1:8897",
    dataDir: root,
    stateFile: join(root, "state.json"),
    mirrorsDir: join(root, "mirrors"),
    threadsDir: join(root, "threads"),
    shadowsDir: join(root, "shadows"),
    runsDir: join(root, "runs"),
    attachmentsDir: join(root, "attachments"),
    homesDir: join(root, "homes"),
    agentCommands: {
      anthropic: [process.execPath, cli].map((path) => `'${path.replaceAll("\\", "/").replaceAll("'", "'\\''")}'`).join(" "),
      openai: "",
    },
    fakeAgent: false,
    fakeAgentRoBinds: [],
    sandboxEnabled: false,
    sandboxPath: null,
    sandboxSslCertFile: null,
    systemd: null,
    relay: null,
    direct: null,
    toolkitsFlake: null,
    taskDiskMax: 1024 ** 3,
    desktopBundleMs: 0,
    githubApiUrl: "https://api.github.com",
  }
  const configLayer = Layer.succeed(Config, config)
  const dependencies = Layer.mergeAll(
    configLayer,
    StateLive.pipe(Layer.provide(Layer.merge(configLayer, WorkspaceLive))),
    EventHubLive,
    Layer.succeed(CredentialBroker, {
      issue: () => Effect.succeed({ token: "test-only", env: {} }),
      revoke: () => Effect.void,
      grantForToken: () => Effect.succeed(null),
      onRevoke: () => () => undefined,
      upstreamKey: () => Effect.succeed(null),
    }),
    Layer.succeed(CliAuth, {
      loggedInDirs: () => Effect.succeed([]),
      status: () => Effect.succeed([]),
      startLogin: () => Effect.die("unused"),
      submitCode: () => Effect.die("unused"),
      logout: () => Effect.void,
      discoverCommands: () => Effect.succeed([]),
      shutdown: () => Effect.void,
    }),
  )
  try {
    await Effect.runPromise(Effect.gen(function* () {
      const store = yield* StateStore
      const harness = yield* AgentHarness
      const hub = yield* EventHub
      const now = new Date().toISOString()
      const task: Task = { id: "task", owner: "test", title: "Queued turn", status: "running", createdAt: now, updatedAt: now, checkouts: [] }
      const run: Run = { id: "run", taskId: task.id, prompt: "First message", status: "running", startedAt: now, endedAt: null, exitCode: null, provider: "anthropic" }
      yield* store.update((state) => {
        state.tasks.push(task)
        state.runs.push(run)
        return Either.right(null)
      })
      yield* Effect.promise(() => mkdir(join(config.threadsDir, task.id), { recursive: true }))
      const finished = Promise.withResolvers<void>()
      const unsubscribe = hub.subscribe(task.id, (event) => {
        if (event._tag === "run.updated" && event.run.status !== "running") finished.resolve()
      })
      try {
        yield* harness.spawn(task, run, run.prompt, null, task.owner, null, {})
        expect(yield* harness.steer(run.id, "Queued message")).toBe(true)
        yield* Effect.promise(() => finished.promise).pipe(Effect.timeout("8 seconds"))
        const state = yield* store.read
        expect(state.runs[0]).toMatchObject({ status: "succeeded", exitCode: 0 })
        expect(state.messages.at(-1)?.text).toBe("Queued answer finished.")
      } finally {
        unsubscribe()
        yield* harness.stopAll()
      }
    }).pipe(Effect.provide(AgentHarnessLive.pipe(Layer.provide(dependencies), Layer.provideMerge(dependencies)))))
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}, 12_000)
