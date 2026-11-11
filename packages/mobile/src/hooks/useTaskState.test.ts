import { expect, mock, test } from "bun:test";
import { QueryClient } from "@tanstack/react-query";
import type { Run, RunClip } from "@cloudagents/protocol";

// The hook's import graph reaches react-native and expo-secure-store (through auth), which bun cannot load. The hook
// itself is not rendered here, so stubs are enough; dynamic imports keep these mocks registered first.
mock.module("react-native", () => ({ AppState: { addEventListener: () => ({ remove: () => {} }) } }));
mock.module("expo-secure-store", () => ({
  getItemAsync: async () => null,
  setItemAsync: async () => {},
  deleteItemAsync: async () => {},
}));
const { boxKeys } = await import("@/api/queries");
const { storeRunUpdate } = await import("./useTaskState");

const clip: RunClip = {
  id: `${"a".repeat(32)}.mp4`,
  caption: "Spawn demo",
  createdAt: "2026-11-06T10:00:00Z",
  durationMs: 1200,
  poster: null,
};

const run = (status: Run["status"]): Run => ({
  id: "run-1",
  taskId: "task-1",
  prompt: "Go",
  status,
  startedAt: "2026-11-06T10:00:00Z",
  endedAt: status === "running" ? null : "2026-11-06T10:01:00Z",
  exitCode: status === "running" ? null : 0,
});

const runsKey = boxKeys("box-1").runs("task-1");

test("a live run update keeps the cached evidence the state store never carries", () => {
  const client = new QueryClient();
  client.setQueryData(runsKey, [{ ...run("running"), evidence: { clips: [clip] } }]);
  storeRunUpdate(client, runsKey, run("succeeded"));
  const [updated] = client.getQueryData<Run[]>(runsKey) ?? [];
  expect(updated?.status).toBe("succeeded");
  expect(updated?.evidence).toEqual({ clips: [clip] });
});

test("a snapshot update that carries evidence replaces the cached clips", () => {
  const client = new QueryClient();
  client.setQueryData(runsKey, [{ ...run("running"), evidence: { clips: [clip] } }]);
  const newer: RunClip = { ...clip, id: `${"b".repeat(32)}.mp4`, caption: "Second" };
  storeRunUpdate(client, runsKey, { ...run("succeeded"), evidence: { clips: [newer] } });
  const [updated] = client.getQueryData<Run[]>(runsKey) ?? [];
  expect(updated?.evidence).toEqual({ clips: [newer] });
});
