import { describe, expect, test } from "bun:test"
import { QueryClient } from "@tanstack/react-query"
import type { Run, Task } from "@cloudagents/protocol"
import { fetchSnapshot, fetchTaskSnapshot } from "./snapshot"

const key = ["tasks", "task", "runs"]

const run = (id: string, status: Run["status"]): Run => ({
  id,
  taskId: "task",
  prompt: "hi",
  status,
  startedAt: "2026-01-01T00:00:00.000Z",
  endedAt: status === "running" ? null : "2026-01-01T00:01:00.000Z",
  exitCode: null,
})

const statuses = (runs: readonly Run[]) => runs.map((r) => `${r.id}:${r.status}`)

describe("fetchSnapshot", () => {
  test("the snapshot replaces an entry cached while no events arrived", async () => {
    // The thread was left mid-run: its run stayed "running" in the cache and the run's end went unheard.
    const client = new QueryClient()
    client.setQueryData(key, [run("r1", "running")])
    const merged = await fetchSnapshot(client, key, async () => [run("r1", "succeeded")])
    expect(statuses(merged)).toEqual(["r1:succeeded"])
  })

  test("an event written while the snapshot is in flight wins over it", async () => {
    const client = new QueryClient()
    client.setQueryData(key, [run("r1", "running")])
    const { promise, resolve } = Promise.withResolvers<Run[]>()
    const merging = fetchSnapshot(client, key, () => promise)
    client.setQueryData(key, [run("r1", "succeeded")])
    resolve([run("r1", "running")])
    expect(statuses(await merging)).toEqual(["r1:succeeded"])
  })

  test("entries the snapshot lacks stay, after the snapshot's", async () => {
    const client = new QueryClient()
    client.setQueryData(key, [run("r2", "running")])
    const merged = await fetchSnapshot(client, key, async () => [run("r1", "succeeded")])
    expect(statuses(merged)).toEqual(["r1:succeeded", "r2:running"])
  })
})

describe("fetchTaskSnapshot", () => {
  const task = (usedTokens: number): Task => ({
    id: "task",
    owner: "owner",
    title: "thread",
    status: "running",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    checkouts: [],
    context: { model: "claude-opus-5-5", usedTokens, windowTokens: 1_000_000 },
  })
  const taskKey = ["tasks", "task"]
  const used = (client: QueryClient) => client.getQueryData<Task>(taskKey)?.context?.usedTokens

  test("a task live events wrote while the snapshot was in flight wins over it", async () => {
    // The snapshot was read before the run reported 350; the event for 350 landed while it travelled back.
    const client = new QueryClient()
    const { promise, resolve } = Promise.withResolvers<Task>()
    const merging = fetchTaskSnapshot(client, taskKey, () => promise)
    client.setQueryData(taskKey, task(350))
    resolve(task(300))
    expect((await merging).context?.usedTokens).toBe(350)
    expect(used(client)).toBe(350)
  })

  test("the snapshot replaces a task cached before the fetch started", async () => {
    // A thread left mid-run: the cached task is what its last event said, and the snapshot is newer.
    const client = new QueryClient()
    client.setQueryData(taskKey, task(300))
    const merged = await fetchTaskSnapshot(client, taskKey, async () => task(350))
    expect(merged.context?.usedTokens).toBe(350)
  })
})
