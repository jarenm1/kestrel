import { describe, expect, test } from "bun:test"
import type { Task } from "@cloudagents/protocol"
import { observeTask, type SeenTasks } from "./turnSound"

const task = (status: Task["status"], minute: number, archivedAt?: string): Task => ({
  id: "task",
  owner: "owner",
  title: "Thread",
  status,
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: `2026-01-01T00:0${minute}:00.000Z`,
  checkouts: [],
  ...(archivedAt === undefined ? {} : { archivedAt }),
})

describe("observeTask", () => {
  test("a running thread that finishes, fails or asks for input is the user's turn", () => {
    for (const status of ["done", "failed", "needs_input"] as const) {
      const seen: SeenTasks = new Map()
      observeTask(seen, task("running", 1))
      expect(observeTask(seen, task(status, 2))).toBe(true)
    }
  })

  test("a first sighting, a cancel and an archived thread are not", () => {
    const seen: SeenTasks = new Map()
    expect(observeTask(seen, task("done", 1))).toBe(false)
    observeTask(seen, task("running", 2))
    expect(observeTask(seen, task("idle", 2))).toBe(false)
    observeTask(seen, task("running", 3))
    expect(observeTask(seen, task("done", 4, "2026-01-01T00:04:00.000Z"))).toBe(false)
  })

  test("a snapshot showing a run started while disconnected arms the next event", () => {
    const seen: SeenTasks = new Map()
    observeTask(seen, task("done", 1))
    expect(observeTask(seen, task("running", 2))).toBe(false)
    expect(observeTask(seen, task("done", 3))).toBe(true)
  })

  test("a snapshot showing a run ended while disconnected is the user's turn, once", () => {
    const seen: SeenTasks = new Map()
    observeTask(seen, task("running", 1))
    expect(observeTask(seen, task("done", 2))).toBe(true)
    expect(observeTask(seen, task("done", 2))).toBe(false)
  })

  test("a snapshot older than an event is dropped", () => {
    const seen: SeenTasks = new Map()
    observeTask(seen, task("done", 1))
    observeTask(seen, task("running", 2))
    expect(observeTask(seen, task("done", 1))).toBe(false)
    expect(observeTask(seen, task("done", 3))).toBe(true)
  })

  test("events queued behind a newer snapshot neither rearm nor replay", () => {
    const seen: SeenTasks = new Map()
    observeTask(seen, task("running", 2))
    expect(observeTask(seen, task("done", 3))).toBe(true)
    expect(observeTask(seen, task("running", 2))).toBe(false)
    expect(observeTask(seen, task("done", 3))).toBe(false)
  })
})
