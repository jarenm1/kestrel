import { expect, mock, test } from "bun:test"
import { QueryClient } from "@tanstack/react-query"
import type { Run, RunClip } from "@cloudagents/protocol"

// The app's config reads the page origin and Vite's env, neither of which exists under bun.
mock.module("@/config", () => ({ SERVER_URL: "https://control.test", WS_URL: "wss://control.test" }))
Object.assign(globalThis, {
  window: globalThis,
  location: { hostname: "app.test", protocol: "https:", port: "", origin: "https://app.test" },
})

const { keys } = await import("@/api/queries")
const { storeRunUpdate } = await import("./useTaskState")

const clip: RunClip = {
  id: `${"a".repeat(32)}.mp4`,
  caption: "Spawn demo",
  createdAt: "2026-11-06T10:00:00Z",
  durationMs: 1200,
  poster: null,
}

const run = (status: Run["status"]): Run => ({
  id: "run-1",
  taskId: "task-1",
  prompt: "Go",
  status,
  startedAt: "2026-11-06T10:00:00Z",
  endedAt: status === "running" ? null : "2026-11-06T10:01:00Z",
  exitCode: status === "running" ? null : 0,
})

test("a live run update keeps the cached evidence the state store never carries", () => {
  const client = new QueryClient()
  client.setQueryData(keys.runs("task-1"), [{ ...run("running"), evidence: { clips: [clip] } }])
  storeRunUpdate(client, "task-1", run("succeeded"))
  const [updated] = client.getQueryData<Run[]>(keys.runs("task-1")) ?? []
  expect(updated?.status).toBe("succeeded")
  expect(updated?.evidence).toEqual({ clips: [clip] })
})

test("a snapshot update that carries evidence replaces the cached clips", () => {
  const client = new QueryClient()
  client.setQueryData(keys.runs("task-1"), [{ ...run("running"), evidence: { clips: [clip] } }])
  const newer: RunClip = { ...clip, id: `${"b".repeat(32)}.mp4`, caption: "Second" }
  storeRunUpdate(client, "task-1", { ...run("succeeded"), evidence: { clips: [newer] } })
  const [updated] = client.getQueryData<Run[]>(keys.runs("task-1")) ?? []
  expect(updated?.evidence).toEqual({ clips: [newer] })
})

test("a run not in the cache stays without evidence", () => {
  const client = new QueryClient()
  storeRunUpdate(client, "task-1", run("running"))
  const [stored] = client.getQueryData<Run[]>(keys.runs("task-1")) ?? []
  expect(stored?.id).toBe("run-1")
  expect(stored?.evidence).toBeUndefined()
})
