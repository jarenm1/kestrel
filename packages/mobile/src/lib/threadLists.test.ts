import { describe, expect, test } from "bun:test";
import type { Task } from "@cloudagents/protocol";
import { groupThreads } from "./threadLists";

function task(id: string, status: Task["status"], updatedAt: string, archivedAt?: string): Task {
  return { id, title: id, status, updatedAt, archivedAt, checkouts: [] } as unknown as Task;
}

const at = (minute: number) => `2026-11-05T${String(10 + minute).padStart(2, "0")}:00:00.000Z`;

describe("groupThreads", () => {
  test("a running thread leaves the list for the dock, newest first", () => {
    const entries = [
      { task: task("older", "done", at(1)) },
      { task: task("working", "running", at(3)) },
      { task: task("newer", "done", at(2)) },
    ];
    const { threads, working } = groupThreads(entries);
    expect(threads.map((e) => e.task.id)).toEqual(["newer", "older"]);
    expect(working.map((e) => e.task.id)).toEqual(["working"]);
  });

  test("a finished or failed run returns to the list, and needs-input stays there", () => {
    const entries = [
      { task: task("done", "done", at(1)) },
      { task: task("failed", "failed", at(2)) },
      { task: task("asking", "needs_input", at(3)) },
      { task: task("idle", "idle", at(4)) },
    ];
    const { threads, working } = groupThreads(entries);
    expect(threads.map((e) => e.task.id)).toEqual(["idle", "asking", "failed", "done"]);
    expect(working).toEqual([]);
  });

  test("archived threads are counted and never listed, even when running", () => {
    const entries = [
      { task: task("live", "done", at(1)) },
      { task: task("gone", "done", at(2), at(2)) },
      { task: task("ghost-run", "running", at(3), at(3)) },
    ];
    const { threads, working, archivedCount } = groupThreads(entries);
    expect(threads.map((e) => e.task.id)).toEqual(["live"]);
    expect(working).toEqual([]);
    expect(archivedCount).toBe(2);
  });

  test("the same thread id in two boxes keeps both entries", () => {
    const entries = [
      { task: task("shared", "running", at(1)), box: "a" },
      { task: task("shared", "done", at(2)), box: "b" },
    ];
    const { threads, working } = groupThreads(entries);
    expect(threads.map((e) => e.box)).toEqual(["b"]);
    expect(working.map((e) => e.box)).toEqual(["a"]);
  });

  test("does not reorder the caller's array", () => {
    const entries = [{ task: task("a", "done", at(1)) }, { task: task("b", "done", at(2)) }];
    groupThreads(entries);
    expect(entries.map((e) => e.task.id)).toEqual(["a", "b"]);
  });

  test("an empty workspace has nothing to show", () => {
    expect(groupThreads([])).toEqual({ threads: [], working: [], archivedCount: 0 });
  });
});
