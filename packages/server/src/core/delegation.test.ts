import { expect, test } from "bun:test"
import { mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Effect, Either, Layer } from "effect"
import { Config, type ServerConfig } from "../config"
import { DesktopManager } from "../desktop"
import { CredentialStore } from "../credentials"
import { CliAuth } from "../cliauth"
import { CredentialBroker } from "../broker"
import { GitHub } from "../github/api"
import { AgentHarness, type AgentChoice } from "./harness"
import { EventHubLive } from "./events"
import { CoreLive, CoreService, type CoreShape } from "./service"
import { StateLive, StateStore, type StoreShape } from "./state"
import { WorkspaceService } from "./workspace"
import { BOX_USER_HEADER } from "@cloudagents/protocol"
import { makeWebHandler } from "../http/router"

interface Harnessed {
  readonly store: StoreShape
  readonly core: CoreShape
  readonly config: ServerConfig
  readonly choices: AgentChoice[]
}

/** Runs `body` against the real core over a fresh store. The harness starts no agent: it only records each run's choice. */
const withCore = async (body: (h: Harnessed) => Effect.Effect<void, unknown>): Promise<void> => {
  const root = await mkdtemp(join(tmpdir(), "kestrel-delegation-"))
  const config: ServerConfig = {
    port: 8899, host: "127.0.0.1", sandboxPort: 8899, mcpBaseUrl: "http://127.0.0.1:8899", dataDir: root,
    stateFile: join(root, "state.json"), mirrorsDir: join(root, "mirrors"), threadsDir: join(root, "threads"),
    shadowsDir: join(root, "shadows"), runsDir: join(root, "runs"), attachmentsDir: join(root, "attachments"), homesDir: join(root, "homes"),
    agentCommands: { anthropic: "", openai: "", openrouter: "", zai: "", deepseek: "", minimax: "", moonshot: "", opencode: "", "opencode-go": "", google: "", devin: "" }, agentRouteCommands: { claude: "", codex: "", opencode: "" }, fakeAgent: false, fakeAgentRoBinds: [], sandbox: "off", sandboxPath: null,
    nest: null,
    sandboxSslCertFile: null, systemd: null, maxConcurrentRuns: 2, relay: null, direct: null, toolkitsFlake: null,
    taskDiskMax: 1024 ** 3, githubApiUrl: "https://api.github.com",
    webrtc: { iceServers: [], turn: null, policy: "all", portRange: null, hostAddresses: [], denyPrivate: false },
  }
  const choices: AgentChoice[] = []
  let testStore: StoreShape | undefined
  const configLayer = Layer.succeed(Config, config)
  const workspaceLayer = Layer.succeed(WorkspaceService, {} as never)
  const deps = Layer.mergeAll(
    configLayer, StateLive.pipe(Layer.provide(Layer.merge(configLayer, workspaceLayer))), EventHubLive,
    Layer.succeed(DesktopManager, { watchStatus: () => Effect.void, status: () => Effect.succeed({ state: "stopped", display: null }), stopAll: () => Effect.void } as never),
    workspaceLayer, Layer.succeed(CredentialStore, {} as never),
    Layer.succeed(GitHub, {} as never), Layer.succeed(CliAuth, {} as never),
    Layer.succeed(CredentialBroker, {} as never),
    Layer.succeed(AgentHarness, {
      spawn: (_task: unknown, _run: unknown, _start: unknown, _display: unknown, _user: unknown, choice: AgentChoice) => Effect.sync(() => { choices.push(choice) }),
      steer: () => Effect.succeed(false), cancel: (id: string) => testStore!.update((s) => {
        const run = s.runs.find((r) => r.id === id)
        if (run?.status === "running") { run.status = "cancelled"; run.endedAt = new Date().toISOString() }
        return Either.right(undefined)
      }), stopAll: () => Effect.void, items: () => Effect.succeed([]), itemCount: () => 0,
    } as never),
  )
  try {
    await Effect.runPromise(Effect.gen(function* () {
      const store = yield* StateStore
      testStore = store
      const core = yield* CoreService
      yield* body({ store, core, config, choices })
    }).pipe(Effect.provide(CoreLive.pipe(Layer.provide(deps), Layer.provideMerge(deps)))))
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}

test("delegation persists its lineage, deduplicates retries, and delivers one completion", () => withCore(({ store, core, config, choices }) =>
    Effect.gen(function* () {
      const now = new Date().toISOString()
      yield* store.update((s) => {
        s.tasks.push({ id: "parent", owner: "owner", title: "Parent", status: "running", createdAt: now, updatedAt: now, checkouts: [] })
        s.tasks.push({ id: "other", owner: "other", title: "Other", status: "idle", createdAt: now, updatedAt: now, checkouts: [] })
        s.runs.push({ id: "parent-run", taskId: "parent", prompt: "work", status: "running", startedAt: now, endedAt: null, exitCode: null, provider: "openai", model: "gpt-6.1-sol" })
        return Either.right(undefined)
      })
      const input = { title: "Review", message: "Review the change", requestId: "retry-key" }
      const [child, retry] = yield* Effect.all([core.delegate("parent", "parent-run", input), core.delegate("parent", "parent-run", input)], { concurrency: "unbounded" })
      expect(retry.id).toBe(child.id)
      expect(child.delegation?.runId).toBeDefined()
      expect(choices).toEqual([{ model: "gpt-6.1-sol" }])
      expect(Either.isLeft(yield* Effect.either(core.delegate("parent", "parent-run", { ...input, message: "different" })))).toBe(true)
      const badDispatch = { title: "Bad", message: " ", requestId: "failed-before-run" }
      expect(Either.isLeft(yield* Effect.either(core.delegate("parent", "parent-run", badDispatch)))).toBe(true)
      const badRetry = yield* Effect.either(core.delegate("parent", "parent-run", badDispatch))
      expect(Either.isLeft(badRetry)).toBe(true)
      if (Either.isLeft(badRetry)) expect(badRetry.left.message).toContain("failed before its run was reserved")
      expect(Either.isLeft(yield* Effect.either(core.delegatedStatus("other", child.id)))).toBe(true)
      const runId = child.delegation!.runId!
      yield* store.update((s) => {
        const run = s.runs.find((r) => r.id === runId)!
        run.status = "succeeded"
        run.endedAt = now
        s.messages.push({ id: "result", taskId: child.id, runId, role: "agent", text: "Review complete", createdAt: now })
        return Either.right(undefined)
      })
      yield* Effect.sleep("2500 millis")
      const state = yield* store.read
      expect(state.messages.filter((m) => m.id === `delegation-result:${child.id}`)).toHaveLength(1)
      expect((yield* core.inbox("parent", "parent-run")).join("\n")).toContain("Review complete")
      expect((yield* core.inbox("parent", "parent-run"))).toHaveLength(0)
      expect((yield* core.delegatedStatus("parent", child.id)).result).toBe("Review complete")
      const blocked = yield* core.delegate("parent", "parent-run", { ...input, requestId: "blocked" })
      yield* store.update((s) => {
        s.tasks.find((t) => t.id === blocked.id)!.status = "needs_input"
        s.messages.push({ id: "question", taskId: blocked.id, runId: blocked.delegation!.runId!, role: "agent", text: "Which option?", options: ["A", "B"], createdAt: now })
        s.pendingAsks.push({ taskId: blocked.id, runId: blocked.delegation!.runId!, messageId: "question" })
        // Match restart reconciliation: the run fails, but its question survives.
        const interrupted = s.runs.find((r) => r.id === blocked.delegation!.runId)!
        interrupted.status = "failed"
        interrupted.interruptedByRestart = true
        interrupted.endedAt = now
        return Either.right(undefined)
      })
      yield* Effect.sleep("2500 millis")
      expect((yield* core.inbox("parent", "parent-run")).join("\n")).toContain("Which option?")
      expect((yield* store.read).pendingAsks.some((ask) => ask.messageId === "question")).toBe(true)
      expect((yield* store.read).messages.some((m) => m.id === `delegation-result:${blocked.id}`)).toBe(false)
      const resumed = yield* core.sendMessage("owner", blocked.id, "A", { model: "gpt-6.1-sol" }, [], false)
      expect(resumed.run.id).not.toBe(blocked.delegation!.runId)
      expect((yield* core.delegatedStatus("parent", blocked.id)).run?.id).toBe(resumed.run.id)
      yield* store.update((s) => {
        s.runs.find((r) => r.id === resumed.run.id)!.status = "succeeded"
        s.tasks.find((t) => t.id === blocked.id)!.status = "idle"
        s.messages.push({ id: "answered-result", taskId: blocked.id, runId: resumed.run.id, role: "agent", text: "Finished using option A", createdAt: now })
        return Either.right(undefined)
      })
      const second = yield* core.delegate("parent", "parent-run", { ...input, requestId: "second" })
      yield* store.update((s) => {
        const run = s.runs.find((r) => r.id === second.delegation!.runId)!
        run.status = "succeeded"
        run.endedAt = now
        return Either.right(undefined)
      })
      expect(yield* core.acknowledgeDelegation("parent", second.id)).toBe(true)
      expect(yield* core.acknowledgeDelegation("parent", second.id)).toBe(false)
      yield* Effect.sleep("2500 millis")
      const answeredResults = (yield* store.read).messages.filter((m) => m.id === `delegation-result:${blocked.id}`)
      expect(answeredResults).toHaveLength(1)
      expect(answeredResults[0]?.text).toContain("Finished using option A")
      expect((yield* store.read).messages.filter((m) => m.id === `delegation-result:${second.id}`)).toHaveLength(0)
      const nestedParent = yield* core.delegate("parent", "parent-run", { ...input, requestId: "nested-parent" })
      const nestedRunId = nestedParent.delegation!.runId!
      const grandchild = yield* core.delegate(nestedParent.id, nestedRunId, { ...input, requestId: "grandchild" })
      yield* store.update((s) => {
        const run = s.runs.find((r) => r.id === nestedRunId)!
        run.status = "succeeded"
        run.endedAt = now
        s.messages.push({ id: "intermediate", taskId: nestedParent.id, runId: nestedRunId, role: "agent", text: "Waiting for child", createdAt: now })
        return Either.right(undefined)
      })
      expect((yield* core.delegatedStatus("parent", nestedParent.id)).waitingForChildren).toBe(true)
      yield* store.update((s) => {
        const run = s.runs.find((r) => r.id === grandchild.delegation!.runId)!
        run.status = "succeeded"
        run.endedAt = now
        s.messages.push({ id: "grandchild-result", taskId: grandchild.id, runId: run.id, role: "agent", text: "Nested answer", createdAt: now })
        return Either.right(undefined)
      })
      yield* Effect.sleep("2500 millis")
      const during = yield* store.read
      expect(during.messages.some((m) => m.id === `delegation-result:${nestedParent.id}`)).toBe(false)
      const continuation = during.messages.find((m) => m.id === `delegation-result:${grandchild.id}`)!.runId!
      expect(continuation).not.toBe(nestedRunId)
      expect((yield* core.delegatedStatus("parent", nestedParent.id)).waitingForChildren).toBe(true)
      yield* store.update((s) => {
        const run = s.runs.find((r) => r.id === continuation)!
        run.status = "succeeded"
        run.endedAt = now
        s.messages.push({ id: "integrated", taskId: nestedParent.id, runId: continuation, role: "agent", text: "Integrated answer", createdAt: now })
        return Either.right(undefined)
      })
      yield* Effect.sleep("2500 millis")
      expect((yield* core.delegatedStatus("parent", nestedParent.id)).result).toBe("Integrated answer")
      expect((yield* store.read).messages.find((m) => m.id === `delegation-result:${nestedParent.id}`)?.text).toContain("Integrated answer")
      // A -> R2 -> C -> R4 and B -> R3: the latest result is R4, not R3.
      const branched = yield* core.delegate("parent", "parent-run", { ...input, requestId: "branched" })
      const firstRun = branched.delegation!.runId!
      yield* store.update((s) => {
        const original = s.runs.find((r) => r.id === firstRun)!
        original.status = "succeeded"
        for (const id of ["R2", "R3", "R4", "unrelated"]) {
          s.runs.push({ ...original, id })
          s.messages.push({ id: `answer:${id}`, taskId: branched.id, runId: id, role: "agent", text: `Answer from ${id}`, createdAt: now })
        }
        for (const [id, parentRunId, continuationId] of [["A", firstRun, "R2"], ["B", firstRun, "R3"], ["C", "R2", "R4"]]) {
          s.tasks.push({ ...branched, id: id!, delegation: { ...branched.delegation!, parentTaskId: branched.id, parentRunId: parentRunId!, runId: `run:${id}` } })
          s.runs.push({ ...original, id: `run:${id}`, taskId: id! })
          s.messages.push({ id: `delegation-result:${id}`, taskId: branched.id, runId: continuationId!, role: "user", text: `Result ${id}`, createdAt: now })
        }
        return Either.right(undefined)
      })
      expect((yield* core.delegatedStatus("parent", branched.id)).result).toBe("Answer from R4")
      const structured = yield* core.delegate("parent", "parent-run", { ...input, requestId: "structured", outputSchema: { type: "object", required: ["ok"], properties: { ok: { type: "boolean" } } } })
      yield* store.update((s) => {
        const run = s.runs.find((r) => r.id === structured.delegation!.runId)!
        run.status = "succeeded"
        run.endedAt = now
        s.messages.push({ id: "structured-result", taskId: structured.id, runId: run.id, role: "agent", text: '{"ok":true}', createdAt: now })
        return Either.right(undefined)
      })
      expect((yield* core.delegatedStatus("parent", structured.id)).structured).toEqual({ valid: true, data: { ok: true } })
      yield* store.update((s) => {
        s.messages.find((m) => m.id === "structured-result")!.text = '{"ok":"wrong"}'
        return Either.right(undefined)
      })
      expect((yield* core.delegatedStatus("parent", structured.id)).structured?.valid).toBe(false)
      const cancelParent = yield* core.delegate("parent", "parent-run", { ...input, requestId: "cancel-parent" })
      const cancelChild = yield* core.delegate(cancelParent.id, cancelParent.delegation!.runId!, { ...input, requestId: "cancel-child" })
      expect(Either.isLeft(yield* Effect.either(core.cancelDelegation("other", cancelParent.id)))).toBe(true)
      const handler = yield* makeWebHandler(core, {} as never, { version: 1, platform: "other", sandbox: "off", desktop: "unavailable" })
      const url = `http://localhost/api/tasks/parent/delegations/${cancelParent.id}/cancel`
      const forbidden = yield* Effect.promise(() => handler(new Request(url, { method: "POST", headers: { [BOX_USER_HEADER]: "other" } })))
      expect(forbidden.status).toBe(404)
      const cancelled = yield* Effect.promise(() => handler(new Request(url, { method: "POST", headers: { [BOX_USER_HEADER]: "owner" } })))
      expect(cancelled.status).toBe(200)
      const afterCancel = yield* store.read
      expect(afterCancel.runs.find((r) => r.id === cancelParent.delegation!.runId)?.status).toBe("cancelled")
      expect(afterCancel.runs.find((r) => r.id === cancelChild.delegation!.runId)?.status).toBe("cancelled")
      expect(afterCancel.tasks.find((t) => t.id === cancelChild.id)?.delegation?.cancelledAt).toBeDefined()
      // Questions survive reconciliation even though their runs are no longer live.
      const cancelQuestion = yield* core.delegate("parent", "parent-run", { ...input, requestId: "cancel-question" })
      const nestedQuestion = yield* core.delegate(cancelQuestion.id, cancelQuestion.delegation!.runId!, { ...input, requestId: "nested-question" })
      yield* store.update((s) => {
        for (const task of [cancelQuestion, nestedQuestion]) {
          s.tasks.find((t) => t.id === task.id)!.status = "needs_input"
          const run = s.runs.find((r) => r.id === task.delegation!.runId)!
          run.status = "failed"
          run.interruptedByRestart = true
          s.pendingAsks.push({ taskId: task.id, runId: run.id, messageId: `question:${task.id}` })
        }
        return Either.right(undefined)
      })
      // A leaf with no children must be cancellable as well as its parent.
      const cancelledLeaf = yield* core.cancelDelegation(cancelQuestion.id, nestedQuestion.id)
      expect(cancelledLeaf.task.delegation?.cancelledAt).toBeDefined()
      const cancelledQuestion = yield* core.cancelDelegation("parent", cancelQuestion.id)
      expect(cancelledQuestion.task.delegation?.cancelledAt).toBeDefined()
      expect(cancelledQuestion.task.status).not.toBe("needs_input")
      expect((yield* store.read).pendingAsks.some((a) => [cancelQuestion.id, nestedQuestion.id].includes(a.taskId))).toBe(false)
      // Later user work may start independently, but cannot resume the cancelled delegation.
      const later = yield* core.sendMessage("owner", cancelQuestion.id, "New work", { model: "gpt-6.1-sol" }, [], false)
      expect(later.run.id).not.toBe(cancelQuestion.delegation!.runId)
      expect((yield* core.delegatedStatus("parent", cancelQuestion.id)).run?.id).toBe(cancelQuestion.delegation!.runId)
      // Model startup reconciliation after the parent lost a run containing an automatic result.
      yield* store.update((s) => {
        const run = s.runs.find((r) => r.id === "parent-run")!
        run.status = "failed"
        run.interruptedByRestart = true
        run.endedAt = now
        return Either.right(undefined)
      })
      yield* Effect.sleep("2500 millis")
      const recovered = (yield* store.read).messages.find((m) => m.id === `delegation-recovery:${child.id}:parent-run`)
      expect((yield* store.read).messages.find((m) => m.id === `delegation-result:${branched.id}`)?.text).toContain("Answer from R4")
      expect(recovered?.text).toContain("Review complete") // result plus restart notice is delivered to a fresh run
      expect(recovered?.runId).not.toBe("parent-run")
      const disk = yield* Effect.promise(() => readFile(config.stateFile, "utf8"))
      expect(disk).toContain('"requestId":"retry-key"')
    })), 20_000)

test("a usage limit holds delegated results until the work resumes or returns early", () => withCore(({ store, core, config }) =>
  Effect.gen(function* () {
    const now = new Date().toISOString()
    const later = new Date(Date.now() + 3_600_000).toISOString()
    const choice = { model: "gpt-6.1-sol" } as const
    yield* store.update((s) => {
      for (const id of ["parent", "held"]) {
        s.tasks.push({ id, owner: "owner", title: id, status: "running", createdAt: now, updatedAt: now, checkouts: [] })
        s.runs.push({ id: `${id}-run`, taskId: id, prompt: "work", status: "running", startedAt: now, endedAt: null, exitCode: null, provider: "openai", model: "gpt-6.1-sol" })
      }
      return Either.right(undefined)
    })
    /** The child's delegated run fails on a usage limit and recovery arms it to resume at `later`. */
    const stall = (childId: string, autoResume = true) => store.update((s) => {
      const child = s.tasks.find((t) => t.id === childId)!
      const run = s.runs.find((r) => r.id === child.delegation!.runId)!
      run.status = "failed"
      run.endedAt = now
      child.status = "failed"
      child.usageLimitResume = { runId: run.id, resetsAt: later, autoResume }
      return Either.right(undefined)
    })
    const finish = (taskId: string, runId: string, text: string) => store.update((s) => {
      const run = s.runs.find((r) => r.id === runId)!
      run.status = "succeeded"
      run.endedAt = now
      s.tasks.find((t) => t.id === taskId)!.status = "done"
      s.messages.push({ id: `answer:${runId}`, taskId, runId, role: "agent", text, createdAt: now })
      return Either.right(undefined)
    })
    const results = (childId: string) => Effect.map(store.read, (s) => s.messages.filter((m) => m.id === `delegation-result:${childId}`))

    // A stalled child is not finished: its result waits, and whatever continues the work carries the delegation.
    const stalled = yield* core.delegate("parent", "parent-run", { title: "Stalled", message: "work", requestId: "stalled" })
    yield* stall(stalled.id)
    yield* Effect.sleep("2500 millis")
    expect(yield* results(stalled.id)).toHaveLength(0)
    expect((yield* core.delegatedStatus("parent", stalled.id)).usageLimit).toEqual({ resetsAt: later })
    const handedOff = yield* core.sendMessage("owner", stalled.id, "Continue on another model", choice, [], false)
    expect((yield* core.delegatedStatus("parent", stalled.id)).run?.id).toBe(handedOff.run.id)
    yield* finish(stalled.id, handedOff.run.id, "Answer after the hand-off")
    yield* Effect.sleep("2500 millis")
    const delivered = yield* results(stalled.id)
    expect(delivered).toHaveLength(1)
    expect(delivered[0]?.text).toContain("Answer after the hand-off")

    // Returning a stalled child early sends the parent its failed run's result now.
    const returned = yield* core.delegate("parent", "parent-run", { title: "Returned", message: "work", requestId: "returned" })
    yield* stall(returned.id)
    yield* core.cancelDelegation("parent", returned.id)
    // The user's decision is written to the state file, so a restarted box does not arm that run again.
    const settledRun = returned.delegation!.runId!
    expect(yield* Effect.promise(() => readFile(config.stateFile, "utf8"))).toContain(`"settledRuns":["${settledRun}"]`)
    yield* Effect.sleep("2500 millis")
    expect((yield* results(returned.id))[0]?.text).toContain("finished with status failed")

    // An archived child is never resumed, so its arm must not hold the result.
    const archived = yield* core.delegate("parent", "parent-run", { title: "Archived", message: "work", requestId: "archived" })
    yield* stall(archived.id)
    yield* store.update((s) => {
      s.tasks.find((t) => t.id === archived.id)!.archivedAt = now
      return Either.right(undefined)
    })
    yield* Effect.sleep("2500 millis")
    expect((yield* results(archived.id))[0]?.text).toContain("finished with status failed")

    // With auto-resume off the failure goes up at once; turning it back on then could never reach the parent.
    const released = yield* core.delegate("parent", "parent-run", { title: "Released", message: "work", requestId: "released" })
    yield* stall(released.id, false)
    yield* Effect.sleep("2500 millis")
    expect((yield* results(released.id))[0]?.text).toContain("finished with status failed")
    expect(Either.isLeft(yield* Effect.either(core.setUsageLimitAutoResume("owner", released.id, true)))).toBe(true)

    // A parent stopped by a usage limit queues its children's results instead of starting a failing run for each.
    const input = { title: "Queued", message: "work", requestId: "queued" }
    const queued = yield* core.delegate("held", "held-run", input)
    const paused = yield* core.delegate("held", "held-run", { title: "Paused", message: "work", requestId: "paused" })
    yield* store.update((s) => {
      const held = s.tasks.find((t) => t.id === "held")!
      const run = s.runs.find((r) => r.id === "held-run")!
      run.status = "failed"
      run.endedAt = now
      held.status = "failed"
      held.usageLimitResume = { runId: run.id, resetsAt: later, autoResume: true }
      return Either.right(undefined)
    })
    yield* finish(queued.id, queued.delegation!.runId!, "Queued answer")
    // With auto-resume off nothing holds the child, but its queued result has not gone up: the user continuing it
    // carries the delegation, so the parent never gets the stale failure while the new run works.
    yield* stall(paused.id, false)
    const continued = yield* core.sendMessage("owner", paused.id, "Carry on", choice, [], false)
    expect((yield* core.delegatedStatus("held", paused.id)).run?.id).toBe(continued.run.id)
    yield* Effect.sleep("2500 millis")
    expect(yield* results(queued.id)).toHaveLength(0)
    expect((yield* store.read).runs.filter((r) => r.taskId === "held")).toHaveLength(1)
    const resumed = yield* core.sendMessage("owner", "held", "Continue where you left off.", choice, [], false)
    yield* Effect.sleep("2500 millis")
    expect((yield* core.inbox("held", resumed.run.id)).join("\n")).toContain("Queued answer")
    // The resumed parent repeating its delegate call gets the same child back, now waited on by the resumed run.
    expect((yield* core.delegate("held", resumed.run.id, input)).id).toBe(queued.id)
    expect((yield* store.read).tasks.find((t) => t.id === queued.id)?.delegation?.parentRunId).toBe(resumed.run.id)
  })), 30_000)
