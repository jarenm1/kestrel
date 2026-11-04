import { afterEach, expect, test } from "bun:test";
import { QueryClient } from "@tanstack/react-query";
import { connectedModelProviders, type Connection, type Task } from "@cloudagents/protocol";
import { createApiClient } from "./client";
import { boxKeys, createQueries, fetchTaskSnapshot, queryClient, storeTask } from "./queries";

const task = (title: string): Task => ({
  id: "same-id", owner: "owner", title, status: "idle", createdAt: "2026-01-01T00:00:00Z",
  updatedAt: "2026-01-01T00:00:00Z", checkouts: [],
});

afterEach(() => queryClient.clear());

test("box clients isolate caches even for identical task and run IDs", () => {
  const first = createApiClient("https://control.example", "session", { id: "first", url: "https://first.example" });
  const second = createApiClient("https://control.example", "session", { id: "second", url: "https://second.example" });
  const a = boxKeys(first.boxScope);
  const b = boxKeys(second.boxScope);
  const cache = new QueryClient();
  cache.setQueryData(a.tasks, [task("first")]);
  cache.setQueryData(b.tasks, [task("second")]);
  storeTask(cache, task("first updated"), first.boxScope);
  expect(cache.getQueryData<Task[]>(a.tasks)?.[0]?.title).toBe("first updated");
  expect(cache.getQueryData<Task[]>(b.tasks)?.[0]?.title).toBe("second");
  expect(cache.getQueryData<Task>(b.task("same-id"))).toBeUndefined();
  for (const [left, right] of [
    [a.box, b.box], [a.usage, b.usage], [a.task("same-id"), b.task("same-id")],
    [a.messages("same-id"), b.messages("same-id")], [a.runs("same-id"), b.runs("same-id")],
    [a.runItems("run"), b.runItems("run")], [a.diff("same-id"), b.diff("same-id")],
    [a.desktop("same-id"), b.desktop("same-id")],
    [a.commands("same-id", undefined, undefined, undefined), b.commands("same-id", undefined, undefined, undefined)],
  ]) expect(left).not.toEqual(right);
});

test("relay and changed direct routes do not share a box scope", () => {
  const client = (box: { id: string; url: string } | null) => createApiClient("https://control.example", "session", box);
  const relay = client(null);
  const first = client({ id: "box", url: "https://one.example" });
  const moved = client({ id: "box", url: "https://two.example" });
  expect(new Set([relay.boxScope, first.boxScope, moved.boxScope]).size).toBe(3);
  expect([...createQueries(first).tasks().queryKey]).toEqual([...boxKeys(first.boxScope).tasks]);
});

test("independent HTTP snapshots from two boxes stay in their own query entries", async () => {
  const seen: string[] = [];
  const box = (name: string) => Bun.serve({
    hostname: "127.0.0.1", port: 0,
    fetch(request) {
      seen.push(`${name}:${new URL(request.url).pathname}:${request.headers.get("authorization")}`);
      return Response.json([task(name)]);
    },
  });
  const first = box("first");
  const second = box("second");
  const control = Bun.serve({
    hostname: "127.0.0.1", port: 0,
    fetch(request) {
      const id = new URL(request.url).pathname.split("/")[3];
      const target = id === "first" ? first : second;
      return Response.json({ token: `token-${id}`, url: target.url.origin, expiresAt: "2099-01-01T00:00:00Z" });
    },
  });
  try {
    const a = createApiClient(control.url.origin, "session", { id: "first", url: first.url.origin });
    const b = createApiClient(control.url.origin, "session", { id: "second", url: second.url.origin });
    const [aTasks, bTasks] = await Promise.all([
      queryClient.fetchQuery(createQueries(a).tasks()),
      queryClient.fetchQuery(createQueries(b).tasks()),
    ]);
    expect(aTasks[0]?.title).toBe("first");
    expect(bTasks[0]?.title).toBe("second");
    expect(seen.sort()).toEqual(["first:/api/tasks:Bearer token-first", "second:/api/tasks:Bearer token-second"]);
    storeTask(queryClient, task("changed on first"), a.boxScope);
    expect(queryClient.getQueryData<readonly Task[]>(boxKeys(b.boxScope).tasks)?.[0]?.title).toBe("second");
  } finally {
    control.stop(true);
    first.stop(true);
    second.stop(true);
  }
});

test("Go availability follows the selected box and stays isolated in the connections cache", async () => {
  const first = Bun.serve({
    hostname: "127.0.0.1", port: 0,
    fetch(request) {
      const url = new URL(request.url);
      const path = url.pathname;
      if (path === "/api/cli-auth") return Response.json(url.searchParams.get("providers")?.split(",").includes("opencode-go")
        ? [{ provider: "opencode-go", loggedIn: true, account: null }] : []);
      if (path === "/api/capabilities") return Response.json({
        version: 1, platform: "linux", sandbox: "basic", desktop: "unavailable", harnesses: ["opencode", "opencode-go"],
      });
      return new Response(null, { status: 404 });
    },
  });
  const second = Bun.serve({
    hostname: "127.0.0.1", port: 0,
    fetch(request) {
      const url = new URL(request.url);
      const path = url.pathname;
      if (path === "/api/cli-auth") return Response.json(url.searchParams.get("providers")?.split(",").includes("opencode-go")
        ? [{ provider: "opencode-go", loggedIn: false, account: null }] : []);
      if (path === "/api/capabilities") return Response.json({
        version: 1, platform: "linux", sandbox: "basic", desktop: "unavailable", harnesses: [],
      });
      return new Response(null, { status: 404 });
    },
  });
  const control = Bun.serve({
    hostname: "127.0.0.1", port: 0,
    fetch(request) {
      const path = new URL(request.url).pathname;
      if (path === "/api/connections") return Response.json([
        { provider: "opencode-go", label: "Go", kind: "cli", connected: false, available: false, account: null },
        { provider: "opencode", label: "OpenCode", kind: "cli", connected: false, available: false, account: null },
      ]);
      const id = path.split("/")[3];
      return Response.json({ token: `token-${id}`, url: (id === "first" ? first : second).url.origin, expiresAt: "2099-01-01T00:00:00Z" });
    },
  });
  try {
    const a = createQueries(createApiClient(control.url.origin, "session", { id: "first", url: first.url.origin })).connections();
    const b = createQueries(createApiClient(control.url.origin, "session", { id: "second", url: second.url.origin })).connections();
    const offered = (rows: readonly Connection[]) => connectedModelProviders(rows).map((provider) => provider.id);
    expect(offered(await queryClient.fetchQuery(a))).toEqual(["opencode", "opencode-go"]);
    expect(offered(await queryClient.fetchQuery(b))).toEqual([]);
    expect(offered(queryClient.getQueryData<readonly Connection[]>(a.queryKey) ?? [])).toEqual(["opencode", "opencode-go"]);
  } finally {
    control.stop(true);
    first.stop(true);
    second.stop(true);
  }
});

const taskUsing = (usedTokens: number): Task => ({
  ...task("thread"), status: "running",
  context: { model: "claude-opus-5-5", usedTokens, windowTokens: 1_000_000 },
});

test("a task live events wrote while the snapshot was in flight wins over it", async () => {
  // The snapshot was read before the run reported 350; the event for 350 landed while it travelled back.
  const key = ["test-task"];
  const { promise, resolve } = Promise.withResolvers<Task>();
  const merging = fetchTaskSnapshot(key, () => promise);
  queryClient.setQueryData(key, taskUsing(350));
  resolve(taskUsing(300));
  expect((await merging).context?.usedTokens).toBe(350);
});

test("the snapshot replaces a task cached before the fetch started", async () => {
  const key = ["test-task"];
  queryClient.setQueryData(key, taskUsing(300));
  expect((await fetchTaskSnapshot(key, async () => taskUsing(350))).context?.usedTokens).toBe(350);
});
