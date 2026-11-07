import { describe, expect, test } from "bun:test"
import type { Task } from "@cloudagents/protocol"
import { groupSubThreads } from "@/lib/subThreads"

const task = (id: string, extra: Partial<Task> = {}) =>
  ({ id, owner: "dev", title: id, status: "done", createdAt: "", updatedAt: "", checkouts: [], ...extra }) as Task

const ids = (tasks: readonly Task[]) => tasks.map((t) => t.id)

describe("groupSubThreads", () => {
  test("nests spawned and delegated threads under their parent", () => {
    const parent = task("parent")
    const spawned = task("spawned", { spawnedByTaskId: "parent" })
    const delegated = task("delegated", { delegation: { parentTaskId: "parent" } as Task["delegation"] })
    const { roots, children } = groupSubThreads([parent, spawned, delegated])
    expect(ids(roots)).toEqual(["parent"])
    expect(ids(children.get("parent") ?? [])).toEqual(["spawned", "delegated"])
  })

  test("keeps a thread at the top level when its parent is archived or missing", () => {
    const orphan = task("orphan", { spawnedByTaskId: "gone" })
    const { roots, children } = groupSubThreads([orphan])
    expect(ids(roots)).toEqual(["orphan"])
    expect(children.size).toBe(0)
  })

  test("keeps a thread that names itself as parent at the top level", () => {
    const { roots } = groupSubThreads([task("self", { spawnedByTaskId: "self" })])
    expect(ids(roots)).toEqual(["self"])
  })

  test("keeps every thread in a parent cycle at the top level", () => {
    const a = task("a", { spawnedByTaskId: "b" })
    const b = task("b", { spawnedByTaskId: "a" })
    const { roots, children } = groupSubThreads([a, b])
    expect(ids(roots)).toEqual(["a", "b"])
    expect(children.size).toBe(0)
  })

  test("nests a thread under a parent that sits in a cycle elsewhere", () => {
    const a = task("a", { spawnedByTaskId: "b" })
    const b = task("b", { spawnedByTaskId: "a" })
    const c = task("c", { spawnedByTaskId: "a" })
    const { roots, children } = groupSubThreads([a, b, c])
    expect(ids(roots)).toEqual(["a", "b"])
    expect(ids(children.get("a") ?? [])).toEqual(["c"])
  })

  test("nests a grandchild under its own parent, not under the top-level thread", () => {
    const root = task("root")
    const child = task("child", { spawnedByTaskId: "root" })
    const grandchild = task("grandchild", { spawnedByTaskId: "child" })
    const { roots, children } = groupSubThreads([root, child, grandchild])
    expect(ids(roots)).toEqual(["root"])
    expect(ids(children.get("root") ?? [])).toEqual(["child"])
    expect(ids(children.get("child") ?? [])).toEqual(["grandchild"])
  })
})
