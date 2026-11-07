import { expect, test } from "bun:test"
import { Effect, Either } from "effect"
import { Conflict, InternalError, type AgentItem, type ProviderUsage, type Run, type Task, type ThreadSettings } from "@cloudagents/protocol"
import type { StoreShape, StoreState } from "./state"
import { makeRunRecovery, AUTO_RETRY_LIMIT, autoRetryDelay } from "./run-recovery"

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

const failedRun = (endedAt: string): Run => ({
  id: "run",
  taskId: "task",
  prompt: "Do the work",
  status: "failed",
  startedAt: new Date(Date.parse(endedAt) - 60_000).toISOString(),
  endedAt,
  exitCode: 1,
  provider: "anthropic",
  model: "claude-opus-5-5",
  effort: null,
})

const stateWith = (overrides: Partial<StoreState> = {}): StoreState => ({
  tasks: [task()],
  messages: [],
  runs: [],
  pendingAsks: [],
  uploads: [],
  runSessions: [],
  settledRuns: [],
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
  retry?: () => Effect.Effect<void, unknown>
  /** Wraps the in-memory store, e.g. to make a write fail. */
  wrapStore?: (store: StoreShape) => StoreShape
}) => {
  const memory = memoryStore(input.state)
  const { state } = memory
  const store = input.wrapStore?.(memory.store) ?? memory.store
  const delivered: string[] = []
  const retried: { readonly deliveryId: string; readonly attempt: number }[] = []
  const published: Task[] = []
  const recovery = makeRunRecovery({
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
    retry:
      input.retry ??
      ((_task, _run, deliveryId, attempt) =>
        Effect.sync(() => void retried.push({ deliveryId, attempt }))),
  })
  return { recovery, state, delivered, retried, published }
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

test("a run the user settled is not re-armed by a recovery that never saw it, as after a restart", async () => {
  const endedAt = new Date(Date.now() - 60_000).toISOString()
  const later = usage(new Date(Date.now() + 3_600_000).toISOString())
  // Each `setup` is a fresh recovery with no memory of looked-at runs, as a restarted box has; only the store persists.
  const settled = setup({ state: stateWith({ runs: [failedRun(endedAt)], settledRuns: ["run"] }), usage: later })
  expect(settled.recovery.deciding(settled.state, settled.state.tasks[0]!, settled.state.runs[0]!)).toBe(false)
  await Effect.runPromise(settled.recovery.sweep)
  expect(settled.state.tasks[0]!.usageLimitResume).toBeUndefined()

  // The same failure without the record is armed again: that is what the record prevents.
  const unsettled = setup({ state: stateWith({ runs: [failedRun(endedAt)] }), usage: later })
  await Effect.runPromise(unsettled.recovery.sweep)
  expect(unsettled.state.tasks[0]!.usageLimitResume?.runId).toBe("run")
})

test("settled runs are forgotten once they stop being their thread's latest", async () => {
  const endedAt = new Date(Date.now() - 60_000).toISOString()
  const later = { ...failedRun(endedAt), id: "later", status: "succeeded" as const }
  const { recovery, state } = setup({ state: stateWith({ runs: [failedRun(endedAt), later], settledRuns: ["run"] }) })
  await Effect.runPromise(recovery.sweep)
  expect(state.settledRuns).toEqual([])
})

test("a failure stays undecided until its arm is written, so a delegated child's result is held meanwhile", async () => {
  const endedAt = new Date(Date.now() - 60_000).toISOString()
  const resetsAt = new Date(Date.now() + 3_600_000).toISOString()
  let writes = 0
  const { recovery, state } = setup({
    state: stateWith({ runs: [failedRun(endedAt)] }),
    usage: usage(resetsAt),
    wrapStore: (store) => ({
      ...store,
      update: (f) => (++writes === 1 ? Effect.fail(new InternalError({ message: "disk full" })) : store.update(f)),
    }),
  })
  const decidingNow = () => recovery.deciding(state, state.tasks[0]!, state.runs[0]!)

  expect(decidingNow()).toBe(true)
  await Effect.runPromise(recovery.sweep)
  expect(state.tasks[0]!.usageLimitResume).toBeUndefined()
  expect(decidingNow()).toBe(true)
  await Effect.runPromise(recovery.sweep)
  expect(state.tasks[0]!.usageLimitResume?.resetsAt).toBe(resetsAt)
  expect(decidingNow()).toBe(false)
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

const failedWith = (overrides: Partial<Run> = {}): Run => ({
  ...failedRun(new Date(Date.now() - 30_000).toISOString()),
  ...overrides,
})

const transportError: ReadonlyArray<AgentItem> = [
  { _tag: "error", id: "error", text: "the provider returned 502 Bad Gateway" },
]

test("retries a failure that is not a usage limit after a backoff, then clears the arm", async () => {
  const { recovery, state, retried, published } = setup({
    state: stateWith({ runs: [failedWith()] }),
    items: transportError,
  })

  await Effect.runPromise(recovery.sweep)
  const arm = state.tasks[0]!.autoRetry!
  expect(arm).toMatchObject({ runId: "run", attempt: 1 })
  expect(Date.parse(arm.nextAt)).toBeGreaterThan(Date.now())
  expect(retried).toEqual([])
  expect(published.at(-1)?.autoRetry?.runId).toBe("run")

  await Effect.runPromise(recovery.sweep)
  expect(retried).toEqual([])

  state.tasks[0]!.autoRetry = { ...arm, nextAt: new Date(Date.now() - 1).toISOString() }
  await Effect.runPromise(recovery.sweep)
  expect(retried).toEqual([{ deliveryId: "auto-retry:task:run:1", attempt: 1 }])
  expect(state.tasks[0]!.autoRetry).toBeUndefined()
})

test("a failed retry waits longer before the next one", async () => {
  const { recovery, state } = setup({
    state: stateWith({ runs: [failedWith({ autoRetryAttempt: 1 })] }),
    items: transportError,
  })

  await Effect.runPromise(recovery.sweep)
  const arm = state.tasks[0]!.autoRetry!
  expect(arm.attempt).toBe(2)
  expect(Math.abs(Date.parse(arm.nextAt) - Date.now() - autoRetryDelay(2))).toBeLessThan(1_000)
})

test("the chain stops after the retry limit and after the last retry fails", async () => {
  const last = setup({
    state: stateWith({ runs: [failedWith({ autoRetryAttempt: AUTO_RETRY_LIMIT })] }),
    items: transportError,
  })
  await Effect.runPromise(last.recovery.sweep)
  expect(last.state.tasks[0]!.autoRetry).toBeUndefined()
  expect(last.retried).toEqual([])
})

test("auto-retry delays double from 5 s and stop at 60 s", () => {
  expect([1, 2, 3, 4, 5, 6].map(autoRetryDelay)).toEqual([5_000, 10_000, 20_000, 40_000, 60_000, 60_000])
})

test("never retries a usage-limit failure, even when the provider reports no reset", async () => {
  const { recovery, state, retried } = setup({
    state: stateWith({ runs: [failedWith()] }),
    items: [{ _tag: "error", id: "error", text: "You have reached your weekly usage limit." }],
    providerUsage: () => Effect.succeed([{ provider: "claude-cli", status: "ok", plan: "Pro", windows: [] }]),
  })

  await Effect.runPromise(recovery.sweep)
  expect(state.tasks[0]!.usageLimitResume).toBeUndefined()
  expect(state.tasks[0]!.autoRetry).toBeUndefined()
  expect(retried).toEqual([])
})

test("a run on a provider without its explicit model is not retried", async () => {
  const { recovery, state } = setup({
    state: stateWith({ runs: [failedWith({ provider: "openrouter" as const, model: undefined })] }),
    items: transportError,
  })
  await Effect.runPromise(recovery.sweep)
  expect(state.tasks[0]!.autoRetry).toBeUndefined()
})

test("a user reply or a newer run drops the pending retry", async () => {
  const { recovery, state, retried } = setup({
    state: stateWith({
      runs: [
        failedWith(),
        {
          ...failedWith({ id: "newer" }),
          status: "running" as const,
          endedAt: null,
          autoRetryAttempt: undefined,
          startedAt: new Date().toISOString(),
        },
      ],
    }),
    items: transportError,
  })
  state.tasks[0]!.autoRetry = { runId: "run", attempt: 1, nextAt: new Date(Date.now() - 1).toISOString() }

  await Effect.runPromise(recovery.sweep)
  expect(state.tasks[0]!.autoRetry).toBeUndefined()
  expect(retried).toEqual([])
})

test("a delivery conflict drops the pending retry", async () => {
  const { recovery, state } = setup({
    state: stateWith({ runs: [failedWith()] }),
    items: transportError,
    retry: () => Effect.fail(new Conflict({ message: "the thread moved on" })),
  })
  state.tasks[0]!.autoRetry = { runId: "run", attempt: 1, nextAt: new Date(Date.now() - 1).toISOString() }

  await Effect.runPromise(recovery.sweep)
  expect(state.tasks[0]!.autoRetry).toBeUndefined()
})

test("an archived thread or a cancelled delegation is not retried", async () => {
  const archived = setup({
    state: stateWith({
      tasks: [task({ archivedAt: new Date().toISOString() })],
      runs: [failedWith()],
    }),
    items: transportError,
  })
  await Effect.runPromise(archived.recovery.sweep)
  expect(archived.state.tasks[0]!.autoRetry).toBeUndefined()

  const cancelled = setup({
    state: stateWith({
      tasks: [
        task({
          delegation: {
            parentTaskId: "parent",
            parentRunId: "parent-run",
            requestId: "request",
            fingerprint: "fingerprint",
            cancelledAt: new Date().toISOString(),
          },
        }),
      ],
      runs: [failedWith()],
    }),
    items: transportError,
  })
  await Effect.runPromise(cancelled.recovery.sweep)
  expect(cancelled.state.tasks[0]!.autoRetry).toBeUndefined()
})

test("a retry that cannot start consumes its attempt instead of firing again on the next tick", async () => {
  let calls = 0
  const { recovery, state } = setup({
    state: stateWith({ runs: [failedWith()] }),
    items: transportError,
    retry: () => {
      calls += 1
      return Effect.fail(new Error("the model is no longer in the catalog"))
    },
  })
  state.tasks[0]!.autoRetry = { runId: "run", attempt: 1, nextAt: new Date(Date.now() - 1).toISOString() }

  await Effect.runPromise(recovery.sweep)
  expect(calls).toBe(1)
  const arm = state.tasks[0]!.autoRetry!
  expect(arm.attempt).toBe(2)
  expect(Date.parse(arm.nextAt)).toBeGreaterThan(Date.now())

  // The next tick is still inside the new backoff, so it does not try again.
  await Effect.runPromise(recovery.sweep)
  expect(calls).toBe(1)
})

test("a retry that dies consumes the last attempt and stops", async () => {
  const { recovery, state } = setup({
    state: stateWith({ runs: [failedWith({ autoRetryAttempt: AUTO_RETRY_LIMIT })] }),
    items: transportError,
    retry: () => Effect.die(new Error("modelInfo defect")),
  })
  state.tasks[0]!.autoRetry = { runId: "run", attempt: AUTO_RETRY_LIMIT, nextAt: new Date(Date.now() - 1).toISOString() }

  await Effect.runPromise(recovery.sweep)
  expect(state.tasks[0]!.autoRetry).toBeUndefined()
})

test("a delegated child's failure is not retried", async () => {
  const { recovery, state } = setup({
    state: stateWith({
      tasks: [
        task({
          delegation: {
            parentTaskId: "parent",
            parentRunId: "parent-run",
            requestId: "request",
            fingerprint: "fingerprint",
            runId: "run",
          },
        }),
      ],
      runs: [failedWith()],
    }),
    items: transportError,
  })

  await Effect.runPromise(recovery.sweep)
  expect(state.tasks[0]!.autoRetry).toBeUndefined()
})
