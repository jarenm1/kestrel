import { describe, expect, test } from "bun:test"
import { QueryClient } from "@tanstack/react-query"
import type { Run } from "@cloudagents/protocol"
import { fetchSnapshot } from "./snapshot"

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
