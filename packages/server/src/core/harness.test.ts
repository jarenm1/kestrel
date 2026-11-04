import { expect, test } from "bun:test"
import { Effect, Either, Fiber, Layer } from "effect"
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { Checkout, Run, Task } from "@cloudagents/protocol"
import { CredentialBroker } from "../broker"
import { CliAuth, type CliLoginDir } from "../cliauth"
import { Config, type ServerConfig } from "../config"
import { CredentialStore } from "../credentials"
import { GitHub } from "../github/api"
import { AgentHarness, AgentHarnessLive } from "./harness"
import { EventHub, EventHubLive } from "./events"
import { StateLive, StateStore } from "./state"
import { WorkspaceLive } from "./workspace"

/** A harness whose Claude CLI is `cli`, with its state under `root`. `loggedInDirs` runs at every launch. */
const harnessLayer = (
  root: string,
  cli: string,
  options: { readonly maxConcurrentRuns?: number; readonly loggedInDirs?: () => Effect.Effect<ReadonlyArray<CliLoginDir>>; readonly controlUrl?: string } = {},
) => {
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
      anthropic: [process.execPath, cli].map((path) => `'${path.replaceAll("\\", "/").replaceAll("'", "'\\''")}'`).join(" "),
      openai: "",
      opencode: "",
    },
    fakeAgent: false,
    fakeAgentRoBinds: [],
    sandbox: "off",
    sandboxPath: null,
    sandboxSslCertFile: null,
    systemd: null,
    maxConcurrentRuns: options.maxConcurrentRuns ?? 0,
    relay: options.controlUrl ? { controlUrl: options.controlUrl, boxToken: "test-token" } : null,
    direct: null,
    toolkitsFlake: null,
    taskDiskMax: 1024 ** 3,
    webrtc: { iceServers: [], turn: null, policy: "all", portRange: null, hostAddresses: [], denyPrivate: false },
    githubApiUrl: "https://api.github.com",
  }
  const configLayer = Layer.succeed(Config, config)
  const dependencies = Layer.mergeAll(
    configLayer,
    StateLive.pipe(Layer.provide(Layer.merge(configLayer, WorkspaceLive))),
    EventHubLive,
    Layer.succeed(CredentialStore, { get: () => Effect.succeed({ user: "test", dev: true }) } as never),
    Layer.succeed(GitHub, {} as never),
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
        expect(yield* runWith("login-from-home", "task-home")).toEqual({ answer: "resume=none prompt=whole conversation", recorded: "cli-login" })
        expect(yield* runWith("login-to-login", "cli-login")).toEqual({ answer: "resume=earlier prompt=delta", recorded: "cli-login" })
        // A session recorded before its place was may sit on either side of a login change: start fresh, logged in or out.
        expect(yield* runWith("legacy-logged-in", undefined)).toEqual({ answer: "resume=none prompt=whole conversation", recorded: "cli-login" })
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
