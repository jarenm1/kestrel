import { expect, test } from "bun:test"
import type { Run, Task } from "@cloudagents/protocol"
import { isTaskAwaitingUser, isTaskWorking } from "./taskStatus"

const task = (status: Task["status"]): Task => ({
  id: "task-1",
  owner: "alice",
  title: "Thread",
  status,
  createdAt: "2026-11-01T00:00:00.000Z",
  updatedAt: "2026-11-01T00:00:00.000Z",
  checkouts: [],
})

const run = (status: Run["status"]): Run => ({
  id: "run-1",
  taskId: "task-1",
  prompt: "do the thing",
  status,
  startedAt: "2026-11-01T00:00:00.000Z",
  endedAt: status === "running" ? null : "2026-11-01T00:01:00.000Z",
  exitCode: status === "running" ? null : 0,
})

test("a pending question is awaiting the user, not working, even while its run is live", () => {
  expect(isTaskAwaitingUser(task("needs_input"))).toBe(true)
  expect(isTaskAwaitingUser(task("running"))).toBe(false)
  expect(isTaskWorking(task("needs_input"))).toBe(false)
  expect(isTaskWorking(task("needs_input"), [run("running")])).toBe(false)
})

test("running and a live cached run are the working state", () => {
  expect(isTaskWorking(task("running"))).toBe(true)
  expect(isTaskWorking(task("idle"), [run("running")])).toBe(true)
  expect(isTaskWorking(task("done"), [run("succeeded")])).toBe(false)
})

test("a settled thread with a stale running run is still treated as working until the snapshot corrects it", () => {
  expect(isTaskWorking(task("done"), [run("running")])).toBe(true)
})
