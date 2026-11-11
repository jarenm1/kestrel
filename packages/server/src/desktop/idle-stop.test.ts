import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { idleStopLoopEnabled, stopIdleDesktops, type IdleStopDeps } from "./idle-stop"

const makeDeps = (
  responses: ReadonlyArray<ReadonlyArray<string>>,
  stop: (taskId: string) => Effect.Effect<void, unknown> = () => Effect.void,
) => {
  let call = 0
  const warnings: string[] = []
  const deps: IdleStopDeps = {
    idleTaskIds: () => Effect.sync(() => responses[Math.min(call++, responses.length - 1)] ?? []),
    stop,
    activeCount: () => Effect.succeed(responses[0]?.length ?? 0),
    runs: () => Effect.succeed(0),
    lastActivityAt: () => Effect.succeed(1_000),
    now: () => 5_000,
    logInfo: () => Effect.void,
    logWarning: (message) => Effect.sync(() => void warnings.push(message)),
  }
  return { deps, warnings, calls: () => call }
}

describe("idleStopLoopEnabled", () => {
  test("the loop runs when either window is enabled", () => {
    expect(idleStopLoopEnabled(0, 0)).toBe(false)
    expect(idleStopLoopEnabled(1, 0)).toBe(true)
    expect(idleStopLoopEnabled(0, 1)).toBe(true)
    expect(idleStopLoopEnabled(1, 1)).toBe(true)
  })
})

describe("stopIdleDesktops", () => {
  test("re-checks before each stop and skips a desktop that gained a viewer", async () => {
    const stopped: string[] = []
    const { deps } = makeDeps(
      [["a", "b"], ["a"], ["a"]],
      (taskId) => Effect.sync(() => void stopped.push(taskId)),
    )
    const result = await Effect.runPromise(stopIdleDesktops(deps, 60_000, 120_000))
    expect(stopped).toEqual(["a"])
    expect(result).toEqual(["a"])
  })

  test("stops every desktop that is still idle at its own re-check", async () => {
    const stopped: string[] = []
    const { deps } = makeDeps(
      [["a", "b"], ["a", "b"], ["a", "b"]],
      (taskId) => Effect.sync(() => void stopped.push(taskId)),
    )
    const result = await Effect.runPromise(stopIdleDesktops(deps, 60_000, 120_000))
    expect(stopped).toEqual(["a", "b"])
    expect(result).toEqual(["a", "b"])
  })

  test("does nothing when the first check finds no idle desktop", async () => {
    const stopped: string[] = []
    const { deps, calls } = makeDeps([[]], (taskId) => Effect.sync(() => void stopped.push(taskId)))
    const result = await Effect.runPromise(stopIdleDesktops(deps, 60_000, 120_000))
    expect(result).toEqual([])
    expect(stopped).toEqual([])
    expect(calls()).toBe(1)
  })

  test("logs a failed stop and does not count it as stopped", async () => {
    const { deps, warnings } = makeDeps([["a"], ["a"]], () => Effect.fail(new Error("boom")))
    const result = await Effect.runPromise(stopIdleDesktops(deps, 60_000, 120_000))
    expect(result).toEqual([])
    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toContain("not stopped")
  })
})
