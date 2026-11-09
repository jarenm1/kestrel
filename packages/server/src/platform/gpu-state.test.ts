import { describe, expect, test } from "bun:test"
import { Effect, TestClock, TestContext } from "effect"
import { GpuReconciler, type GpuSnapshot } from "./gpu-state"

const fake = (attachingDeadlineMs = 1_000, now: () => number = () => 1_000) => {
  const calls: string[] = []
  const warnings: string[] = []
  const snapshots: GpuSnapshot[] = []
  const reconciler = new GpuReconciler({
    attachHardware: Effect.sync(() => {
      calls.push("attach")
    }),
    releaseHardware: Effect.sync(() => {
      calls.push("release")
    }),
    warn: (message) => warnings.push(message),
    onSnapshot: (snapshot) => snapshots.push(snapshot),
    now,
    attachingDeadlineMs,
  })
  return { calls, warnings, snapshots, reconciler }
}

describe("GpuReconciler", () => {
  test("a reconnect replays the stored attached state, even when the renderer already matches", async () => {
    const { calls, reconciler, snapshots } = fake()
    try {
      await Effect.runPromise(reconciler.observe("attached"))
      expect(reconciler.snapshot()).toEqual({ state: "attached", renderer: "gl", attaching: false, attachingSince: null })

      await Effect.runPromise(reconciler.replay())
      expect(calls).toEqual(["attach", "attach"])
      expect(snapshots.at(-1)?.renderer).toBe("gl")
    } finally {
      reconciler.close()
    }
  })

  test("attached then detaching then none falls back to software once", async () => {
    const { calls, reconciler } = fake()
    try {
      await Effect.runPromise(reconciler.observe("attached"))
      await Effect.runPromise(reconciler.observe("detaching"))
      await Effect.runPromise(reconciler.observe("none"))
      expect(calls).toEqual(["attach", "release"])
      expect(reconciler.snapshot()).toEqual({ state: "none", renderer: "pixman", attaching: false, attachingSince: null })
    } finally {
      reconciler.close()
    }
  })

  test("attaching keeps the last renderer and expires to software after its deadline", async () => {
    const { calls, warnings, reconciler } = fake(20)
    try {
      await Effect.runPromise(
        Effect.gen(function* () {
          yield* reconciler.observe("attached")
          yield* reconciler.observe("attaching")
          expect(reconciler.snapshot().attaching).toBe(true)
          expect(reconciler.snapshot().renderer).toBe("gl")
          expect(calls).toEqual(["attach"])

          // TestClock drives the deadline; no wall-clock wait.
          yield* TestClock.adjust("20 millis")
          yield* Effect.yieldNow()
        }).pipe(Effect.provide(TestContext.TestContext)),
      )
      expect(calls).toEqual(["attach", "release"])
      expect(warnings.some((message) => message.includes("still attaching"))).toBe(true)
      expect(reconciler.snapshot()).toEqual({
        state: "attaching",
        renderer: "pixman",
        attaching: false,
        attachingSince: 1_000,
      })
    } finally {
      reconciler.close()
    }
  })

  test("a reconnect keeps the original attaching deadline instead of extending it", async () => {
    let clock = 1_000
    const { calls, reconciler } = fake(120_000, () => clock)
    try {
      await Effect.runPromise(
        Effect.gen(function* () {
          yield* reconciler.observe("attaching")
          yield* TestClock.adjust("100 seconds")
          clock += 100_000
          // The guest reports its snapshot again on every box connection: replay plus a fresh `attaching`.
          yield* reconciler.replay()
          yield* reconciler.observe("attaching")
          expect(reconciler.snapshot().attachingSince).toBe(1_000)
          expect(reconciler.snapshot().attaching).toBe(true)

          yield* TestClock.adjust("19 seconds")
          clock += 19_000
          yield* Effect.yieldNow()
          expect(reconciler.snapshot().attaching).toBe(true)
          expect(calls).toEqual([])

          yield* TestClock.adjust("1 second")
          clock += 1_000
          yield* Effect.yieldNow()
          expect(reconciler.snapshot()).toEqual({
            state: "attaching",
            renderer: "pixman",
            attaching: false,
            attachingSince: 1_000,
          })
        }).pipe(Effect.provide(TestContext.TestContext)),
      )
      expect(calls).toEqual(["release"])
    } finally {
      reconciler.close()
    }
  })
})
