import { describe, expect, test } from "bun:test";
import type { Task } from "@cloudagents/protocol";
import { groupThreads, hasSubThreadAwaitingUser, matchesThreadQuery, threadKey } from "./threadLists";

type Entry = { task: Task; box?: string };

function task(id: string, status: Task["status"], updatedAt: string, extra: Record<string, unknown> = {}): Task {
  return { id, title: id, status, updatedAt, checkouts: [], ...extra } as unknown as Task;
}

const at = (minute: number) => `2026-11-05T${String(10 + minute).padStart(2, "0")}:00:00.000Z`;
const scope = (entry: Entry) => entry.box ?? "";
const ids = (entries: Entry[]) => entries.map((e) => e.task.id);

describe("groupThreads", () => {
  test("a running thread leaves the list for the dock, newest first", () => {
    const entries = [
      { task: task("older", "done", at(1)) },
      { task: task("working", "running", at(3)) },
      { task: task("newer", "done", at(2)) },
    ];
    const { threads, working } = groupThreads(entries, scope);
    expect(ids(threads)).toEqual(["newer", "older"]);
    expect(ids(working)).toEqual(["working"]);
  });

  test("needs-input threads get their own group; finished and failed runs return to the list", () => {
    const entries = [
      { task: task("done", "done", at(1)) },
      { task: task("failed", "failed", at(2)) },
      { task: task("asking", "needs_input", at(3)) },
      { task: task("idle", "idle", at(4)) },
    ];
    const { awaiting, threads, working } = groupThreads(entries, scope);
    expect(ids(awaiting)).toEqual(["asking"]);
    expect(ids(threads)).toEqual(["idle", "failed", "done"]);
    expect(working).toEqual([]);
  });

  test("archived threads are never listed, even when running", () => {
    const entries = [
      { task: task("live", "done", at(1)) },
      { task: task("gone", "done", at(2), { archivedAt: at(2) }) },
      { task: task("ghost-run", "running", at(3), { archivedAt: at(3) }) },
    ];
    const { awaiting, threads, working } = groupThreads(entries, scope);
    expect(ids(threads)).toEqual(["live"]);
    expect(awaiting).toEqual([]);
    expect(working).toEqual([]);
  });

  test("the same thread id in two boxes keeps both entries", () => {
    const entries = [
      { task: task("shared", "running", at(1)), box: "a" },
      { task: task("shared", "done", at(2)), box: "b" },
    ];
    const { threads, working } = groupThreads(entries, scope);
    expect(threads.map((e) => e.box)).toEqual(["b"]);
    expect(working.map((e) => e.box)).toEqual(["a"]);
  });

  test("a sub-thread sits under its parent, even while it runs, and stays with the parent's group", () => {
    const entries = [
      { task: task("parent", "running", at(1)) },
      { task: task("spawned", "running", at(2), { spawnedByTaskId: "parent" }) },
      { task: task("delegated", "done", at(3), { delegation: { parentTaskId: "parent" } }) },
    ];
    const { threads, working, children } = groupThreads(entries, scope);
    expect(threads).toEqual([]);
    expect(ids(working)).toEqual(["parent"]);
    expect(ids(children.get(threadKey("", "parent")) ?? [])).toEqual(["delegated", "spawned"]);
  });

  test("a sub-thread waiting on the user brings its settled or working parent into the needs-input group", () => {
    const entries = [
      { task: task("settled", "done", at(1)) },
      { task: task("asking", "needs_input", at(2), { spawnedByTaskId: "settled" }) },
      { task: task("busy", "running", at(3)) },
      { task: task("middle", "done", at(4), { spawnedByTaskId: "busy" }) },
      { task: task("deep-ask", "needs_input", at(5), { spawnedByTaskId: "middle" }) },
      { task: task("quiet", "done", at(6)) },
      { task: task("quiet-child", "failed", at(7), { spawnedByTaskId: "quiet" }) },
    ];
    const { awaiting, threads, working, children } = groupThreads(entries, scope);
    expect(ids(awaiting)).toEqual(["busy", "settled"]);
    expect(ids(threads)).toEqual(["quiet"]);
    expect(working).toEqual([]);
    expect(hasSubThreadAwaitingUser(threads[0], children, scope)).toBe(false);
  });

  test("a sub-thread only nests under a parent on its own box", () => {
    const entries = [
      { task: task("parent", "done", at(1)), box: "a" },
      { task: task("child", "done", at(2), { spawnedByTaskId: "parent" }), box: "b" },
    ];
    const { threads, children } = groupThreads(entries, scope);
    expect(threads.map((e) => `${e.box}:${e.task.id}`)).toEqual(["b:child", "a:parent"]);
    expect(children.size).toBe(0);
  });

  test("a sub-thread whose parent is archived, missing or in a cycle stays at the top level", () => {
    const entries = [
      { task: task("archived-parent", "done", at(1), { archivedAt: at(1) }) },
      { task: task("orphan", "done", at(2), { spawnedByTaskId: "archived-parent" }) },
      { task: task("lost", "done", at(3), { spawnedByTaskId: "missing" }) },
      { task: task("x", "done", at(4), { spawnedByTaskId: "y" }) },
      { task: task("y", "done", at(5), { spawnedByTaskId: "x" }) },
    ];
    const { threads, children } = groupThreads(entries, scope);
    expect(ids(threads)).toEqual(["y", "x", "lost", "orphan"]);
    expect(children.size).toBe(0);
  });

  test("does not reorder the caller's array", () => {
    const entries = [{ task: task("a", "done", at(1)) }, { task: task("b", "done", at(2)) }];
    groupThreads(entries, scope);
    expect(ids(entries)).toEqual(["a", "b"]);
  });
});

describe("matchesThreadQuery", () => {
  test("matches the title, a checkout's repository or branch, or a sub-thread", () => {
    const entries = [
      { task: task("Fix login", "done", at(1), { checkouts: [{ repo: "acme/web", branch: "kestrel/fix" }] }) },
      { task: task("Child about billing", "done", at(2), { spawnedByTaskId: "Fix login" }) },
    ];
    const { threads, children } = groupThreads(entries, scope);
    const [parent] = threads;
    for (const query of ["login", "acme/web", "kestrel/fix", "billing"]) {
      expect(matchesThreadQuery(parent, query, children, scope)).toBe(true);
    }
    expect(matchesThreadQuery(parent, "nothing", children, scope)).toBe(false);
  });
});
