import { describe, expect, mock, test } from "bun:test"
import { QueryClient, QueryObserver } from "@tanstack/react-query"
import type { AgentItem, Run } from "@cloudagents/protocol"
import { fetchSnapshot } from "./snapshot"

// The API client reads the page's location when it loads; these tests serve their own fetches.
mock.module("./client", () => ({ api: {}, signedInUser: () => null }))
const { keys, resnapshotTask } = await import("./queries")

const taskId = "task"

const run = (id: string, status: Run["status"]): Run => ({
  id,
  taskId,
  prompt: "hi",
  status,
  startedAt: "2026-01-01T00:00:00.000Z",
  endedAt: status === "running" ? null : "2026-01-01T00:01:00.000Z",
  exitCode: null,
})

const tool = (id: string, status: "running" | "ok"): AgentItem => ({
  _tag: "tool",
  id,
  parentToolId: null,
  name: "Bash",
  input: {},
  status,
  output: null,
})

/** A mounted thread: active runs and item queries reading the server through `fetchSnapshot`, as the screens do. */
function mountThread(server: { runs: Run[]; items: Record<string, AgentItem[]> }) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } })
  const itemFetches: string[] = []
  const observers = [
    new QueryObserver(client, {
      queryKey: keys.runs(taskId),
      queryFn: () => fetchSnapshot(client, keys.runs(taskId), async () => server.runs),
    }),
    ...server.runs.map(
      (r) =>
        new QueryObserver(client, {
          queryKey: keys.runItems(r.id),
          queryFn: () =>
            fetchSnapshot(client, keys.runItems(r.id), async () => {
              itemFetches.push(r.id)
              return server.items[r.id] ?? []
            }),
        }),
    ),
  ]
  const unsubscribe = observers.map((o) => o.subscribe(() => {}))
  const settled = async () => {
    await new Promise((resolve) => setTimeout(resolve, 0))
    while (client.isFetching() > 0) await new Promise((resolve) => setTimeout(resolve, 0))
  }
  return { client, itemFetches, settled, unmount: () => unsubscribe.forEach((u) => u()) }
}

describe("resnapshotTask", () => {
  test("a reconnect corrects a run and tool that finished during the gap", async () => {
    const server = { runs: [run("r1", "running")], items: { r1: [tool("t1", "running")] } }
    const thread = mountThread(server)
    const { client } = thread
    await thread.settled()
    expect(client.getQueryData<Run[]>(keys.runs(taskId))?.[0]?.status).toBe("running")

    // The socket is down while these change on the server, so no event reports them.
    server.runs = [run("r1", "succeeded")]
    server.items.r1 = [tool("t1", "ok"), tool("t2", "ok")]
    resnapshotTask(client, taskId, true)
    await thread.settled()

    expect(client.getQueryData<Run[]>(keys.runs(taskId))?.[0]?.status).toBe("succeeded")
    expect(client.getQueryData<AgentItem[]>(keys.runItems("r1"))).toEqual([tool("t1", "ok"), tool("t2", "ok")])
    thread.unmount()
  })

  test("a thread's first open refetches only running runs' items", async () => {
    const thread = mountThread({ runs: [run("done", "succeeded"), run("live", "running")], items: {} })
    await thread.settled()
    thread.itemFetches.length = 0

    resnapshotTask(thread.client, taskId, false)
    await thread.settled()

    expect(thread.itemFetches).toEqual(["live"])
    thread.unmount()
  })

  test("a reconnect refetches every run's items: a finished run's may date from before the gap", async () => {
    const thread = mountThread({ runs: [run("done", "succeeded"), run("live", "running")], items: {} })
    await thread.settled()
    thread.itemFetches.length = 0

    resnapshotTask(thread.client, taskId, true)
    await thread.settled()

    expect(thread.itemFetches.sort()).toEqual(["done", "live"])
    thread.unmount()
  })
})
