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

/** A harness whose Claude CLI is `cli`, with its state under `root`. `loggedInDirs` runs at every launch. */
const harnessLayer = (
  root: string,
  cli: string,
  options: { readonly maxConcurrentRuns?: number; readonly loggedInDirs?: () => Effect.Effect<[]> } = {},
) => {
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
    sandbox: "off",
    sandboxPath: null,
    sandboxSslCertFile: null,
    systemd: null,
    maxConcurrentRuns: options.maxConcurrentRuns ?? 0,
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
      loggedInDirs: options.loggedInDirs ?? (() => Effect.succeed([])),
      status: () => Effect.succeed([]),
      startLogin: () => Effect.die("unused"),
      submitCode: () => Effect.die("unused"),
      logout: () => Effect.void,
      discoverCommands: () => Effect.succeed([]),
      providerUsage: () => Effect.succeed([]),
      useBankedReset: () => Effect.die("unused"),
      shutdown: () => Effect.void,
    }),
  )
  return { config, layer: AgentHarnessLive.pipe(Layer.provide(dependencies), Layer.provideMerge(dependencies)) }
}

const runningTask = (id: string): { task: Task; run: Run } => {
  const now = new Date().toISOString()
  return {
    task: { id, owner: "test", title: id, status: "running", createdAt: now, updatedAt: now, checkouts: [] },
    run: { id: `${id}-run`, taskId: id, prompt: "First message", status: "running", startedAt: now, endedAt: null, exitCode: null, provider: "anthropic" },
  }
}

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
  const { config, layer } = harnessLayer(root, cli)
  try {
    await Effect.runPromise(Effect.gen(function* () {
      const store = yield* StateStore
      const harness = yield* AgentHarness
      const hub = yield* EventHub
      const { task, run } = runningTask("task")
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
        expect((yield* harness.steer(run.id, "Queued message")).accepted).toBe(true)
        yield* Effect.promise(() => finished.promise).pipe(Effect.timeout("8 seconds"))
        const state = yield* store.read
        expect(state.runs[0]).toMatchObject({ status: "succeeded", exitCode: 0 })
        expect(state.messages.at(-1)?.text).toBe("Queued answer finished.")
      } finally {
        unsubscribe()
        yield* harness.stopAll()
      }
    }).pipe(Effect.provide(layer)))
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}, 12_000)

test("a run's item count includes its queue item while it waits and launches; a steer reports the count it was sent at", async () => {
  const root = await mkdtemp(join(tmpdir(), "kestrel-item-count-"))
  const cli = join(root, "cli.ts")
  // Answers the prompt with one text item and ends its turn on the next message (a steer); an interrupt (Stop)
  // ends the turn too. The harness closes the input once the turn is over, which ends the process.
  await writeFile(cli, `
import { createInterface } from "node:readline"
let messages = 0
const send = (message) => console.log(JSON.stringify(message))
createInterface({ input: process.stdin })
  .on("line", (line) => {
    const message = JSON.parse(line)
    if (message.type === "user" && ++messages === 1) {
      send({ type: "assistant", message: { id: "m1", role: "assistant", content: [{ type: "text", text: "Working." }] }, parent_tool_use_id: null })
    } else if (message.type === "user") {
      send({ type: "result", subtype: "success", is_error: false, result: "Done." })
    } else if (message.type === "control_request") {
      send({ type: "control_response", response: { subtype: "success", request_id: message.request_id, response: {} } })
      send({ type: "result", subtype: "error_during_execution", is_error: true })
    }
  })
  .on("close", () => process.exit(0))
`)
  // The second launch (the run that waited) stops before it starts its agent until the test lets it go on.
  const launching = Promise.withResolvers<void>()
  const proceed = Promise.withResolvers<void>()
  let launches = 0
  const { config, layer } = harnessLayer(root, cli, {
    maxConcurrentRuns: 1,
    loggedInDirs: () =>
      ++launches === 1
        ? Effect.succeed([])
        : Effect.promise(async () => {
            launching.resolve()
            await proceed.promise
            return [] as []
          }),
  })
  try {
    await Effect.runPromise(Effect.gen(function* () {
      const store = yield* StateStore
      const harness = yield* AgentHarness
      const hub = yield* EventHub
      const first = runningTask("first")
      const second = runningTask("second")
      yield* store.update((state) => {
        state.tasks.push(first.task, second.task)
        state.runs.push(first.run, second.run)
        return Either.right(null)
      })
      for (const { task } of [first, second]) {
        yield* Effect.promise(() => mkdir(join(config.threadsDir, task.id), { recursive: true }))
      }
      const waiting = Promise.withResolvers<void>()
      const answered = Promise.withResolvers<void>()
      const finished = Promise.withResolvers<void>()
      const unsubscribe = hub.subscribe(second.task.id, (event) => {
        if (event._tag === "agent.item" && event.item._tag === "tool" && event.item.status === "running") waiting.resolve()
        if (event._tag === "agent.item" && event.item._tag === "text") answered.resolve()
        if (event._tag === "run.updated" && event.run.status !== "running") finished.resolve()
      })
      try {
        yield* harness.spawn(first.task, first.run, first.run.prompt, null, "test", null, {})
        yield* harness.spawn(second.task, second.run, second.run.prompt, null, "test", null, {})
        // The run waits for its slot in the background; its queue item says it got as far as waiting.
        yield* Effect.promise(() => waiting.promise).pipe(Effect.timeout("8 seconds"))
        expect(harness.itemCount(second.run.id)).toBe(1) // "Waiting for a free run slot"

        yield* harness.cancel(first.run.id)
        yield* Effect.promise(() => launching.promise).pipe(Effect.timeout("8 seconds"))
        expect(harness.itemCount(second.run.id)).toBe(1) // "Started.", before the agent is up

        proceed.resolve()
        yield* Effect.promise(() => answered.promise).pipe(Effect.timeout("8 seconds"))
        expect(harness.itemCount(second.run.id)).toBe(2) // "Started." and the agent's text
        expect((yield* harness.items(second.run.id)).length).toBe(2)
        expect(yield* harness.steer(second.run.id, "Wrap up")).toEqual({ accepted: true, afterItems: 2 })
        // The run's finish is stored before the state directory goes.
        yield* Effect.promise(() => finished.promise).pipe(Effect.timeout("8 seconds"))
      } finally {
        unsubscribe()
        proceed.resolve()
        yield* harness.stopAll()
      }
    }).pipe(Effect.provide(layer)))
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}, 20_000)
