import { expect, test } from "bun:test"
import { Effect, Either } from "effect"
import { Conflict, type AgentItem, type ProviderUsage, type Task, type ThreadSettings } from "@cloudagents/protocol"
import type { StoreShape, StoreState } from "./state"
import { makeUsageLimitRecovery } from "./usage-limit-recovery"

const task = (overrides: Partial<Task> = {}): Task => ({
  id: "task",
  owner: "owner",
  title: "Thread",
  status: "failed",
  createdAt: new Date(Date.now() - 120_000).toISOString(),
  updatedAt: new Date(Date.now() - 60_000).toISOString(),
  checkouts: [],
  ...overrides,
})

const failedRun = (endedAt: string) => ({
  id: "run",
  taskId: "task",
  prompt: "Do the work",
  status: "failed" as const,
  startedAt: new Date(Date.parse(endedAt) - 60_000).toISOString(),
  endedAt,
  exitCode: 1,
  provider: "anthropic" as const,
  model: "claude-opus-5-5" as const,
  effort: null,
})

const stateWith = (overrides: Partial<StoreState> = {}): StoreState => ({
  tasks: [task()],
  messages: [],
  runs: [],
  pendingAsks: [],
  uploads: [],
  runSessions: [],
  ...overrides,
})

const memoryStore = (initial: StoreState): { store: StoreShape; state: StoreState } => {
  let current = initial
  return {
    state: initial,
    store: {
      read: Effect.sync(() => current),
      update: <A, E>(f: (s: StoreState) => Either.Either<A, E>) =>
        Effect.sync(() => {
          const result = f(current)
          if (Either.isLeft(result)) throw result.left
          return result.right
        }),
      flush: Effect.void,
    },
  }
}

const usage = (resetsAt: string): ProviderUsage => ({
  provider: "claude-cli",
  status: "ok",
  plan: "Pro",
  windows: [{ id: "five_hour", label: "5-hour", usedPercent: 100, resetsAt }],
})

const setup = (input: {
  state: StoreState
  usage?: ProviderUsage
  items?: ReadonlyArray<AgentItem>
  settings?: ThreadSettings
  providerUsage?: () => Effect.Effect<ReadonlyArray<ProviderUsage>, unknown>
  deliver?: () => Effect.Effect<void, unknown>
}) => {
  const { store, state } = memoryStore(input.state)
  const delivered: string[] = []
  const published: Task[] = []
  const recovery = makeUsageLimitRecovery({
    store,
    publish: (updated) => published.push(updated),
    settings: () => Effect.succeed(input.settings ?? { autoResumeAfterUsageLimits: true }),
    items: () => Effect.succeed(input.items ?? [{ _tag: "error", id: "error", text: "usage limit reached" }]),
    providerUsage:
      input.providerUsage ??
      (() => Effect.succeed([input.usage ?? usage(new Date(Date.now() - 30_000).toISOString())])),
    deliver:
      input.deliver ??
      ((_task, _run, deliveryId) => Effect.sync(() => void delivered.push(deliveryId))),
  })
  return { recovery, state, delivered, published }
}

test("arms a usage-limit failure and resumes it once the provider's window has reset", async () => {
  const endedAt = new Date(Date.now() - 60_000).toISOString()
  const { recovery, state, delivered, published } = setup({ state: stateWith({ runs: [failedRun(endedAt)] }) })

  await Effect.runPromise(recovery.sweep)
  expect(state.tasks[0]!.usageLimitResume).toMatchObject({ runId: "run", autoResume: true })
  expect(delivered).toEqual([])
  expect(published.at(-1)?.usageLimitResume?.runId).toBe("run")
  const resetsAt = state.tasks[0]!.usageLimitResume!.resetsAt

  await Effect.runPromise(recovery.sweep)
  expect(delivered).toEqual([`usage-limit-resume:task:run:${resetsAt}`])
  expect(state.tasks[0]!.usageLimitResume).toBeUndefined()
})

test("arms a reset still in the future but does not resume before it", async () => {
  const endedAt = new Date(Date.now() - 60_000).toISOString()
  const resetsAt = new Date(Date.now() + 60_000).toISOString()
  const { recovery, state, delivered } = setup({
    state: stateWith({ runs: [failedRun(endedAt)] }),
    usage: usage(resetsAt),
  })

  await Effect.runPromise(recovery.sweep)
  await Effect.runPromise(recovery.sweep)
  expect(state.tasks[0]!.usageLimitResume?.resetsAt).toBe(resetsAt)
  expect(delivered).toEqual([])
})

test("a thread with auto-resume off keeps the reset for a per-thread opt-in", async () => {
  const endedAt = new Date(Date.now() - 60_000).toISOString()
  const { recovery, state, delivered } = setup({
    state: stateWith({ runs: [failedRun(endedAt)] }),
    settings: { autoResumeAfterUsageLimits: false },
  })

  await Effect.runPromise(recovery.sweep)
  expect(state.tasks[0]!.usageLimitResume).toMatchObject({ runId: "run", autoResume: false })
  await Effect.runPromise(recovery.sweep)
  expect(delivered).toEqual([])

  // The notice's "Resume at reset" turns this one thread on.
  const armed = state.tasks[0]!.usageLimitResume!
  state.tasks[0] = { ...state.tasks[0]!, usageLimitResume: { ...armed, autoResume: true } }
  await Effect.runPromise(recovery.sweep)
  expect(delivered).toHaveLength(1)
  expect(state.tasks[0]!.usageLimitResume).toBeUndefined()
})

test("an arm already off is not resumed at reset", async () => {
  const endedAt = new Date(Date.now() - 60_000).toISOString()
  const { recovery, state, delivered } = setup({
    state: stateWith({
      tasks: [
        task({
          usageLimitResume: {
            runId: "run",
            resetsAt: new Date(Date.now() - 30_000).toISOString(),
            autoResume: false,
          },
        }),
      ],
      runs: [failedRun(endedAt)],
    }),
  })

  await Effect.runPromise(recovery.sweep)
  expect(delivered).toEqual([])
  expect(state.tasks[0]!.usageLimitResume?.autoResume).toBe(false)
})

test("a cancelled delegated thread is neither armed nor resumed", async () => {
  const endedAt = new Date(Date.now() - 60_000).toISOString()
  const delegation = {
    parentTaskId: "parent",
    parentRunId: "parent-run",
    requestId: "request",
    fingerprint: "fingerprint",
    cancelledAt: new Date().toISOString(),
  }
  const pending = setup({
    state: stateWith({ tasks: [task({ delegation })], runs: [failedRun(endedAt)] }),
  })
  await Effect.runPromise(pending.recovery.sweep)
  expect(pending.state.tasks[0]!.usageLimitResume).toBeUndefined()

  const armed = setup({
    state: stateWith({
      tasks: [
        task({
          delegation,
          usageLimitResume: { runId: "run", resetsAt: new Date(Date.now() - 30_000).toISOString(), autoResume: true },
        }),
      ],
      runs: [failedRun(endedAt)],
    }),
  })
  await Effect.runPromise(armed.recovery.sweep)
  expect(armed.delivered).toEqual([])
  expect(armed.state.tasks[0]!.usageLimitResume).toBeUndefined()
})

test("a delivery conflict drops the arm instead of promising a resume forever", async () => {
  const endedAt = new Date(Date.now() - 60_000).toISOString()
  const { recovery, state, delivered } = setup({
    state: stateWith({
      tasks: [
        task({
          usageLimitResume: { runId: "run", resetsAt: new Date(Date.now() - 30_000).toISOString(), autoResume: true },
        }),
      ],
      runs: [failedRun(endedAt)],
    }),
    deliver: () => Effect.fail(new Conflict({ message: "the thread moved on" })),
  })

  await Effect.runPromise(recovery.sweep)
  expect(delivered).toEqual([])
  expect(state.tasks[0]!.usageLimitResume).toBeUndefined()
})

test("a failed usage probe is retried on the next sweep", async () => {
  const endedAt = new Date(Date.now() - 60_000).toISOString()
  let calls = 0
  const resetsAt = new Date(Date.now() - 30_000).toISOString()
  const { recovery, state } = setup({
    state: stateWith({ runs: [failedRun(endedAt)] }),
    providerUsage: () => {
      calls += 1
      return calls === 1 ? Effect.fail(new Error("probe timed out")) : Effect.succeed([usage(resetsAt)])
    },
  })

  await Effect.runPromise(recovery.sweep)
  expect(state.tasks[0]!.usageLimitResume).toBeUndefined()
  await Effect.runPromise(recovery.sweep)
  expect(state.tasks[0]!.usageLimitResume?.resetsAt).toBe(resetsAt)
})

test("does not arm another failure, agent prose, or a provider whose limits the box cannot read", async () => {
  const endedAt = new Date(Date.now() - 60_000).toISOString()
  const unrelated = setup({
    state: stateWith({ runs: [failedRun(endedAt)] }),
    items: [{ _tag: "error", id: "error", text: "the model refused" }],
  })
  await Effect.runPromise(unrelated.recovery.sweep)
  expect(unrelated.state.tasks[0]!.usageLimitResume).toBeUndefined()

  const prose = setup({
    state: stateWith({
      runs: [failedRun(endedAt)],
      messages: [
        {
          id: "m",
          taskId: "task",
          role: "agent",
          text: "Your weekly usage limit is documented here.",
          runId: "run",
          createdAt: endedAt,
        },
      ],
    }),
    items: [],
  })
  await Effect.runPromise(prose.recovery.sweep)
  expect(prose.state.tasks[0]!.usageLimitResume).toBeUndefined()

  const gateway = setup({
    state: stateWith({ runs: [{ ...failedRun(endedAt), provider: "openrouter" as const, model: undefined }] }),
  })
  await Effect.runPromise(gateway.recovery.sweep)
  expect(gateway.state.tasks[0]!.usageLimitResume).toBeUndefined()
})
