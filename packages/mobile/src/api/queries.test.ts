import { afterEach, expect, test } from "bun:test";
import { QueryClient } from "@tanstack/react-query";
import {
  connectedModelProviders,
  mergeSnapshot,
  type Connection,
  type Run,
  type Task,
  type TextGenerationSettings,
} from "@cloudagents/protocol";
import { createApiClient } from "./client";
import {
  boxKeys,
  createQueries,
  fetchTaskSnapshot,
  invalidateRunItems,
  queryClient,
  storeTask,
} from "./queries";
import { trackSave, trackSaveQueue } from "@/lib/pendingSaves";
import { createSaveQueue } from "@/lib/saveQueue";

const task = (title: string): Task => ({
  id: "same-id", owner: "owner", title, status: "idle", createdAt: "2026-01-01T00:00:00Z",
  updatedAt: "2026-01-01T00:00:00Z", checkouts: [],
});

afterEach(() => queryClient.clear());

const run = (id: string, status: Run["status"]): Run => ({
  id, taskId: "same-id", prompt: "hi", status, startedAt: "2026-01-01T00:00:00Z",
  endedAt: status === "running" ? null : "2026-01-01T00:01:00Z", exitCode: null,
});

test("a reconnect snapshot corrects a turn that ended while events were disconnected", async () => {
  const api = {
    ...createApiClient("https://control.example", "session", null),
    listRuns: async () => [run("old", "succeeded"), run("new", "running")],
  };
  const query = createQueries(api).runs("same-id");
  queryClient.setQueryData(query.queryKey, [run("old", "running")]);
  const refreshed = await queryClient.fetchQuery(query);
  expect(refreshed.map(({ id, status }) => [id, status])).toEqual([
    ["old", "succeeded"], ["new", "running"],
  ]);
});

test("a live turn ending during a reconnect fetch wins over its older snapshot", async () => {
  const response = Promise.withResolvers<Run[]>();
  const started = Promise.withResolvers<void>();
  const api = {
    ...createApiClient("https://control.example", "session", null),
    listRuns: () => { started.resolve(); return response.promise; },
  };
  const query = createQueries(api).runs("same-id");
  queryClient.setQueryData(query.queryKey, [run("turn", "running")]);
  const fetching = queryClient.fetchQuery(query);
  await started.promise;
  queryClient.setQueryData(query.queryKey, [run("turn", "succeeded"), run("new", "running")]);
  response.resolve([run("turn", "running")]);
  expect((await fetching).map(({ id, status }) => [id, status])).toEqual([
    ["turn", "succeeded"], ["new", "running"],
  ]);
});

test("the mobile list merge is the protocol's mergeSnapshot, so the clients cannot diverge", async () => {
  // The web client and the phone client must agree on which entries survive a snapshot. This pins the phone path to
  // the shared helper rather than a second copy of the algorithm.
  const response = Promise.withResolvers<Run[]>();
  const started = Promise.withResolvers<void>();
  const api = {
    ...createApiClient("https://control.example", "session", null),
    listRuns: () => { started.resolve(); return response.promise; },
  };
  const query = createQueries(api).runs("same-id");
  const before = [run("ended", "running"), run("missed", "running")];
  queryClient.setQueryData(query.queryKey, before);
  const fetching = queryClient.fetchQuery(query);
  await started.promise;
  const during = [run("ended", "succeeded"), run("new", "running")];
  queryClient.setQueryData(query.queryKey, during);
  const snapshot = [run("ended", "running"), run("snapshot-only", "succeeded")];
  response.resolve(snapshot);
  const merged = await fetching;
  expect(merged).toEqual(mergeSnapshot(snapshot, during, new Set(before)));
});

test("a stale snapshot cannot resurrect an entry deleted while it was in flight", async () => {
  const response = Promise.withResolvers<Run[]>();
  const started = Promise.withResolvers<void>();
  const api = {
    ...createApiClient("https://control.example", "session", null),
    listRuns: () => {
      started.resolve();
      return response.promise;
    },
  };
  const query = createQueries(api).runs("same-id");
  queryClient.setQueryData(query.queryKey, [run("gone", "running"), run("kept", "succeeded")]);
  const fetching = queryClient.fetchQuery(query);
  await started.promise;
  // A delete landed while the snapshot was travelling. The response still carries the id: the server read it first.
  queryClient.setQueryData(query.queryKey, [run("kept", "succeeded")]);
  response.resolve([run("gone", "running"), run("kept", "succeeded"), run("new", "running")]);
  expect((await fetching).map(({ id }) => id)).toEqual(["kept", "new"]);
});

test("the thread list poll drops a thread deleted elsewhere but keeps one an event wrote during the fetch", async () => {
  const response = Promise.withResolvers<Task[]>();
  const started = Promise.withResolvers<void>();
  const api = {
    ...createApiClient("https://control.example", "session", null),
    listTasks: () => {
      started.resolve();
      return response.promise;
    },
  };
  const query = createQueries(api).tasks();
  const named = (id: string): Task => ({ ...task(id), id });
  const kept = named("kept");
  queryClient.setQueryData(query.queryKey, [named("deleted-elsewhere"), kept]);
  const fetching = queryClient.fetchQuery(query);
  await started.promise;
  // A thread created while the poll was travelling: the server read its list before the thread existed.
  queryClient.setQueryData(query.queryKey, [named("deleted-elsewhere"), kept, named("created")]);
  response.resolve([kept]);
  expect((await fetching).map(({ id }) => id)).toEqual(["kept", "created"]);
});

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
    [a.textGenerationSettings, b.textGenerationSettings],
    [a.threadSettings, b.threadSettings],
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

test("CLI availability follows the selected box and stays isolated in the connections cache", async () => {
  const first = Bun.serve({
    hostname: "127.0.0.1", port: 0,
    fetch(request) {
      const url = new URL(request.url);
      if (url.pathname === "/api/cli-auth") {
        const providers = url.searchParams.get("providers")?.split(",") ?? [];
        return Response.json(providers
          .filter((provider) => provider === "opencode-go")
          .map((provider) => ({ provider, loggedIn: true, account: null })));
      }
      // Capabilities no longer decide whether a provider is offered; every provider needs a signed-in connection.
      if (url.pathname === "/api/capabilities") return Response.json({
        version: 1, platform: "linux", sandbox: "basic", desktop: "unavailable", harnesses: [],
      });
      return new Response(null, { status: 404 });
    },
  });
  const second = Bun.serve({
    hostname: "127.0.0.1", port: 0,
    fetch(request) {
      const url = new URL(request.url);
      if (url.pathname === "/api/cli-auth") {
        const providers = url.searchParams.get("providers")?.split(",") ?? [];
        return Response.json(providers
          .filter((provider) => provider === "opencode")
          .map((provider) => ({ provider, loggedIn: true, account: null })));
      }
      // Capabilities no longer decide whether a provider is offered; every provider needs a signed-in connection.
      if (url.pathname === "/api/capabilities") return Response.json({
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
    const firstQueries = createQueries(createApiClient(control.url.origin, "session", { id: "first", url: first.url.origin }));
    const secondQueries = createQueries(createApiClient(control.url.origin, "session", { id: "second", url: second.url.origin }));
    const a = firstQueries.connections();
    const b = secondQueries.connections();
    const [aRows, bRows] = await Promise.all([queryClient.fetchQuery(a), queryClient.fetchQuery(b)]);
    const offered = (rows: readonly Connection[]) => connectedModelProviders(rows).map((provider) => provider.id);
    expect(offered(aRows)).toEqual(["opencode-go"]);
    expect(offered(bRows)).toEqual(["opencode"]);
    expect(offered(queryClient.getQueryData<readonly Connection[]>(a.queryKey) ?? [])).toEqual(["opencode-go"]);
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

test("a snapshot older than the cached task is refused", async () => {
  const key = ["older-task"];
  const current = { ...taskUsing(350), updatedAt: "2026-01-01T00:00:05.000Z" };
  queryClient.setQueryData(key, current);
  const older = { ...taskUsing(300), updatedAt: "2026-01-01T00:00:01.000Z" };
  expect(await fetchTaskSnapshot(key, async () => older)).toBe(current);
});

const taskAt = (updatedAt: string, status: Task["status"] = "idle"): Task => ({
  ...task("thread"),
  status,
  updatedAt,
});

test("a task event older than the cached copy is ignored, equal timestamps still land", () => {
  const client = new QueryClient();
  const scoped = boxKeys("ordering-box");
  const newest = taskAt("2026-01-01T00:00:05.000Z");
  storeTask(client, newest, "ordering-box");
  storeTask(client, taskAt("2026-01-01T00:00:01.000Z"), "ordering-box");
  expect(client.getQueryData<Task>(scoped.task("same-id"))).toBe(newest);

  const sameTick = taskAt(newest.updatedAt, "done");
  storeTask(client, sameTick, "ordering-box");
  expect(client.getQueryData<Task>(scoped.task("same-id"))?.status).toBe("done");
});

test("a task missing from its own entry is still rejected against a newer list copy", () => {
  const client = new QueryClient();
  const scoped = boxKeys("ordering-box");
  const newest = taskAt("2026-01-01T00:00:05.000Z");
  // The list was written while the single entry was absent (cache eviction, a fresh QueryClient hydration).
  client.setQueryData(scoped.tasks, [newest]);
  storeTask(client, taskAt("2026-01-01T00:00:01.000Z"), "ordering-box");

  expect(client.getQueryData<Task>(scoped.task("same-id"))).toBeUndefined();
  expect(client.getQueryData<readonly Task[]>(scoped.tasks)).toEqual([newest]);
});

test("the thread list keeps a newer task when a stale event arrives", () => {
  const client = new QueryClient();
  const scoped = boxKeys("ordering-box");
  client.setQueryData(scoped.tasks, []);
  const newest = taskAt("2026-01-01T00:00:05.000Z");
  storeTask(client, newest, "ordering-box");
  storeTask(client, taskAt("2026-01-01T00:00:01.000Z"), "ordering-box");
  expect(client.getQueryData<readonly Task[]>(scoped.tasks)).toEqual([newest]);
});

test("run item invalidation is scoped to the runs a reconnect covers", () => {
  const client = new QueryClient();
  const scoped = boxKeys("runs-box");
  client.setQueryData(scoped.runItems("run-1"), [{ id: "item-1" }]);
  client.setQueryData(scoped.runItems("run-2"), [{ id: "item-2" }]);

  invalidateRunItems(client, ["run-1"], "runs-box");

  expect(client.getQueryState(scoped.runItems("run-1"))?.isInvalidated).toBe(true);
  expect(client.getQueryState(scoped.runItems("run-2"))?.isInvalidated).toBe(false);
});

test("settings reads wait for a closed form's save so a reopened form cannot hydrate pre-save values", async () => {
  const calls: string[] = [];
  const saved: TextGenerationSettings = {
    enabled: true,
    model: "claude-opus-5-5",
    effort: "high",
    threadTitleInstructions: "saved",
    responseStreamingMode: "turn",
  };
  const { promise, resolve } = Promise.withResolvers<TextGenerationSettings>();
  const queue = createSaveQueue<TextGenerationSettings>(() => promise);
  queue.push(saved);
  trackSaveQueue("waiting-box", queue);
  const api = {
    boxScope: "waiting-box",
    textGenerationSettings: async () => {
      calls.push("text");
      return saved;
    },
    threadSettings: async () => {
      calls.push("threads");
      return { autoResumeAfterUsageLimits: true };
    },
  } as unknown as Parameters<typeof createQueries>[0];
  const queries = createQueries(api);
  const text = queryClient.fetchQuery(queries.textGenerationSettings());
  const threads = queryClient.fetchQuery(queries.threadSettings());
  await new Promise((resolveTick) => setTimeout(resolveTick, 0));
  expect(calls).toEqual([]);

  resolve(saved);
  await Promise.all([text, threads]);
  expect(calls).toEqual(["text", "threads"]);
  await queue.idle();
});

test("thread settings reads wait for a usage-limit mutation write", async () => {
  const calls: string[] = [];
  const { promise, resolve } = Promise.withResolvers<void>();
  trackSave("usage-box", promise);
  const api = {
    boxScope: "usage-box",
    threadSettings: async () => {
      calls.push("threads");
      return { autoResumeAfterUsageLimits: true };
    },
  } as unknown as Parameters<typeof createQueries>[0];
  const threads = queryClient.fetchQuery(createQueries(api).threadSettings());
  await new Promise((resolveTick) => setTimeout(resolveTick, 0));
  expect(calls).toEqual([]);
  resolve();
  await threads;
  expect(calls).toEqual(["threads"]);
});
