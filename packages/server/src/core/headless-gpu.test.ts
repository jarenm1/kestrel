import { describe, expect, test } from "bun:test"
import { Deferred, Effect, Exit, Fiber } from "effect"
import { runProcess } from "../sandbox"
import { shell } from "../process"
import { makeGpuCoordinator } from "./gpu-coordinator"

describe("GpuCoordinator", () => {
  test("fails closed when the GPU is not available to the run", async () => {
    const killed: number[] = []
    const coordinator = makeGpuCoordinator({
      available: () => Effect.succeed(false),
      killGroup: (pid) => killed.push(pid),
      groupAlive: () => false,
    })
    let ran = false
    const exit = await Effect.runPromiseExit(
      coordinator.run({ taskId: "task", runId: "run" }, () =>
        Effect.sync(() => {
          ran = true
        }),
      ),
    )
    expect(Exit.isFailure(exit)).toBe(true)
    expect(ran).toBe(false)
    expect(killed).toEqual([])
    expect(JSON.stringify(exit)).toContain("gpu_request")
    expect(coordinator.active("task")).toBe(0)
  })

  test("tracks the workload's process group and kills it before freeing the lease", async () => {
    const killed: number[] = []
    const coordinator = makeGpuCoordinator({
      available: (runId) => Effect.succeed(runId === "run"),
      killGroup: (pid) => killed.push(pid),
      groupAlive: () => false,
    })
    const result = await Effect.runPromise(
      coordinator.run({ taskId: "task", runId: "run" }, (workload) =>
        Effect.sync(() => {
          workload.trackGroup(4242)
          return "rendered"
        }),
      ),
    )
    expect(result).toBe("rendered")
    expect(killed).toEqual([4242])
    // Cleanup ran before the lease was released.
    expect(coordinator.active("task")).toBe(0)
  })

  test("kills the group when the workload fails", async () => {
    const killed: number[] = []
    const coordinator = makeGpuCoordinator({
      available: () => Effect.succeed(true),
      killGroup: (pid) => killed.push(pid),
      groupAlive: () => false,
    })
    const exit = await Effect.runPromiseExit(
      coordinator.run({ taskId: "task", runId: "run" }, (workload) =>
        Effect.gen(function* () {
          workload.trackGroup(99)
          return yield* Effect.fail(new Error("render failed"))
        }),
      ),
    )
    expect(Exit.isFailure(exit)).toBe(true)
    expect(killed).toEqual([99])
    expect(coordinator.active("task")).toBe(0)
  })

  test("cancellation kills the group before the lease is freed", async () => {
    const killed: number[] = []
    const started = await Effect.runPromise(Deferred.make<void>())
    const coordinator = makeGpuCoordinator({
      available: () => Effect.succeed(true),
      killGroup: (pid) => killed.push(pid),
      groupAlive: () => false,
    })
    const fiber = Effect.runFork(
      coordinator.run({ taskId: "task", runId: "run" }, (workload) =>
        Effect.gen(function* () {
          workload.trackGroup(777)
          yield* Deferred.succeed(started, undefined)
          yield* Effect.sleep("30 seconds")
        }),
      ),
    )
    await Effect.runPromise(Deferred.await(started))
    expect(coordinator.active("task")).toBe(1)
    await Effect.runPromise(Fiber.interrupt(fiber))
    expect(killed).toEqual([777])
    expect(coordinator.active("task")).toBe(0)
  })

  test.skipIf(process.platform === "win32")("a timed-out GPU command leaves no process group behind", async () => {
    const coordinator = makeGpuCoordinator({
      available: () => Effect.succeed(true),
      cleanupTimeoutMs: 2_000,
    })
    let pgid: number | undefined
    const result = await Effect.runPromise(
      coordinator.run({ taskId: "task", runId: "run" }, (workload) =>
        runProcess(shell(), ["-c", "sleep 30 & sleep 30"], {
          cwd: process.cwd(),
          env: { PATH: process.env.PATH ?? "" },
          timeoutMs: 100,
          onSpawn: (pid) => {
            pgid = pid
            workload.trackGroup(pid)
          },
        }),
      ),
    )
    expect(result.timedOut).toBe(true)
    expect(pgid).toBeDefined()
    expect(coordinator.active("task")).toBe(0)
    // The coordinator waited for the whole group, backgrounded child included, to disappear before releasing.
    expect(() => process.kill(-(pgid as number), 0)).toThrow()
  })
})
