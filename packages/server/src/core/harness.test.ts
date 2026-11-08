import { expect, test } from "bun:test"
import { Effect, Either, Fiber, Layer } from "effect"
import { createServer } from "node:http"
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { Checkout, Message, ModelProvider, Run, Task } from "@cloudagents/protocol"
import { CredentialBroker, CredentialBrokerLive } from "../broker"
import { handleBroker } from "../broker/handler"
import { CliAuth, type CliLoginDir } from "../cliauth"
import { Config, type ServerConfig } from "../config"
import { CredentialStore } from "../credentials"
import { DesktopManager } from "../desktop"
import { GitHub } from "../github/api"
import { AgentHarness, AgentHarnessLive } from "./harness"
import { EventHub, EventHubLive } from "./events"
import { CoreLive, CoreService } from "./service"
import { StateLive, StateStore } from "./state"
import { WorkspaceLive, WorkspaceService } from "./workspace"

/**
 * A harness whose Claude CLI is `cli`, with its state under `root`. `loggedInDirs` runs at every launch; `gateways`
 * runs the gateway providers on the same Claude Code, as they do in production.
 */
const harnessLayer = (
  root: string,
  cli: string,
  options: {
    readonly maxConcurrentRuns?: number
    readonly loggedInDirs?: () => Effect.Effect<ReadonlyArray<CliLoginDir>>
    readonly controlUrl?: string
    readonly realBroker?: boolean
    readonly fakeAgent?: boolean
    readonly gateways?: ReadonlyArray<ModelProvider>
  } = {},
) => {
  const cliCommand = [process.execPath, cli].map((path) => `'${path.replaceAll("\\", "/").replaceAll("'", "'\\''")}'`).join(" ")
  const config: ServerConfig = {
    port: 8897,
    host: "127.0.0.1",
    sandboxPort: 8897,
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
      anthropic: cliCommand,
      openai: "",
      openrouter: "",
      zai: "",
      deepseek: "",
      minimax: "",
      moonshot: "",
      opencode: "",
      "opencode-go": "",
      google: "",
      devin: "",
      ...Object.fromEntries((options.gateways ?? []).map((provider) => [provider, cliCommand] as const)),
    },
    agentRouteCommands: {
      claude: cliCommand,
      codex: cliCommand,
      opencode: cliCommand,
    },
    fakeAgent: options.fakeAgent ?? false,
    fakeAgentRoBinds: [],
    sandbox: "off",
    sandboxPath: null,
    sandboxSslCertFile: null,
    systemd: null,
    maxConcurrentRuns: options.maxConcurrentRuns ?? 0,
    nest: null,
    relay: options.controlUrl ? { controlUrl: options.controlUrl, boxToken: "test-token" } : null,
    direct: null,
    toolkitsFlake: null,
    taskDiskMax: 1024 ** 3,
    webrtc: { iceServers: [], turn: null, policy: "all", portRange: null, hostAddresses: [], denyPrivate: false },
    githubApiUrl: "https://api.github.com",
  }
  const configLayer = Layer.succeed(Config, config)
  const credentialLayer = Layer.succeed(CredentialStore, {
    get: () => Effect.succeed({ user: "test", dev: true, anthropic: "test-anthropic", openai: "test-openai" }),
  } as never)
  const dependencies = Layer.mergeAll(
    configLayer,
    StateLive.pipe(Layer.provide(Layer.merge(configLayer, WorkspaceLive))),
    EventHubLive,
    // A run fails before it spawns without a model credential (a vendor key or its CLI login), so the fixture is
    // signed in: these tests exercise spawn, resume and items, not the Connections setup path.
    credentialLayer,
    Layer.succeed(GitHub, {} as never),
    options.realBroker
      ? CredentialBrokerLive.pipe(Layer.provide(Layer.merge(configLayer, credentialLayer)))
      : Layer.succeed(CredentialBroker, {
          issue: () => Effect.succeed({ token: "test-only", base: "", env: {} }),
          revoke: () => Effect.void,
          grantForToken: () => Effect.succeed(null),
          onRevoke: () => () => undefined,
          upstreamKey: () => Effect.succeed(null),
        }),
    Layer.succeed(CliAuth, {
      loggedInDirs: options.loggedInDirs ?? (() => Effect.succeed([])),
      opencodeGoKey: () => Effect.succeed(null),
      status: () => Effect.succeed([]),
      startLogin: () => Effect.die("unused"),
      cancelLogin: () => Effect.void,
      submitCode: () => Effect.die("unused"),
      submitKey: () => Effect.die("unused"),
      logout: () => Effect.void,
      selectAccount: () => Effect.die("unused"),
      discoverCommands: () => Effect.succeed([]),
      discoverModels: () => Effect.succeed({ models: [], sources: [] }),
      providerUsage: () => Effect.succeed([]),
      useBankedReset: () => Effect.die("unused"),
      shutdown: () => Effect.void,
    }),
  )
  return {
    config,
    layer: AgentHarnessLive.pipe(Layer.provide(dependencies), Layer.provideMerge(dependencies)),
  }
}

const runningTask = (id: string): { task: Task; run: Run } => {
  const now = new Date().toISOString()
  return {
    task: { id, owner: "test", title: id, status: "running", createdAt: now, updatedAt: now, checkouts: [] },
    run: { id: `${id}-run`, taskId: id, prompt: "First message", status: "running", startedAt: now, endedAt: null, exitCode: null, provider: "anthropic" },
  }
}

test("an agent exiting early reports its failed turn to the control plane", async () => {
  const root = await mkdtemp(join(tmpdir(), "kestrel-exit-telemetry-"))
  const cli = join(root, "cli.ts")
  await writeFile(cli, 'process.stdin.once("data", () => { console.error("Error: rate limit exceeded for /home/alice/private"); process.exit(1) })')
  const reports: unknown[] = []
  const server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: async (request) => {
    reports.push(await request.json())
    return new Response(null, { status: 204 })
  } })
  const { config, layer } = harnessLayer(root, cli, { controlUrl: server.url.toString() })
  try {
    await Effect.runPromise(Effect.gen(function* () {
      const store = yield* StateStore
      const harness = yield* AgentHarness
      const hub = yield* EventHub
      const { task, run } = runningTask("early-exit")
      yield* store.update((state) => { state.tasks.push(task); state.runs.push(run); return Either.right(null) })
      yield* Effect.promise(() => mkdir(join(config.threadsDir, task.id), { recursive: true }))
      const finished = Promise.withResolvers<void>()
      const unsubscribe = hub.subscribe(task.id, (event) => {
        if (event._tag === "run.updated" && event.run.status !== "running") finished.resolve()
      })
      try {
        yield* harness.spawn(task, run, { fresh: run.prompt, resume: null }, null, task.owner, {})
        yield* Effect.promise(() => finished.promise).pipe(Effect.timeout("8 seconds"))
        yield* harness.stopAll()
        expect(reports).toEqual([{ failures: [{ tool: "agent:claude", signature: "exited before turn finished: Error: rate limit exceeded for <path>: exit code 1", count: 1 }] }])
      } finally {
        unsubscribe()
        yield* harness.stopAll()
      }
    }).pipe(Effect.provide(layer)))
  } finally {
    server.stop(true)
    await rm(root, { recursive: true, force: true })
  }
}, 12_000)

test("Claude error results report the specific error rather than the result subtype", async () => {
  const root = await mkdtemp(join(tmpdir(), "kestrel-result-telemetry-"))
  const cli = join(root, "cli.ts")
  await writeFile(cli, 'process.stdin.once("data", () => console.log(JSON.stringify({ type: "result", subtype: "error_during_execution", is_error: true, errors: ["Rate limit exceeded"] })))')
  const reports: unknown[] = []
  const server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: async (request) => {
    reports.push(await request.json())
    return new Response(null, { status: 204 })
  } })
  const { config, layer } = harnessLayer(root, cli, { controlUrl: server.url.toString() })
  try {
    await Effect.runPromise(Effect.gen(function* () {
      const store = yield* StateStore
      const harness = yield* AgentHarness
      const hub = yield* EventHub
      const { task, run } = runningTask("error-result")
      yield* store.update((state) => { state.tasks.push(task); state.runs.push(run); return Either.right(null) })
      yield* Effect.promise(() => mkdir(join(config.threadsDir, task.id), { recursive: true }))
      const finished = Promise.withResolvers<void>()
      const unsubscribe = hub.subscribe(task.id, (event) => {
        if (event._tag === "run.updated" && event.run.status !== "running") finished.resolve()
      })
      try {
        yield* harness.spawn(task, run, { fresh: run.prompt, resume: null }, null, task.owner, {})
        yield* Effect.promise(() => finished.promise).pipe(Effect.timeout("8 seconds"))
        yield* harness.stopAll()
        expect(reports).toEqual([{ failures: [{ tool: "agent:claude", signature: "turn failed: error: Rate limit exceeded: exit code 0", count: 1 }] }])
      } finally {
        unsubscribe()
        yield* harness.stopAll()
      }
    }).pipe(Effect.provide(layer)))
  } finally {
    server.stop(true)
    await rm(root, { recursive: true, force: true })
  }
}, 12_000)

test("a delegated child's reported 'needs input' ends with its run unless a question is still pending", async () => {
  const root = await mkdtemp(join(tmpdir(), "kestrel-needs-input-"))
  const cli = join(root, "cli.ts")
  await writeFile(cli, 'process.stdin.once("data", () => console.log(JSON.stringify({ type: "result", subtype: "success", is_error: false, result: "Done." })))')
  const { config, layer } = harnessLayer(root, cli)
  const delegation = { parentTaskId: "parent", parentRunId: "parent-run", requestId: "r", fingerprint: "f" }
  try {
    await Effect.runPromise(Effect.gen(function* () {
      const store = yield* StateStore
      const harness = yield* AgentHarness
      const hub = yield* EventHub
      /** Runs `id` to completion with its task in `needs_input`, and returns the status the run leaves it in. */
      const finish = (id: string, setup: (task: Task, run: Run) => Partial<Task>, ask: boolean) => Effect.gen(function* () {
        const { task: base, run } = runningTask(id)
        const task = { ...base, ...setup(base, run), status: "needs_input" as const }
        yield* store.update((state) => {
          state.tasks.push(task)
          state.runs.push(run)
          if (ask) state.pendingAsks.push({ taskId: id, runId: run.id, messageId: `question:${id}` })
          return Either.right(null)
        })
        yield* Effect.promise(() => mkdir(join(config.threadsDir, id), { recursive: true }))
        const finished = Promise.withResolvers<void>()
        const unsubscribe = hub.subscribe(id, (event) => {
          if (event._tag === "run.updated" && event.run.status !== "running") finished.resolve()
        })
        try {
          yield* harness.spawn(task, run, { fresh: run.prompt, resume: null }, null, task.owner, {})
          yield* Effect.promise(() => finished.promise).pipe(Effect.timeout("8 seconds"))
        } finally {
          unsubscribe()
        }
        return (yield* store.read).tasks.find((t) => t.id === id)?.status
      })
      try {
        // The parent is waiting on the child's result; a report alone must not park the child after its run.
        expect(yield* finish("reported-child", (_, run) => ({ delegation: { ...delegation, runId: run.id } }), false)).toBe("done")
        // A question the user has not answered yet still holds it.
        expect(yield* finish("asking-child", (_, run) => ({ delegation: { ...delegation, runId: run.id } }), true)).toBe("needs_input")
        // A thread of the user's own keeps the state its agent reported until the user replies.
        expect(yield* finish("top-level", () => ({}), false)).toBe("needs_input")
      } finally {
        yield* harness.stopAll()
      }
    }).pipe(Effect.provide(layer)))
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}, 30_000)

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
        yield* harness.spawn(task, run, { fresh: run.prompt, resume: null }, null, task.owner, {})
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
        yield* harness.spawn(first.task, first.run, { fresh: first.run.prompt, resume: null }, null, "test", {})
        yield* harness.spawn(second.task, second.run, { fresh: second.run.prompt, resume: null }, null, "test", {})
        // The run waits for its slot in the background; its queue item says it got as far as waiting.
        yield* Effect.promise(() => waiting.promise).pipe(Effect.timeout("8 seconds"))
        expect(harness.itemCount(second.run.id)).toBe(1) // "Waiting for a free run slot"
        expect(yield* harness.items(second.run.id)).toMatchObject([
          { _tag: "tool", id: "queue", status: "running" },
        ])

        yield* harness.cancel(first.run.id)
        yield* Effect.promise(() => launching.promise).pipe(Effect.timeout("8 seconds"))
        expect(harness.itemCount(second.run.id)).toBe(1) // "Started.", before the agent is up
        // A run that waited and is still launching shows the same "Started." item the app already has.
        expect(yield* harness.items(second.run.id)).toMatchObject([
          { _tag: "tool", id: "queue", status: "ok" },
        ])

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

test("a run waiting for its slot back keeps its transcript instead of showing only its queue item", async () => {
  const root = await mkdtemp(join(tmpdir(), "kestrel-slot-lending-"))
  const cli = join(root, "cli.ts")
  // Keeps both turns open until steered, then exits through the harness's normal completion path.
  await writeFile(cli, `
import { createInterface } from "node:readline"
const send = (message) => console.log(JSON.stringify(message))
createInterface({ input: process.stdin })
  .on("line", (line) => {
    const message = JSON.parse(line)
    if (message.type === "user") {
      const text = typeof message.message.content === "string" ? message.message.content : "prompt"
      if (text === "Wrap up") send({ type: "result", subtype: "success", is_error: false, result: "Done." })
      else send({ type: "assistant", message: { id: "m-" + text, role: "assistant", content: [{ type: "text", text: "Working on " + text }] }, parent_tool_use_id: null })
    } else if (message.type === "control_request") {
      send({ type: "control_response", response: { subtype: "success", request_id: message.request_id, response: {} } })
      send({ type: "result", subtype: "error_during_execution", is_error: true })
    }
  })
  .on("close", () => process.exit(0))
`)
  const { config, layer } = harnessLayer(root, cli, { maxConcurrentRuns: 1 })
  try {
    await Effect.runPromise(Effect.gen(function* () {
      const store = yield* StateStore
      const harness = yield* AgentHarness
      const hub = yield* EventHub
      const parent = runningTask("parent")
      const child = runningTask("child")
      yield* store.update((state) => {
        state.tasks.push(parent.task, child.task)
        state.runs.push(parent.run, child.run)
        return Either.right(null)
      })
      for (const { task } of [parent, child]) {
        yield* Effect.promise(() => mkdir(join(config.threadsDir, task.id), { recursive: true }))
      }
      const answered = Promise.withResolvers<void>()
      const childAnswered = Promise.withResolvers<void>()
      const waitingAgain = Promise.withResolvers<void>()
      const childFinished = Promise.withResolvers<void>()
      const parentFinished = Promise.withResolvers<void>()
      const unsubscribeParent = hub.subscribe(parent.task.id, (event) => {
        if (event._tag === "run.updated" && event.run.status !== "running") parentFinished.resolve()
        if (event._tag !== "agent.item") return
        if (event.item._tag === "text") answered.resolve()
        // The parent gave its slot away and now waits for it back (withSlotReleased).
        if (event.item._tag === "tool" && event.item.id === "queue" && event.item.status === "running") waitingAgain.resolve()
      })
      const unsubscribeChild = hub.subscribe(child.task.id, (event) => {
        if (event._tag === "agent.item" && event.item._tag === "text") childAnswered.resolve()
        if (event._tag === "run.updated" && event.run.status !== "running") childFinished.resolve()
      })
      const release = Promise.withResolvers<void>()
      try {
        yield* harness.spawn(parent.task, parent.run, { fresh: parent.run.prompt, resume: null }, null, parent.task.owner, {})
        yield* Effect.promise(() => answered.promise).pipe(Effect.timeout("8 seconds"))
        // The child needs the slot the parent holds, as a delegated run does while its parent waits for it.
        yield* harness.spawn(child.task, child.run, { fresh: child.run.prompt, resume: null }, null, child.task.owner, {})
        const released = yield* Effect.fork(
          harness.withSlotReleased(parent.task.id, parent.run.id, Effect.promise(() => release.promise)),
        )
        yield* Effect.promise(() => childAnswered.promise).pipe(Effect.timeout("8 seconds"))
        release.resolve()
        // The parent gets the slot back only once the child is done; meanwhile it is queued again.
        yield* Effect.promise(() => waitingAgain.promise).pipe(Effect.timeout("8 seconds"))
        const items = yield* harness.items(parent.run.id)
        const liveCount = harness.itemCount(parent.run.id)
        yield* harness.steer(child.run.id, "Wrap up")
        yield* Effect.promise(() => childFinished.promise).pipe(Effect.timeout("8 seconds"))
        yield* Fiber.join(released).pipe(Effect.timeout("8 seconds"))
        const resumedItems = yield* harness.items(parent.run.id)
        yield* harness.steer(parent.run.id, "Wrap up")
        yield* Effect.promise(() => parentFinished.promise).pipe(Effect.timeout("8 seconds"))
        // Assert after both subprocesses have exited so a before-fix failure cannot race directory cleanup.
        expect(items.filter((item) => item._tag === "text")).toMatchObject([{ text: "Working on First message" }])
        expect(liveCount).toBe(items.length)
        expect(resumedItems).toMatchObject([{ _tag: "text", text: "Working on First message" }])
      } finally {
        unsubscribeParent()
        unsubscribeChild()
        release.resolve()
        yield* harness.stopAll()
      }
    }).pipe(Effect.provide(layer)))
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}, 20_000)

test("a run starts in the thread's first checkout, resumed or fresh, and in the workspace root once that checkout is gone or a link", async () => {
  const root = await mkdtemp(join(tmpdir(), "kestrel-run-cwd-"))
  const cli = join(root, "cli.ts")
  // Answers the prompt with its working directory and the session it was asked to resume, then ends when the
  // harness closes its input.
  await writeFile(cli, `
import { createInterface } from "node:readline"
createInterface({ input: process.stdin })
  .on("line", (line) => {
    if (JSON.parse(line).type === "user") {
      const result = process.cwd() + " resume=" + (process.env.CLOUDAGENTS_RESUME_SESSION ?? "none")
      console.log(JSON.stringify({ type: "result", subtype: "success", is_error: false, result }))
    }
  })
  .on("close", () => process.exit(0))
`)
  const { config, layer } = harnessLayer(root, cli)
  const checkout = (dir: string): Checkout => ({ id: dir, repo: `owner/${dir}`, dir, branch: "b", baseBranch: "main", createdAt: "" })
  try {
    await Effect.runPromise(Effect.gen(function* () {
      const store = yield* StateStore
      const harness = yield* AgentHarness
      const hub = yield* EventHub
      const workspace = join(config.threadsDir, "task")
      yield* Effect.promise(() => mkdir(join(workspace, "app"), { recursive: true }))
      yield* Effect.promise(() => mkdir(join(workspace, "lib"), { recursive: true }))

      /** Where a run of a thread with `checkouts` started, and the session it resumed. */
      const runIn = (runId: string, checkouts: ReadonlyArray<Checkout>, resumeSession: string | null = null) =>
        Effect.gen(function* () {
          const base = runningTask("task")
          const task = { ...base.task, checkouts: [...checkouts] }
          const run = { ...base.run, id: runId }
          yield* store.update((state) => {
            state.tasks = [task]
            state.runs.push(run)
            return Either.right(null)
          })
          const finished = Promise.withResolvers<void>()
          const unsubscribe = hub.subscribe(task.id, (event) => {
            if (event._tag === "run.updated" && event.run.id === runId && event.run.status !== "running") finished.resolve()
          })
          try {
            const resume = resumeSession === null ? null : { sessionId: resumeSession, continuation: "task-home", prompt: run.prompt }
            yield* harness.spawn(task, run, { fresh: run.prompt, resume }, null, task.owner, {})
            yield* Effect.promise(() => finished.promise).pipe(Effect.timeout("8 seconds"))
          } finally {
            unsubscribe()
          }
          return (yield* store.read).messages.at(-1)?.text
        })

      try {
        expect(yield* runIn("no-checkout", [])).toBe(`${workspace} resume=none`)
        // A thread whose first run checked a repository out: its session was recorded in the workspace root, and the
        // next run resumes it from the checkout (Claude Code 2.1.308 finds a session recorded under a parent directory).
        expect(yield* runIn("resumed-after-checkout", [checkout("app")], "session-from-root")).toBe(
          `${join(workspace, "app")} resume=session-from-root`,
        )
        // The first checkout, not the latest: a second repository does not move the thread.
        expect(yield* runIn("two-checkouts", [checkout("app"), checkout("lib")])).toBe(`${join(workspace, "app")} resume=none`)
        // An agent can replace its checkout with a link to a host directory; the run must not start there.
        const outside = join(root, "outside")
        yield* Effect.promise(() => mkdir(outside, { recursive: true }))
        yield* Effect.promise(() => rm(join(workspace, "app"), { recursive: true, force: true }))
        yield* Effect.promise(() => symlink(outside, join(workspace, "app"), "junction"))
        expect(yield* runIn("symlinked-checkout", [checkout("app"), checkout("lib")])).toBe(`${workspace} resume=none`)
        // An agent can delete its checkout; the thread's next run must still start.
        yield* Effect.promise(() => rm(join(workspace, "app"), { recursive: true, force: true }))
        expect(yield* runIn("deleted-checkout", [checkout("app"), checkout("lib")])).toBe(`${workspace} resume=none`)
      } finally {
        yield* harness.stopAll()
      }
    }).pipe(Effect.provide(layer)))
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}, 30_000)

test("a run resumes only a session its CLI kept where it keeps sessions now, and records where it kept its own", async () => {
  const root = await mkdtemp(join(tmpdir(), "kestrel-run-continuation-"))
  const cli = join(root, "cli.ts")
  // Names a session after its run, then answers with the session it was asked to resume and the prompt it got.
  await writeFile(cli, `
import { createInterface } from "node:readline"
createInterface({ input: process.stdin })
  .on("line", (line) => {
    const message = JSON.parse(line)
    if (message.type !== "user") return
    console.log(JSON.stringify({ type: "system", subtype: "init", session_id: "session-" + process.env.CLOUDAGENTS_RUN_ID }))
    const result = "resume=" + (process.env.CLOUDAGENTS_RESUME_SESSION ?? "none") + " prompt=" + message.message.content
    console.log(JSON.stringify({ type: "result", subtype: "success", is_error: false, result }))
  })
  .on("close", () => process.exit(0))
`)
  const login: CliLoginDir = { provider: "claude-cli", dir: join(root, "login", "claude") }
  await mkdir(login.dir, { recursive: true })
  let loggedIn = false
  const { config, layer } = harnessLayer(root, cli, { loggedInDirs: () => Effect.succeed(loggedIn ? [login] : []) })
  try {
    await Effect.runPromise(Effect.gen(function* () {
      const store = yield* StateStore
      const harness = yield* AgentHarness
      const hub = yield* EventHub
      yield* Effect.promise(() => mkdir(join(config.threadsDir, "task"), { recursive: true }))

      /** The answer of a run offered `resume`, and where its own session was recorded. */
      const runWith = (runId: string, continuation: string | undefined) =>
        Effect.gen(function* () {
          const { task, run: base } = runningTask("task")
          const run = { ...base, id: runId }
          yield* store.update((state) => {
            state.tasks = [task]
            state.runs.push(run)
            return Either.right(null)
          })
          const finished = Promise.withResolvers<void>()
          const unsubscribe = hub.subscribe(task.id, (event) => {
            if (event._tag === "run.updated" && event.run.id === runId && event.run.status !== "running") finished.resolve()
          })
          try {
            const resume = { sessionId: "earlier", continuation, prompt: "delta" }
            yield* harness.spawn(task, run, { fresh: "whole conversation", resume }, null, task.owner, {})
            yield* Effect.promise(() => finished.promise).pipe(Effect.timeout("8 seconds"))
          } finally {
            unsubscribe()
          }
          const state = yield* store.read
          return {
            answer: state.messages.at(-1)?.text,
            recorded: state.runSessions.find((s) => s.runId === runId)?.continuation,
          }
        })

      try {
        expect(yield* runWith("home-to-home", "task-home")).toEqual({ answer: "resume=earlier prompt=delta", recorded: "task-home" })
        expect(yield* runWith("home-to-login-gone", "cli-login")).toEqual({ answer: "resume=none prompt=whole conversation", recorded: "task-home" })
        loggedIn = true
        // The user signed in: the CLI now looks for sessions in their login directory, where the earlier one is not.
        const connected = yield* runWith("login-from-home", "task-home")
        expect(connected.answer).toBe("resume=none prompt=whole conversation")
        expect(yield* runWith("login-to-login", connected.recorded)).toEqual({
          answer: "resume=earlier prompt=delta", recorded: connected.recorded,
        })
        // Disconnect deletes the native database. Reconnecting at the same path must not resume its deleted session.
        yield* Effect.promise(() => rm(login.dir, { recursive: true, force: true }))
        yield* Effect.promise(() => mkdir(login.dir, { recursive: true }))
        const reconnected = yield* runWith("reconnected", connected.recorded)
        expect(reconnected.answer).toBe("resume=none prompt=whole conversation")
        expect(reconnected.recorded).not.toBe(connected.recorded)
        expect(yield* runWith("after-reconnect", reconnected.recorded)).toEqual({
          answer: "resume=earlier prompt=delta", recorded: reconnected.recorded,
        })
        // A legacy login record has no generation: safely replay the conversation once.
        expect((yield* runWith("legacy-login", "cli-login")).answer).toBe("resume=none prompt=whole conversation")
        expect((yield* runWith("legacy-logged-in", undefined)).answer).toBe("resume=none prompt=whole conversation")
        loggedIn = false
        expect(yield* runWith("legacy-logged-out", undefined)).toEqual({ answer: "resume=none prompt=whole conversation", recorded: "task-home" })
      } finally {
        yield* harness.stopAll()
      }
    }).pipe(Effect.provide(layer)))
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}, 40_000)

test("a gateway run records its Claude session under its own provider, which an Anthropic turn cannot resume", async () => {
  const root = await mkdtemp(join(tmpdir(), "kestrel-gateway-session-"))
  const cli = join(root, "cli.ts")
  // Names its own session, then answers with the session it was asked to resume.
  await writeFile(cli, `
import { createInterface } from "node:readline"
createInterface({ input: process.stdin })
  .on("line", (line) => {
    const message = JSON.parse(line)
    if (message.type !== "user") return
    console.log(JSON.stringify({ type: "system", subtype: "init", session_id: "session-" + process.env.CLOUDAGENTS_RUN_ID }))
    console.log(JSON.stringify({ type: "result", subtype: "success", is_error: false, result: "resume=" + (process.env.CLOUDAGENTS_RESUME_SESSION ?? "none") }))
  })
  .on("close", () => process.exit(0))
`)
  // Gateways run the same Claude Code, so the fixture CLI is their harness too.
  const { config, layer: harness } = harnessLayer(root, cli, { gateways: ["openrouter"] })
  const layer = CoreLive.pipe(
    Layer.provide(Layer.mergeAll(
      harness,
      Layer.succeed(DesktopManager, {
        watchStatus: () => Effect.void,
        status: () => Effect.succeed({ state: "stopped", display: null }),
        stopAll: () => Effect.void,
      } as never),
      Layer.succeed(WorkspaceService, {} as never),
    )),
    Layer.provideMerge(harness),
  )
  try {
    await Effect.runPromise(Effect.gen(function* () {
      const store = yield* StateStore
      const core = yield* CoreService
      const agent = yield* AgentHarness
      const now = new Date().toISOString()
      yield* store.update((state) => {
        state.tasks.push({ id: "thread", owner: "test", title: "Thread", status: "idle", createdAt: now, updatedAt: now, checkouts: [] })
        return Either.right(undefined)
      })
      yield* Effect.promise(() => mkdir(join(config.threadsDir, "thread"), { recursive: true }))

      /**
       * Sends a message through the core, then returns the run's answer and the session it recorded. The session
       * record lands just after the run's last line, so it is awaited (the run's own state already says it is over).
       */
      const send = (text: string, model: "anthropic/claude-sonnet-5.5" | "claude-sonnet-5-5") =>
        Effect.gen(function* () {
          const { run } = yield* core.sendMessage("test", "thread", text, { model }, [], false)
          for (let i = 0; i < 100; i++) {
            const state = yield* store.read
            const finished = state.runs.find((r) => r.id === run.id)?.status !== "running"
            const session = state.runSessions.find((record) => record.runId === run.id)
            if (finished && session !== undefined) {
              return { runId: run.id, answer: state.messages.at(-1)?.text, session }
            }
            yield* Effect.sleep("50 millis")
          }
          throw new Error(`run ${run.id} did not finish with a recorded session`)
        })

      try {
        const gateway = yield* send("First message through the gateway", "anthropic/claude-sonnet-5.5")
        // The gateway's Claude Code names a session in its `init`; it belongs to the gateway, not to Anthropic.
        expect(gateway.session.sessionId).toBe(`session-${gateway.runId}`)
        expect(gateway.session.provider).toBe("openrouter")
        expect(gateway.session.continuation).toBe("task-home")
        expect(gateway.answer).toBe("resume=none")

        const anthropic = yield* send("An Anthropic follow-up", "claude-sonnet-5-5")
        // The Anthropic turn starts fresh: the gateway's session is not offered to it.
        expect(anthropic.answer).toBe("resume=none")
        expect(anthropic.session.provider).toBe("anthropic")

        // The gateway resumes its own session, with only what happened since.
        const back = yield* send("Back on the gateway", "anthropic/claude-sonnet-5.5")
        expect(back.answer).toBe(`resume=session-${gateway.runId}`)
      } finally {
        yield* agent.stopAll()
        // The test's cwd is removed below; a CLI that is still exiting would hold it on Windows.
        for (let i = 0; i < 100 && (yield* agent.activeRunCount()) > 0; i++) yield* Effect.sleep("50 millis")
      }
    }).pipe(Effect.provide(layer)))
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}, 40_000)

test("prompts reach stdin but not descendant environments, and diagnostics never become conversation", async () => {
  const root = await mkdtemp(join(tmpdir(), "kestrel-prompt-boundary-"))
  const cli = join(root, "cli.ts")
  await writeFile(cli, `
import { createInterface } from "node:readline"
import { spawnSync } from "node:child_process"
createInterface({ input: process.stdin }).on("line", (line) => {
  const message = JSON.parse(line)
  if (message.type !== "user") return
  const child = spawnSync(process.execPath, ["-e", 'console.log(JSON.stringify(process.env.CLOUDAGENTS_PROMPT ?? null))'], { encoding: "utf8" })
  const text = JSON.stringify({ received: message.message.content, inheritedPrompt: JSON.parse(child.stdout) })
  console.log("diagnostic stdout: " + message.message.content)
  console.error("diagnostic stderr: " + message.message.content)
  if (message.message.content !== "no answer") {
    console.log(JSON.stringify({ type: "assistant", parent_tool_use_id: null, message: { id: "answer", content: [{ type: "text", text }] } }))
  }
  console.log(JSON.stringify({ type: "result", subtype: "success", is_error: false }))
})
`)
  const { config, layer } = harnessLayer(root, cli)
  try {
    await Effect.runPromise(Effect.gen(function* () {
      const store = yield* StateStore
      const harness = yield* AgentHarness
      const hub = yield* EventHub
      for (const [id, prompt] of [["answer", "private user message"], ["empty", "no answer"]] as const) {
        const { task, run: base } = runningTask(id)
        const run = { ...base, prompt }
        yield* store.update((state) => {
          state.tasks.push(task)
          state.runs.push(run)
          return Either.right(undefined)
        })
        yield* Effect.promise(() => mkdir(join(config.threadsDir, task.id), { recursive: true }))
        const finished = Promise.withResolvers<void>()
        const unsubscribe = hub.subscribe(task.id, (event) => {
          if (event._tag === "run.updated" && event.run.status !== "running") finished.resolve()
        })
        try {
          yield* harness.spawn(task, run, { fresh: prompt, resume: null }, null, task.owner, {})
          yield* Effect.promise(() => finished.promise).pipe(Effect.timeout("8 seconds"))
          const message = (yield* store.read).messages.find((m) => m.runId === run.id)!
          if (id === "answer") expect(JSON.parse(message.text)).toEqual({ received: prompt, inheritedPrompt: null })
          else expect(message.text).toBe("Run finished with no output.")
        } finally {
          unsubscribe()
          yield* harness.stopAll()
        }
      }
    }).pipe(Effect.provide(layer)))
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}, 20_000)

test("a compaction drops the context stored on the task, not just the transcript's copy", async () => {
  const root = await mkdtemp(join(tmpdir(), "kestrel-context-drop-"))
  const cli = join(root, "cli.ts")
  // The test lets the CLI report the compaction only after the harness has published the pre-compaction context,
  // so the run's later drop cannot be confused with having never reported one.
  const compacted = join(root, "compacted")
  await writeFile(cli, `
import { existsSync } from "node:fs"
import { createInterface } from "node:readline"
const send = (message) => console.log(JSON.stringify(message))
createInterface({ input: process.stdin }).on("line", (line) => {
  if (JSON.parse(line).type !== "user") return
  send({ type: "system", subtype: "init", session_id: "s1", model: "claude-opus-5-5" })
  send({
    type: "assistant",
    message: {
      id: "m1",
      content: [{ type: "text", text: "Working." }],
      usage: { input_tokens: 10, cache_creation_input_tokens: 0, cache_read_input_tokens: 180_000, output_tokens: 100 },
    },
    parent_tool_use_id: null,
  })
  send({ type: "result", subtype: "success", is_error: false, usage: {}, modelUsage: { "claude-opus-5-5": { contextWindow: 200_000 } }, result: "Done." })
  const timer = setInterval(() => {
    if (!existsSync(${JSON.stringify(compacted)})) return
    clearInterval(timer)
    send({ type: "system", subtype: "compact_boundary", compact_metadata: { trigger: "manual", pre_tokens: 180_110 } })
    setTimeout(() => process.exit(0), 100)
  }, 20)
})
`)
  const { config, layer } = harnessLayer(root, cli)
  try {
    await Effect.runPromise(Effect.gen(function* () {
      const store = yield* StateStore
      const harness = yield* AgentHarness
      const hub = yield* EventHub
      const { task, run } = runningTask("compact")
      yield* store.update((state) => {
        state.tasks.push(task)
        state.runs.push(run)
        return Either.right(null)
      })
      yield* Effect.promise(() => mkdir(join(config.threadsDir, task.id), { recursive: true }))
      const reported = Promise.withResolvers<void>()
      const dropped = Promise.withResolvers<void>()
      const finished = Promise.withResolvers<void>()
      let sawContext = false
      const unsubscribe = hub.subscribe(task.id, (event) => {
        if (event._tag === "task.updated") {
          if (event.task.context?.usedTokens === 180_110) {
            sawContext = true
            reported.resolve()
          } else if (sawContext && event.task.context === undefined) {
            dropped.resolve()
          }
        }
        if (event._tag === "run.updated" && event.run.status !== "running") finished.resolve()
      })
      try {
        yield* harness.spawn(task, run, { fresh: run.prompt, resume: null }, null, task.owner, {})
        yield* Effect.promise(() => reported.promise).pipe(Effect.timeout("8 seconds"))
        yield* Effect.promise(() => writeFile(compacted, ""))
        yield* Effect.promise(() => dropped.promise).pipe(Effect.timeout("8 seconds"))
        yield* Effect.promise(() => finished.promise).pipe(Effect.timeout("8 seconds"))
        expect((yield* store.read).tasks[0]?.context).toBeUndefined()
      } finally {
        unsubscribe()
        yield* harness.stopAll()
      }
    }).pipe(Effect.provide(layer)))
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}, 20_000)

test("a Go subprocess receives no vendor credential env and its MCP token cannot call either vendor broker", async () => {
  const root = await mkdtemp(join(tmpdir(), "kestrel-go-broker-isolation-"))
  const cli = join(root, "go-acp.ts")
  const { config, layer } = harnessLayer(root, cli, { realBroker: true, fakeAgent: true })
  config.agentCommands["opencode-go"] = config.agentCommands.anthropic
  try {
    await Effect.runPromise(Effect.gen(function* () {
      const broker = yield* CredentialBroker
      const store = yield* StateStore
      const harness = yield* AgentHarness
      const hub = yield* EventHub
      // Keep the test off the network even if authorization regresses: an authorized request would return 424,
      // not the required 403. The lease and its grants are the real broker's, with both vendor keys configured.
      const server = createServer((req, res) => {
        void handleBroker({ ...broker, upstreamKey: () => Effect.succeed(null) }, req, res)
      })
      const listening = Promise.withResolvers<void>()
      server.listen(0, "127.0.0.1", () => listening.resolve())
      yield* Effect.promise(() => listening.promise)
      const address = server.address()
      if (address === null || typeof address === "string") throw new Error("missing broker test port")
      yield* Effect.promise(() => writeFile(cli, `
import { createInterface } from "node:readline"
const send = (id, result) => console.log(JSON.stringify({ jsonrpc: "2.0", id, result }))
createInterface({ input: process.stdin }).on("line", async (line) => {
  const req = JSON.parse(line)
  if (req.method === "initialize") send(req.id, { protocolVersion: 1 })
  if (req.method === "session/new") send(req.id, { sessionId: "go-isolation" })
  if (req.method === "session/set_config_option") send(req.id, {})
  if (req.method === "session/prompt") {
    const env = Object.keys(process.env).filter((key) => /^(ANTHROPIC|OPENAI)_/.test(key)).sort()
    const denied = []
    for (const provider of ["anthropic", "openai"]) {
      const response = await fetch("http://127.0.0.1:${address.port}/broker/" + process.env.CLOUDAGENTS_MCP_TOKEN + "/" + provider + "/v1/messages", { method: "POST", body: "{}" })
      denied.push(response.status)
    }
    console.log(JSON.stringify({ jsonrpc: "2.0", method: "session/update", params: {
      sessionId: "go-isolation", update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: JSON.stringify({ env, denied }) } }
    } }))
    send(req.id, { stopReason: "end_turn" })
  }
}).on("close", () => process.exit(0))
`))
      const { task, run: base } = runningTask("go-isolation")
      const run: Run = { ...base, provider: "opencode-go", model: "opencode-go/glm-5.3" }
      yield* store.update((state) => { state.tasks.push(task); state.runs.push(run); return Either.right(null) })
      yield* Effect.promise(() => mkdir(join(config.threadsDir, task.id), { recursive: true }))
      const finished = Promise.withResolvers<void>()
      const unsubscribe = hub.subscribe(task.id, (event) => {
        if (event._tag === "run.updated" && event.run.status !== "running") finished.resolve()
      })
      try {
        yield* harness.spawn(task, run, { fresh: run.prompt, resume: null }, null, task.owner, { model: "opencode-go/glm-5.3" })
        yield* Effect.promise(() => finished.promise).pipe(Effect.timeout("8 seconds"))
        const state = yield* store.read
        expect(state.runs.find((r) => r.id === run.id)?.status).toBe("succeeded")
        const message = state.messages.find((m) => m.runId === run.id && m.role === "agent")
        expect(JSON.parse(message?.text ?? "{}")).toEqual({ env: [], denied: [403, 403] })
      } finally {
        unsubscribe()
        yield* harness.stopAll()
        server.closeAllConnections()
        server.close()
      }
    }).pipe(Effect.provide(layer)))
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}, 12_000)

/** A Claude CLI that answers its first message, then sits on its input like an agent waiting on the user. */
const sittingCli = async (root: string) => {
  const cli = join(root, "cli.ts")
  await writeFile(cli, `
import { createInterface } from "node:readline"
createInterface({ input: process.stdin })
  .on("line", (line) => {
    if (JSON.parse(line).type !== "user") return
    console.log(JSON.stringify({ type: "assistant", message: { id: "m1", role: "assistant", content: [{ type: "text", text: "Working." }] }, parent_tool_use_id: null }))
  })
`)
  return cli
}

test("a graceful shutdown interrupts a run the way a crash does, keeps its question, and a reload keeps both", async () => {
  const root = await mkdtemp(join(tmpdir(), "kestrel-shutdown-restart-"))
  const cli = await sittingCli(root)
  const { task, run } = runningTask("shutdown")
  const question: Message = { id: "question", taskId: task.id, runId: run.id, role: "agent", text: "Which option?", options: ["A", "B"], createdAt: new Date().toISOString() }
  const first = harnessLayer(root, cli)
  try {
    await Effect.runPromise(Effect.gen(function* () {
      const store = yield* StateStore
      const harness = yield* AgentHarness
      const hub = yield* EventHub
      yield* store.update((state) => { state.tasks.push(task); state.runs.push(run); return Either.right(null) })
      yield* Effect.promise(() => mkdir(join(first.config.threadsDir, task.id), { recursive: true }))
      const answered = Promise.withResolvers<void>()
      const unsubscribe = hub.subscribe(task.id, (event) => {
        if (event._tag === "agent.item" && event.item._tag === "text") answered.resolve()
      })
      try {
        yield* harness.spawn(task, run, { fresh: run.prompt, resume: null }, null, task.owner, {})
        yield* Effect.promise(() => answered.promise).pipe(Effect.timeout("8 seconds"))
        yield* store.update((state) => {
          state.tasks.find((t) => t.id === task.id)!.status = "needs_input"
          state.messages.push(question)
          state.pendingAsks.push({ taskId: task.id, runId: run.id, messageId: question.id })
          return Either.right(null)
        })
        yield* harness.stopAll()
        const stopped = yield* store.read
        // Same as a crash (`reconcile`): the run is a restart interruption, not a user's cancel.
        expect(stopped.runs.find((r) => r.id === run.id)).toMatchObject({ status: "failed", interruptedByRestart: true })
        expect(stopped.pendingAsks).toEqual([{ taskId: task.id, runId: run.id, messageId: question.id }])
        expect(stopped.tasks.find((t) => t.id === task.id)?.status).toBe("needs_input")
      } finally {
        unsubscribe()
        yield* harness.stopAll()
      }
    }).pipe(Effect.provide(first.layer)))

    // The next box start loads the same state directory; reconciliation must not reclassify what shutdown recorded.
    const second = harnessLayer(root, cli)
    await Effect.runPromise(Effect.gen(function* () {
      const reloaded = yield* (yield* StateStore).read
      expect(reloaded.runs.find((r) => r.id === run.id)).toMatchObject({ status: "failed", interruptedByRestart: true })
      expect(reloaded.pendingAsks.map((a) => a.messageId)).toEqual([question.id])
      expect(reloaded.tasks.find((t) => t.id === task.id)?.status).toBe("needs_input")
    }).pipe(Effect.provide(second.layer)))
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}, 20_000)

test("a graceful shutdown of a plain running run reloads with its task failed, as after a crash", async () => {
  const root = await mkdtemp(join(tmpdir(), "kestrel-shutdown-plain-"))
  const cli = await sittingCli(root)
  const { task, run } = runningTask("shutdown-plain")
  const first = harnessLayer(root, cli)
  try {
    await Effect.runPromise(Effect.gen(function* () {
      const store = yield* StateStore
      const harness = yield* AgentHarness
      const hub = yield* EventHub
      yield* store.update((state) => { state.tasks.push(task); state.runs.push(run); return Either.right(null) })
      yield* Effect.promise(() => mkdir(join(first.config.threadsDir, task.id), { recursive: true }))
      const answered = Promise.withResolvers<void>()
      const unsubscribe = hub.subscribe(task.id, (event) => {
        if (event._tag === "agent.item" && event.item._tag === "text") answered.resolve()
      })
      try {
        yield* harness.spawn(task, run, { fresh: run.prompt, resume: null }, null, task.owner, {})
        yield* Effect.promise(() => answered.promise).pipe(Effect.timeout("8 seconds"))
        yield* harness.stopAll()
        const stopped = yield* store.read
        expect(stopped.runs.find((r) => r.id === run.id)).toMatchObject({ status: "failed", interruptedByRestart: true })
        // The shutdown leaves the task as it was; the next start's reconciliation is what fails it.
        expect(stopped.tasks.find((t) => t.id === task.id)?.status).toBe("running")
      } finally {
        unsubscribe()
        yield* harness.stopAll()
      }
    }).pipe(Effect.provide(first.layer)))

    const second = harnessLayer(root, cli)
    await Effect.runPromise(Effect.gen(function* () {
      const reloaded = yield* (yield* StateStore).read
      expect(reloaded.runs.find((r) => r.id === run.id)).toMatchObject({ status: "failed", interruptedByRestart: true })
      expect(reloaded.tasks.find((t) => t.id === task.id)?.status).toBe("failed")
    }).pipe(Effect.provide(second.layer)))
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}, 20_000)

test("a graceful shutdown cancels a run still queued for a slot: it never started, so it is not an interruption", async () => {
  const root = await mkdtemp(join(tmpdir(), "kestrel-shutdown-queued-"))
  const cli = await sittingCli(root)
  const first = runningTask("shutdown-first")
  const queued = runningTask("shutdown-queued")
  const { config, layer } = harnessLayer(root, cli, { maxConcurrentRuns: 1 })
  try {
    await Effect.runPromise(Effect.gen(function* () {
      const store = yield* StateStore
      const harness = yield* AgentHarness
      const hub = yield* EventHub
      yield* store.update((state) => {
        state.tasks.push(first.task, queued.task)
        state.runs.push(first.run, queued.run)
        return Either.right(null)
      })
      for (const { task } of [first, queued]) {
        yield* Effect.promise(() => mkdir(join(config.threadsDir, task.id), { recursive: true }))
      }
      const answered = Promise.withResolvers<void>()
      const waiting = Promise.withResolvers<void>()
      const unsubscribe = hub.subscribe(first.task.id, (event) => {
        if (event._tag === "agent.item" && event.item._tag === "text") answered.resolve()
      })
      const unsubscribeQueued = hub.subscribe(queued.task.id, (event) => {
        if (event._tag === "agent.item" && event.item._tag === "tool" && event.item.status === "running") waiting.resolve()
      })
      try {
        yield* harness.spawn(first.task, first.run, { fresh: first.run.prompt, resume: null }, null, first.task.owner, {})
        yield* Effect.promise(() => answered.promise).pipe(Effect.timeout("8 seconds"))
        yield* harness.spawn(queued.task, queued.run, { fresh: queued.run.prompt, resume: null }, null, queued.task.owner, {})
        yield* Effect.promise(() => waiting.promise).pipe(Effect.timeout("8 seconds"))
        yield* harness.stopAll()
        const stopped = yield* store.read
        // The first run had started: an interruption. The queued run never ran: cancelled, as an explicit stop leaves it.
        expect(stopped.runs.find((r) => r.id === first.run.id)).toMatchObject({ status: "failed", interruptedByRestart: true })
        expect(stopped.runs.find((r) => r.id === queued.run.id)).toMatchObject({ status: "cancelled" })
        expect(stopped.runs.find((r) => r.id === queued.run.id)?.interruptedByRestart).toBeUndefined()
        expect(stopped.tasks.find((t) => t.id === queued.task.id)?.status).toBe("idle")
      } finally {
        unsubscribe()
        unsubscribeQueued()
        yield* harness.stopAll()
      }
    }).pipe(Effect.provide(layer)))
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}, 20_000)

test("an explicit cancel is a user's stop: the run is cancelled, its question is dropped, and it is not a restart interruption", async () => {
  const root = await mkdtemp(join(tmpdir(), "kestrel-explicit-cancel-"))
  const cli = await sittingCli(root)
  const { task, run } = runningTask("cancel")
  const question: Message = { id: "question", taskId: task.id, runId: run.id, role: "agent", text: "Which option?", options: ["A", "B"], createdAt: new Date().toISOString() }
  const { config, layer } = harnessLayer(root, cli)
  try {
    await Effect.runPromise(Effect.gen(function* () {
      const store = yield* StateStore
      const harness = yield* AgentHarness
      const hub = yield* EventHub
      yield* store.update((state) => { state.tasks.push(task); state.runs.push(run); return Either.right(null) })
      yield* Effect.promise(() => mkdir(join(config.threadsDir, task.id), { recursive: true }))
      const answered = Promise.withResolvers<void>()
      const unsubscribe = hub.subscribe(task.id, (event) => {
        if (event._tag === "agent.item" && event.item._tag === "text") answered.resolve()
      })
      try {
        yield* harness.spawn(task, run, { fresh: run.prompt, resume: null }, null, task.owner, {})
        yield* Effect.promise(() => answered.promise).pipe(Effect.timeout("8 seconds"))
        yield* store.update((state) => {
          state.tasks.find((t) => t.id === task.id)!.status = "needs_input"
          state.messages.push(question)
          state.pendingAsks.push({ taskId: task.id, runId: run.id, messageId: question.id })
          return Either.right(null)
        })
        yield* harness.cancel(run.id)
        const state = yield* store.read
        expect(state.runs.find((r) => r.id === run.id)).toMatchObject({ status: "cancelled" })
        expect(state.runs.find((r) => r.id === run.id)?.interruptedByRestart).toBeUndefined()
        expect(state.pendingAsks).toEqual([])
        expect(state.tasks.find((t) => t.id === task.id)?.status).toBe("idle")
      } finally {
        unsubscribe()
        yield* harness.stopAll()
      }
    }).pipe(Effect.provide(layer)))
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}, 20_000)

test("a Devin ACP run sets the upstream model id, without the protocol prefix", async () => {
  const root = await mkdtemp(join(tmpdir(), "kestrel-devin-acp-model-"))
  const cli = join(root, "devin-acp.ts")
  const modelFile = join(root, "model.txt")
  const { config, layer } = harnessLayer(root, cli)
  config.agentCommands.devin = config.agentCommands.anthropic
  await writeFile(cli, `
import { createInterface } from "node:readline"
import { writeFileSync } from "node:fs"
const send = (id, result) => console.log(JSON.stringify({ jsonrpc: "2.0", id, result }))
createInterface({ input: process.stdin }).on("line", (line) => {
  const req = JSON.parse(line)
  if (req.method === "initialize") send(req.id, { protocolVersion: 1 })
  if (req.method === "session/new") send(req.id, { sessionId: "devin-acp", configOptions: [] })
  if (req.method === "session/set_config_option") {
    if (req.params?.configId === "model") writeFileSync(${JSON.stringify(modelFile)}, String(req.params.value))
    send(req.id, {})
  }
  if (req.method === "session/prompt") send(req.id, { stopReason: "end_turn" })
}).on("close", () => process.exit(0))
`)
  try {
    await Effect.runPromise(Effect.gen(function* () {
      const store = yield* StateStore
      const harness = yield* AgentHarness
      const hub = yield* EventHub
      const { task, run: base } = runningTask("devin-acp-model")
      const run: Run = { ...base, provider: "devin", model: "devin/claude-fable-5-1" }
      yield* store.update((state) => { state.tasks.push(task); state.runs.push(run); return Either.right(null) })
      yield* Effect.promise(() => mkdir(join(config.threadsDir, task.id), { recursive: true }))
      const finished = Promise.withResolvers<void>()
      const unsubscribe = hub.subscribe(task.id, (event) => {
        if (event._tag === "run.updated" && event.run.status !== "running") finished.resolve()
      })
      try {
        yield* harness.spawn(task, run, { fresh: run.prompt, resume: null }, null, task.owner, { model: "devin/claude-fable-5-1" })
        yield* Effect.promise(() => finished.promise).pipe(Effect.timeout("8 seconds"))
        expect(yield* Effect.promise(() => readFile(modelFile, "utf8"))).toBe("claude-fable-5-1")
      } finally {
        unsubscribe()
        yield* harness.stopAll()
      }
    }).pipe(Effect.provide(layer)))
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}, 12_000)
