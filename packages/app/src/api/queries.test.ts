import { expect, mock, test } from "bun:test"
import { QueryClient } from "@tanstack/react-query"
import type { DesktopStatus, Task } from "@cloudagents/protocol"
import { applyDesktopStatus, setDesktopStreamActive } from "@/desktop/status"

// The app's config reads the page origin and Vite's env, neither of which exists under bun.
mock.module("@/config", () => ({ SERVER_URL: "https://control.test", WS_URL: "wss://control.test" }))
Object.assign(globalThis, {
  window: globalThis,
  location: { hostname: "app.test", protocol: "https:", port: "", origin: "https://app.test" },
})
// Dynamic on purpose: a static import would load `queries` (and its `@/config` import) before the mock registers.
const { applyDesktopSnapshot, invalidateRunItems, keys, storeTask } = await import("./queries")


const task = (updatedAt: string, status: Task["status"] = "running"): Task => ({
  id: "task-1",
  owner: "alice",
  title: "Thread",
  status,
  createdAt: "2026-11-01T00:00:00.000Z",
  updatedAt,
  checkouts: [],
})

test("a task event older than the cached task is ignored, equal timestamps still land", () => {
  const client = new QueryClient()
  const newest = task("2026-11-01T00:00:05.000Z")
  storeTask(client, newest)
  storeTask(client, task("2026-11-01T00:00:01.000Z", "idle"))
  expect(client.getQueryData<Task>(keys.task("task-1"))).toBe(newest)

  const sameTick = task(newest.updatedAt, "done")
  storeTask(client, sameTick)
  expect(client.getQueryData<Task>(keys.task("task-1"))?.status).toBe("done")
})

test("a task missing from its own entry is still rejected against a newer list copy", () => {
  const client = new QueryClient()
  const newest = task("2026-11-01T00:00:05.000Z")
  // The list was written while the single entry was absent (cache eviction, a fresh QueryClient hydration).
  client.setQueryData(keys.tasks, [newest])
  storeTask(client, task("2026-11-01T00:00:01.000Z", "idle"))

  expect(client.getQueryData<Task>(keys.task("task-1"))).toBeUndefined()
  expect(client.getQueryData<readonly Task[]>(keys.tasks)).toEqual([newest])
})

test("the thread list keeps a newer task when a stale event arrives", () => {
  const client = new QueryClient()
  client.setQueryData(keys.tasks, [])
  const newest = task("2026-11-01T00:00:05.000Z")
  storeTask(client, newest)
  storeTask(client, task("2026-11-01T00:00:01.000Z", "idle"))
  expect(client.getQueryData<readonly Task[]>(keys.tasks)).toEqual([newest])
})

test("run item invalidation is scoped to the runs a reconnect covers", () => {
  const client = new QueryClient()
  client.setQueryData(keys.runItems("run-1"), [{ id: "item-1" }])
  client.setQueryData(keys.runItems("run-2"), [{ id: "item-2" }])

  invalidateRunItems(client, ["run-1"])

  expect(client.getQueryState(keys.runItems("run-1"))?.isInvalidated).toBe(true)
  expect(client.getQueryState(keys.runItems("run-2"))?.isInvalidated).toBe(false)
})

const desktop = (state: DesktopStatus["state"]): DesktopStatus => ({
  taskId: "desktop-task",
  state,
  display: state === "stopped" ? null : ":101",
  width: 1920,
  height: 1080,
  fps: 30,
  quality: "1080p30",
  error: null,
})

test("a desktop snapshot reads the cache after its fetch resolves", async () => {
  const client = new QueryClient()
  const key = keys.desktop("desktop-task")
  const initial = applyDesktopStatus(undefined, desktop("stopped"), "event")
  client.setQueryData(key, initial)
  setDesktopStreamActive("desktop-task", true)
  try {
    const { promise, resolve } = Promise.withResolvers<DesktopStatus>()
    const applying = applyDesktopSnapshot(client, "desktop-task", () => promise)
    // A status frame lands while the REST read is in flight: reading the cache before the await would overwrite it.
    const frame = applyDesktopStatus(initial, desktop("running"), "stream")
    client.setQueryData(key, frame)
    resolve(desktop("failed"))
    const applied = await applying
    expect(applied.source).toBe("stream")
    expect(applied.status.state).toBe("running")
  } finally {
    setDesktopStreamActive("desktop-task", false)
  }
})
